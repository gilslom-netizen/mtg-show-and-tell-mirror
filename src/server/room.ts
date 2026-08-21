import { randomUUID } from 'node:crypto';
import { MAINDECK } from '../engine/deck';
import { Game, type Intent } from '../engine/game';
import { MatchTracker, newMatchState, type MatchState } from '../engine/match';
import { redact, redactEvents, type PlayerView } from '../engine/redact';
import type { ChoiceResponse, GameEvent, PlayerId } from '../engine/types';
import type { LoggedAction, MatchStore, RoomMeta } from './store';

/**
 * Room logic shared by every online transport.
 *
 * Every request rebuilds the game by replaying the action log. That is only
 * affordable because the engine is deterministic and a whole game is a few hundred
 * actions — replaying one takes single-digit milliseconds.
 */

export interface Snapshot {
  seat: PlayerId;
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

export function freshMeta(code: string): RoomMeta {
  const startingPlayer: PlayerId = Math.random() < 0.5 ? 'p1' : 'p2';
  return {
    code,
    seed: Math.floor(Math.random() * 2 ** 31),
    startingPlayer,
    seats: {},
    match: newMatchState(startingPlayer),
    createdAt: Date.now(),
    rev: 1,
  };
}

/** Replays a log into a game. Actions that no longer apply are skipped, not fatal. */
export function buildGame(meta: RoomMeta, log: LoggedAction[]): Game {
  const game = Game.create({
    gameId: `${meta.code}-g${meta.match.gameNumber}-${meta.seed}`,
    seed: meta.seed,
    deck: MAINDECK,
    startingPlayer: meta.startingPlayer,
  });
  game.advance();
  for (const a of log) {
    try {
      if (a.k === 'intent') game.submitIntent(a.seat, a.intent);
      else game.submitChoice(a.seat, a.choiceId, a.response);
    } catch {
      // A logged action that will not replay means the log and the engine have
      // diverged. Skipping keeps the rest of the game playable rather than
      // bricking the room.
    }
  }
  return game;
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
  opts: { token?: string; name?: string },
): Promise<JoinResult | { error: string }> {
  let meta = await store.getMeta(code);
  let created = false;
  if (!meta) {
    meta = freshMeta(code);
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
  const game = buildGame(meta, log);
  const tracker = trackerFor(meta, game);

  // A game that just finished has to be recorded before anyone sees the result.
  if (JSON.stringify(tracker.state) !== JSON.stringify(meta.match)) {
    meta.match = tracker.state;
    meta.rev++;
    await store.setMeta(code, meta);
  }

  const players = (['p1', 'p2'] as PlayerId[])
    .filter((s) => meta.seats[s])
    .map((s) => ({ seat: s, name: meta.seats[s]!.name }));

  return {
    seat,
    version: log.length,
    rev: meta.rev,
    view: redact(game.state, seat),
    match: meta.match,
    events: opts.events ? redactEvents(game.state, seat, opts.events) : [],
    players,
    ready: players.length === 2,
  };
}

export type RoomAction =
  | { t: 'intent'; intent: Intent }
  | { t: 'choice'; choiceId: string; response: ChoiceResponse }
  | { t: 'cancel' }
  | { t: 'chooseFirst'; onPlay: PlayerId };

export async function applyAction(
  store: MatchStore,
  code: string,
  seat: PlayerId,
  action: RoomAction,
): Promise<{ ok: true; events: GameEvent[] } | { ok: false; error: string }> {
  const meta = await store.getMeta(code);
  if (!meta) return { ok: false, error: 'Unknown room' };
  const log = await store.getLog(code);
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
      // Rewind the tail of this player's own half-finished action.
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
      meta.rev++;
      await store.setMeta(code, meta);
      await store.clearLog(code);
      return { ok: true, events: [] };
    }
  }
}
