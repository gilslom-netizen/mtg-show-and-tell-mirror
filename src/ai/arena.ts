import { MAINDECK } from '../engine/deck.js';
import { Game, type Intent } from '../engine/game.js';
import { MatchTracker, type GameResult, type MatchState } from '../engine/match.js';
import { redact } from '../engine/redact.js';
import type { ChoiceResponse, PlayerId } from '../engine/types.js';
import { DEFAULT_BUDGET_MS, type Agent } from './agent.js';

/**
 * Headless self-play: two agents, one engine, no UI.
 *
 * The one thing worth understanding here is what a finished game is stored as.
 * The engine is deterministic — a game is fully determined by `(seed, starting
 * player, action log)` — so a `GameRecord` is those three things and nothing else,
 * about 4KB. Storing states instead would be 200 decisions × 12.5KB = 2.5MB, a ratio
 * of roughly 1:600. That is the difference between a million-game training corpus
 * being 4GB and being 2.5TB, and re-deriving any position from a record costs one
 * replay at ~40ms. See DESIGN-AI.md 5.2.
 *
 * The driver reads `game.state.pendingChoice` to find out *who* still owes an answer
 * to a shared question. That is transport plumbing standing in for the server, not
 * knowledge: agents themselves are only ever handed `redact(state, seat)`.
 */

export type RecordedAction =
  | { k: 'intent'; seat: PlayerId; intent: Intent }
  | { k: 'choice'; seat: PlayerId; choiceId: string; response: ChoiceResponse };

export interface GameRecord {
  seed: number;
  startingPlayer: PlayerId;
  actions: RecordedAction[];
  winner: PlayerId | 'draw' | null;
  reason: string | null;
  turns: number;
  /** How many times an agent was asked for something. */
  decisions: number;
  /** True when the step guard tripped before the game ended — always a bug. */
  unfinished: boolean;
  agents: Record<PlayerId, string>;
}

export interface PlayGameOptions {
  p1: Agent;
  p2: Agent;
  seed: number;
  startingPlayer?: PlayerId;
  budgetMs?: number;
  /**
   * Engine steps before the driver gives up. A real game is a few hundred; the
   * guard exists so a broken agent cannot hang a 10,000 game run.
   */
  maxSteps?: number;
  /**
   * Keep the Esc snapshot. Off by default — self-play has no Esc and the snapshot
   * costs half of every decision. Only the benchmark turns it on, to measure what
   * turning it off is worth.
   */
  undoable?: boolean;
  /**
   * Called with the live game immediately before each agent decision.
   *
   * The instrumentation seam: the benchmark uses it to measure branching factor and
   * to capture a mid-game state, and it is where the training loop will index
   * positions into a replay buffer (DESIGN-AI.md 11.1). Not available to agents —
   * they get a redacted view and nothing else.
   */
  onDecision?: (game: Game, seat: PlayerId, kind: 'priority' | 'choice') => void;
}

/**
 * Comfortably above the longest real game measured — a heuristic mirror averages
 * about 600 agent decisions — and low enough that a loop is caught in seconds rather
 * than found in the morning. `unfinished` is the alarm; this is only how long it
 * takes to ring.
 */
const DEFAULT_MAX_STEPS = 12000;

export function newArenaGame(seed: number, startingPlayer: PlayerId, undoable = false): Game {
  return Game.create({
    gameId: `arena-${seed}-${startingPlayer}`,
    seed,
    deck: MAINDECK,
    startingPlayer,
    // No Esc in self-play, and the snapshot it exists for is half the cost of a
    // decision. DESIGN-AI.md 6.1.
    undoable,
  });
}

function fail(agent: Agent, seat: PlayerId, what: string, cause: unknown): never {
  const why = cause instanceof Error ? cause.message : String(cause);
  throw new Error(`${agent.name} (${seat}) ${what}: ${why}`);
}

export function playGame(opts: PlayGameOptions): GameRecord {
  return playGameDetailed(opts).record;
}

/**
 * As `playGame`, but hands back the finished game as well.
 *
 * A caller that wants the final position — the match tracker, a test comparing a
 * replay against the original — should take it from here rather than replaying the
 * record for it. Replaying costs about as much as playing did, and doing it for
 * every game of every match in an arena run is most of the run.
 */
export interface RunToEndOptions {
  budgetMs?: number;
  maxSteps?: number;
  /** Appended to as the game goes. Omit when the log is not wanted. */
  actions?: RecordedAction[];
  onDecision?: PlayGameOptions['onDecision'];
}

/**
 * Drive a game from wherever it is to wherever it stops.
 *
 * Shared by the arena and by search: a rollout is the same loop as a game, started
 * from a position somebody imagined rather than from a shuffle. Keeping it in one
 * place is what makes a rollout play by the same rules the arena does — including
 * which seat is asked what, which is the part that is easy to get subtly wrong.
 */
export function runToEnd(
  game: Game,
  agents: Record<PlayerId, Agent>,
  opts: RunToEndOptions = {},
): { decisions: number; unfinished: boolean } {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  let decisions = 0;
  let steps = 0;

  game.advance();

  while (game.state.winner === null && steps < maxSteps) {
    steps++;
    const pc = game.state.pendingChoice;

    if (pc) {
      /*
       * Mulligan and Show and Tell are asked of both players at once, and either
       * may still owe an answer. Everything else has a single owner.
       */
      const seats: PlayerId[] =
        pc.kind === 'mulligan' || pc.kind === 'simultaneousSecret'
          ? [...pc.awaiting]
          : [pc.player];

      for (const seat of seats) {
        // A shared choice resolves as soon as the last player locks in, so re-check.
        if (game.state.pendingChoice?.id !== pc.id) break;
        const view = redact(game.state, seat);
        if (!view.choice) continue;
        opts.onDecision?.(game, seat, 'choice');
        decisions++;
        let response: ChoiceResponse;
        try {
          response = agents[seat].respond(view, view.choice, budgetMs);
        } catch (e) {
          fail(agents[seat], seat, `threw answering ${view.choice.kind}`, e);
        }
        try {
          game.submitChoice(seat, pc.id, response);
        } catch (e) {
          fail(agents[seat], seat, `answered ${view.choice.kind} illegally`, e);
        }
        opts.actions?.push({ k: 'choice', seat, choiceId: pc.id, response });
      }
      continue;
    }

    const seat = game.state.priorityPlayer;
    if (seat === null) {
      game.advance();
      continue;
    }

    const view = redact(game.state, seat);
    opts.onDecision?.(game, seat, 'priority');
    decisions++;
    let intent: Intent;
    try {
      intent = agents[seat].act(view, budgetMs);
    } catch (e) {
      fail(agents[seat], seat, 'threw choosing an action', e);
    }
    try {
      game.submitIntent(seat, intent);
    } catch (e) {
      fail(agents[seat], seat, `played an illegal action ${JSON.stringify(intent)}`, e);
    }
    opts.actions?.push({ k: 'intent', seat, intent });
  }

  return { decisions, unfinished: game.state.winner === null };
}

export function playGameDetailed(opts: PlayGameOptions): { record: GameRecord; game: Game } {
  const startingPlayer = opts.startingPlayer ?? 'p1';
  const game = newArenaGame(opts.seed, startingPlayer, opts.undoable ?? false);
  const actions: RecordedAction[] = [];

  const { decisions } = runToEnd(
    game,
    { p1: opts.p1, p2: opts.p2 },
    {
      budgetMs: opts.budgetMs,
      maxSteps: opts.maxSteps,
      actions,
      onDecision: opts.onDecision,
    },
  );

  return {
    record: {
      seed: opts.seed,
      startingPlayer,
      actions,
      winner: game.state.winner,
      reason: game.state.endReason,
      turns: game.state.turn,
      decisions,
      unfinished: game.state.winner === null,
      agents: { p1: opts.p1.name, p2: opts.p2.name },
    },
    game,
  };
}

/**
 * Rebuilds a recorded game from `(seed, startingPlayer, actions)`.
 *
 * The claim that a record is a lossless 4KB stand-in for the whole game is only
 * worth anything if it is checked, so `arena.test.ts` replays records and compares
 * the resulting state against the state the original run finished in.
 */
export function replayRecord(record: GameRecord): Game {
  const game = newArenaGame(record.seed, record.startingPlayer);
  game.advance();
  for (const a of record.actions) {
    if (a.k === 'intent') game.submitIntent(a.seat, a.intent);
    else game.submitChoice(a.seat, a.choiceId, a.response);
  }
  return game;
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

/**
 * A seed for game N of a series. Every game in a match needs its own shuffle, and
 * `seed + n` would give neighbouring matches overlapping games.
 */
export function gameSeed(seed: number, gameNumber: number): number {
  let z = (seed + Math.imul(gameNumber, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

export interface MatchRecord {
  winner: PlayerId | null;
  games: GameRecord[];
  history: GameResult[];
  match: MatchState;
}

export interface PlayMatchOptions extends Omit<PlayGameOptions, 'seed'> {
  seed: number;
  bestOf?: number;
}

export function playMatch(opts: PlayMatchOptions): MatchRecord {
  const bestOf = opts.bestOf ?? 1;
  const startingPlayer = opts.startingPlayer ?? 'p1';
  const agents: Record<PlayerId, Agent> = { p1: opts.p1, p2: opts.p2 };
  const tracker = new MatchTracker(startingPlayer, bestOf);
  const games: GameRecord[] = [];

  // Guard rather than `while (!tracker.isOver())`: a best-of-five cannot need more
  // than five games, and a draw that never records a winner must not spin.
  for (let n = 1; n <= bestOf && !tracker.isOver(); n++) {
    const { record, game } = playGameDetailed({
      ...opts,
      seed: gameSeed(opts.seed, n),
      startingPlayer: tracker.state.onPlay,
    });
    games.push(record);
    tracker.noteResult(game);

    const loser = tracker.state.awaitingFirstChoiceFrom;
    if (loser !== null) {
      const onPlay = agents[loser].chooseFirst?.(tracker.state, loser) ?? loser;
      tracker.chooseFirst(loser, onPlay);
    }
  }

  return {
    winner: tracker.state.matchWinner,
    games,
    history: tracker.state.history,
    match: tracker.state,
  };
}
