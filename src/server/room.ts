import { randomUUID } from 'node:crypto';
import { MAINDECK } from '../engine/deck.js';
import { applyDraftAction } from '../draft/draft.js';
import { buildDraft, draftedCardPool, mergeEntries } from '../draft/session.js';
import { redactDraft, type DraftView } from '../draft/redact.js';
import type { DraftAction, DraftState } from '../draft/types.js';
import type { DeckEntry } from '../engine/state.js';
import { Game, type Intent } from '../engine/game.js';
import { MatchTracker, newMatchState, type MatchState } from '../engine/match.js';
import { frontFace } from '../engine/oracle.js';
import { redact, redactEvents, type PlayerView } from '../engine/redact.js';
import type { ChoiceResponse, GameEvent, PlayerId } from '../engine/types.js';
import type { LoggedAction, MatchStore, RoomMeta } from './store.js';

/**
 * Room logic shared by every online transport.
 *
 * Every request rebuilds the game by replaying the action log. That is only
 * affordable because the engine is deterministic and a whole game is a few hundred
 * actions — replaying one takes single-digit milliseconds.
 */

export interface Snapshot {
  seat: PlayerId;
  /** Which of draft, deckbuilding or playing this room is doing. */
  phase: 'draft' | 'build' | 'game';
  /** Present while drafting. */
  draft?: DraftView;
  /** Present while deckbuilding: what this seat may put in a deck. */
  pool?: { base: DeckEntry[]; drafted: DeckEntry[]; lands: DeckEntry[] };
  /** Who has locked in a deck for the game about to start. */
  deckReady?: PlayerId[];
  version: number;
  rev: number;
  view: PlayerView;
  match: MatchState;
  events: GameEvent[];
  players: { seat: PlayerId; name: string }[];
  ready: boolean;
}

export function normaliseCode(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 12);
}

export interface RoomOptions {
  /** Drafted rooms open with a draft; classic rooms go straight to the mirror. */
  format?: 'classic' | 'draft';
  /** 1, 3 or 5. */
  bestOf?: number;
}

export function freshMeta(code: string, opts: RoomOptions = {}): RoomMeta {
  const startingPlayer: PlayerId = Math.random() < 0.5 ? 'p1' : 'p2';
  const format = opts.format === 'draft' ? 'draft' : 'classic';
  const bestOf = [1, 3, 5].includes(opts.bestOf ?? 3) ? (opts.bestOf ?? 3) : 3;
  return {
    code,
    seed: Math.floor(Math.random() * 2 ** 31),
    startingPlayer,
    seats: {},
    match: newMatchState(startingPlayer, bestOf),
    createdAt: Date.now(),
    rev: 1,
    format,
    phase: format === 'draft' ? 'draft' : 'game',
    draftSeed: Math.floor(Math.random() * 2 ** 31),
    drafted: {},
    decks: {},
    ready: [],
  };
}

/** The phase a room is in, defaulting rooms made before drafting existed. */
export function phaseOf(meta: RoomMeta): 'draft' | 'build' | 'game' {
  return meta.phase ?? 'game';
}

/** The decks a game should be dealt from: what players built, else the mirror. */
export function decksFor(meta: RoomMeta): {
  deck?: DeckEntry[];
  decks?: Record<PlayerId, DeckEntry[]>;
} {
  const p1 = meta.decks?.p1;
  const p2 = meta.decks?.p2;
  if (p1 && p2) return { decks: { p1, p2 } };
  return { deck: MAINDECK };
}

/** Replays a log into a game. Actions that no longer apply are skipped, not fatal. */
export function buildGame(meta: RoomMeta, log: LoggedAction[]): Game {
  const game = Game.create({
    gameId: `${meta.code}-g${meta.match.gameNumber}-${meta.seed}`,
    seed: meta.seed,
    ...decksFor(meta),
    startingPlayer: meta.startingPlayer,
  });
  game.advance();
  for (const a of log) {
    try {
      if (a.k === 'intent') game.submitIntent(a.seat, a.intent);
      else if (a.k === 'choice') game.submitChoice(a.seat, a.choiceId, a.response);
      // Draft and deck entries belong to earlier phases and are not game actions.
    } catch {
      // A logged action that will not replay means the log and the engine have
      // diverged. Skipping keeps the rest of the game playable rather than
      // bricking the room.
    }
  }
  return game;
}

/** Replays the draft half of a log. */
export function draftFor(meta: RoomMeta, log: LoggedAction[]): DraftState {
  return buildDraft(
    `${meta.code}-draft`,
    meta.draftSeed ?? meta.seed,
    log.flatMap((a) => (a.k === 'draft' ? [{ seat: a.seat, action: a.action }] : [])),
  );
}

export const MIN_DECK_SIZE = 60;

/** A card's printed name, or the raw id when the pool has never heard of it. */
function nameOfCard(oracleId: string): string {
  try {
    return frontFace(oracleId as never).name;
  } catch {
    return `"${oracleId}"`;
  }
}

/**
 * Whether a submitted decklist is one this player could actually own.
 *
 * The client's builder enforces the same rules, but the server cannot take its
 * word for it: a decklist arrives over the wire and decides what the engine
 * deals, so a hand-rolled request must not be able to conjure four Timetwisters.
 */
export function deckProblem(deck: DeckEntry[], draftedOracleIds: string[]): string | null {
  if (!Array.isArray(deck)) return 'Malformed decklist';

  // Ownership first: "you do not have that card" says more than "too small",
  // and a list can easily be both.
  const { all } = draftedCardPool(draftedOracleIds);
  const owned = new Map(mergeEntries(all).map((e) => [e.oracleId, e.count]));

  // Add the list up first. Checking entry by entry let the same card be sent
  // twice — four Omnisciences plus four more, each entry legal on its own — so
  // a hand-rolled request could put eight of anything in a deck.
  const wanted = new Map<string, number>();
  for (const e of deck) {
    if (typeof e?.oracleId !== 'string') return 'Malformed decklist';
    if (!Number.isInteger(e.count) || e.count < 0) return 'Malformed decklist';
    wanted.set(e.oracleId, (wanted.get(e.oracleId) ?? 0) + e.count);
  }
  for (const [oracleId, count] of wanted) {
    const have = owned.get(oracleId) ?? 0;
    if (count > have) {
      const name = nameOfCard(oracleId);
      return have === 0
        ? `${name} is not in your card pool`
        : `You only have ${have} ${have === 1 ? 'copy' : 'copies'} of ${name}, not ${count}`;
    }
  }

  const size = deck.reduce((n, e) => n + e.count, 0);
  if (size < MIN_DECK_SIZE) return `A deck needs at least ${MIN_DECK_SIZE} cards`;
  return null;
}

export function trackerFor(meta: RoomMeta, game: Game): MatchTracker {
  const tracker = new MatchTracker(meta.startingPlayer);
  tracker.state = meta.match;
  tracker.noteResult(game);
  return tracker;
}

export interface JoinResult {
  meta: RoomMeta;
  seat: PlayerId;
  token: string;
  created: boolean;
}

export async function join(
  store: MatchStore,
  code: string,
  opts: { token?: string; name?: string } & RoomOptions,
): Promise<JoinResult | { error: string }> {
  let meta = await store.getMeta(code);
  let created = false;
  if (!meta) {
    // Whoever opens the room picks the format and the length of the series;
    // the second player joins into whatever is already set up.
    meta = freshMeta(code, opts);
    created = true;
  }

  // Returning to a seat you already hold.
  const existing = (['p1', 'p2'] as PlayerId[]).find(
    (s) => opts.token && meta!.seats[s]?.token === opts.token,
  );
  if (existing) {
    if (created) await store.setMeta(code, meta);
    return { meta, seat: existing, token: meta.seats[existing]!.token, created };
  }

  const free = (['p1', 'p2'] as PlayerId[]).find((s) => !meta!.seats[s]);
  if (!free) return { error: 'That room already has two players' };

  const token = randomUUID();
  meta.seats[free] = { token, name: (opts.name ?? 'player').slice(0, 24) };
  meta.rev++;
  await store.setMeta(code, meta);
  return { meta, seat: free, token, created };
}

export async function snapshot(
  store: MatchStore,
  code: string,
  seat: PlayerId,
  opts: { events?: GameEvent[] } = {},
): Promise<Snapshot | null> {
  const meta = await store.getMeta(code);
  if (!meta) return null;
  const log = await store.getLog(code);
  const phase = phaseOf(meta);

  const players = (['p1', 'p2'] as PlayerId[])
    .filter((s) => meta.seats[s])
    .map((s) => ({ seat: s, name: meta.seats[s]!.name }));
  const lobby = { players, ready: players.length === 2 };

  // Drafting and deckbuilding have no game to redact yet, but the client still
  // wants one shape back, so both carry an empty game view alongside their own.
  if (phase !== 'game') {
    const game = buildGame(meta, []);
    const base = {
      seat,
      phase,
      version: log.length,
      rev: meta.rev,
      view: redact(game.state, seat),
      match: meta.match,
      events: [],
      ...lobby,
    };
    if (phase === 'draft') {
      return { ...base, draft: redactDraft(draftFor(meta, log), seat) };
    }
    const { base: mainDeck, drafted, lands } = draftedCardPool(meta.drafted?.[seat] ?? []);
    return {
      ...base,
      pool: { base: mainDeck, drafted, lands },
      deckReady: meta.ready ?? [],
    };
  }

  const game = buildGame(meta, log);
  const tracker = trackerFor(meta, game);

  // A game that just finished has to be recorded before anyone sees the result.
  if (JSON.stringify(tracker.state) !== JSON.stringify(meta.match)) {
    meta.match = tracker.state;
    meta.rev++;
    await store.setMeta(code, meta);
  }

  return {
    seat,
    phase,
    version: log.length,
    rev: meta.rev,
    view: redact(game.state, seat),
    match: meta.match,
    events: opts.events ? redactEvents(game.state, seat, opts.events) : [],
    ...lobby,
  };
}

export type RoomAction =
  | { t: 'intent'; intent: Intent }
  | { t: 'choice'; choiceId: string; response: ChoiceResponse }
  | { t: 'cancel' }
  | { t: 'chooseFirst'; onPlay: PlayerId }
  /** Draft: a bid (zero withdraws) or the cards kept from a won pile. */
  | { t: 'draft'; action: DraftAction }
  /** Deckbuilding: this seat's finished list. */
  | { t: 'submitDeck'; deck: DeckEntry[] };

export async function applyAction(
  store: MatchStore,
  code: string,
  seat: PlayerId,
  action: RoomAction,
): Promise<{ ok: true; events: GameEvent[] } | { ok: false; error: string }> {
  const meta = await store.getMeta(code);
  if (!meta) return { ok: false, error: 'Unknown room' };
  const log = await store.getLog(code);
  const phase = phaseOf(meta);

  // ---- draft ---------------------------------------------------------------
  if (action.t === 'draft') {
    if (phase !== 'draft') return { ok: false, error: 'The draft is over' };
    const draft = draftFor(meta, log);
    try {
      applyDraftAction(draft, seat, action.action);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    await store.appendAction(code, { k: 'draft', seat, action: action.action });

    if (draft.phase === 'done') {
      // Freeze what each player bought before the log is cleared for the game,
      // and move the room on to deckbuilding.
      meta.drafted = {
        p1: draft.won.p1.map((iid) => draft.cards[iid].oracleId),
        p2: draft.won.p2.map((iid) => draft.cards[iid].oracleId),
      };
      meta.phase = 'build';
      meta.ready = [];
      meta.rev++;
      await store.setMeta(code, meta);
      await store.clearLog(code);
    }
    return { ok: true, events: [] };
  }

  // ---- deckbuilding --------------------------------------------------------
  if (action.t === 'submitDeck') {
    if (phase !== 'build') return { ok: false, error: 'Not deckbuilding right now' };
    const problem = deckProblem(action.deck, meta.drafted?.[seat] ?? []);
    if (problem) return { ok: false, error: problem };
    meta.decks = { ...meta.decks, [seat]: action.deck };
    meta.ready = [...new Set([...(meta.ready ?? []), seat])];
    // Both locked in: deal the game.
    if (meta.ready.length === 2) {
      meta.phase = 'game';
      meta.seed = Math.floor(Math.random() * 2 ** 31);
    }
    meta.rev++;
    await store.setMeta(code, meta);
    return { ok: true, events: [] };
  }

  if (phase !== 'game') return { ok: false, error: 'The game has not started yet' };

  const game = buildGame(meta, log);
  game.flushEvents();

  switch (action.t) {
    case 'intent':
      try {
        game.submitIntent(seat, action.intent);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      await store.appendAction(code, { k: 'intent', seat, intent: action.intent });
      return { ok: true, events: game.flushEvents() };

    case 'choice':
      try {
        game.submitChoice(seat, action.choiceId, action.response);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      await store.appendAction(code, {
        k: 'choice',
        seat,
        choiceId: action.choiceId,
        response: action.response,
      });
      return { ok: true, events: game.flushEvents() };

    case 'cancel': {
      /*
       * Only a half-finished action can be backed out of.
       *
       * This used to rewind the tail of the log whatever was in it, which made
       * Escape a take-back: play a land, both players see it, press Escape, and
       * the next rebuild has no land on the battlefield. The local engine has
       * never allowed that — it keeps a rollback snapshot that is retaken the
       * moment you have priority again, so a completed action has nothing to
       * rewind to. The same rule spelled out for a log: rewind only while the
       * engine is waiting on a choice of yours, which is exactly the window in
       * which the action is not finished yet.
       */
      const pending = game.state.pendingChoice;
      const mine =
        pending !== null &&
        pending.kind !== 'simultaneousSecret' &&
        pending.kind !== 'mulligan' &&
        pending.player === seat;
      if (!mine) return { ok: true, events: [] };
      for (let i = log.length - 1; i >= 0; i--) {
        const a = log[i];
        if (a.seat !== seat) break;
        await store.popAction(code);
        if (a.k === 'intent') break;
      }
      return { ok: true, events: [] };
    }

    case 'chooseFirst': {
      const tracker = trackerFor(meta, game);
      const chosen = tracker.chooseFirst(seat, action.onPlay);
      if (chosen === null) return { ok: false, error: 'It is not your choice to make' };
      meta.match = tracker.state;
      meta.startingPlayer = chosen;
      meta.seed = Math.floor(Math.random() * 2 ** 31);
      // A drafted series sideboards between games: go back to the builder and
      // wait for both players to lock a list in again.
      if (meta.format === 'draft') {
        meta.phase = 'build';
        meta.ready = [];
      }
      meta.rev++;
      await store.setMeta(code, meta);
      await store.clearLog(code);
      return { ok: true, events: [] };
    }
  }
}
