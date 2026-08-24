import { Worker } from 'node:worker_threads';
import type { PlayerId } from '../engine/types.js';
import { gameSeed, playMatch } from './arena.js';
import { summarise, type SeriesSummary } from './elo.js';
import { makeAgent } from './registry.js';

/**
 * Running a lot of games and getting a number out.
 *
 * The unit of work is a **mirror pair**: one seed, played twice, once with each agent
 * on the play. Both halves of a pair deal the same libraries — the shuffle depends on
 * the seed and nothing else — so pairing cancels the play/draw advantage instead of
 * averaging over it. That advantage is the largest single source of noise in a combo
 * mirror, and removing it is worth roughly a factor of two in variance
 * (DESIGN-AI.md 5.3).
 *
 * Pairs are independent of each other and of everything else, which makes this
 * embarrassingly parallel: a shard is a contiguous range of pair indices, and a
 * worker needs nothing but the two agent names and that range.
 */

export interface SeriesOptions {
  /** Agent specs, as understood by `makeAgent` — a worker rebuilds them from these. */
  a: string;
  b: string;
  /** How many mirror pairs. Each pair is two matches, so `2 × pairs` matches. */
  pairs: number;
  bestOf?: number;
  seed?: number;
  budgetMs?: number;
  maxSteps?: number;
}

export interface MatchOutcome {
  pair: number;
  /** 0 = A on the play, 1 = B on the play. */
  half: 0 | 1;
  /** A's score for this match: 1 won, 0 lost, 0.5 for anything else. */
  aScore: number;
  games: number;
  /** Total turns across the match. */
  turns: number;
  reasons: string[];
  unfinished: number;
  decisions: number;
}

export interface SeriesResult {
  a: string;
  b: string;
  summary: SeriesSummary;
  /** Games, not matches — a best-of-three counts as up to three. */
  totalGames: number;
  averageTurns: number;
  averageDecisions: number;
  byReason: Record<string, number>;
  elapsedMs: number;
  gamesPerSecond: number;
  workers: number;
}

/** One shard: pairs `[from, to)`. */
export function runPairRange(opts: SeriesOptions, from: number, to: number): MatchOutcome[] {
  const pairs: number[] = [];
  for (let pair = from; pair < to; pair++) pairs.push(pair);
  return runPairs(opts, pairs);
}

/**
 * Play a specific list of mirror pairs. Shared by the in-process path and the worker.
 *
 * A list rather than a range because a resumed run is not contiguous: it is whatever
 * the last attempt did not finish.
 */
export function runPairs(opts: SeriesOptions, pairs: number[]): MatchOutcome[] {
  const baseSeed = opts.seed ?? 12345;
  const bestOf = opts.bestOf ?? 1;
  const out: MatchOutcome[] = [];

  for (const pair of pairs) {
    const seed = gameSeed(baseSeed, pair + 1);
    for (const half of [0, 1] as const) {
      // Seat A is always p1 so the result needs no unpicking; what flips is who
      // starts, which is the whole point of the pair.
      const startingPlayer: PlayerId = half === 0 ? 'p1' : 'p2';
      // Agents are rebuilt per match. A stateful agent must not carry anything from
      // one match into the next, or the run is not reproducible from its seeds.
      const record = playMatch({
        p1: makeAgent(opts.a),
        p2: makeAgent(opts.b),
        seed,
        startingPlayer,
        bestOf,
        budgetMs: opts.budgetMs,
        maxSteps: opts.maxSteps,
      });
      out.push({
        pair,
        half,
        aScore: record.winner === 'p1' ? 1 : record.winner === 'p2' ? 0 : 0.5,
        games: record.games.length,
        turns: record.games.reduce((n, g) => n + g.turns, 0),
        reasons: record.games.map((g) => g.reason ?? 'unknown'),
        unfinished: record.games.filter((g) => g.unfinished).length,
        decisions: record.games.reduce((n, g) => n + g.decisions, 0),
      });
    }
  }
  return out;
}

function aggregate(
  opts: SeriesOptions,
  outcomes: MatchOutcome[],
  elapsedMs: number,
  workers: number,
): SeriesResult {
  const byPair = new Map<number, number[]>();
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let unfinished = 0;
  let totalGames = 0;
  let totalTurns = 0;
  let totalDecisions = 0;
  const byReason: Record<string, number> = {};

  for (const o of outcomes) {
    if (!byPair.has(o.pair)) byPair.set(o.pair, []);
    byPair.get(o.pair)!.push(o.aScore);
    if (o.aScore === 1) wins++;
    else if (o.aScore === 0) losses++;
    else draws++;
    unfinished += o.unfinished;
    totalGames += o.games;
    totalTurns += o.turns;
    totalDecisions += o.decisions;
    for (const r of o.reasons) byReason[r] = (byReason[r] ?? 0) + 1;
  }

  // Only complete pairs count: half a pair still carries the play/draw bias the
  // pairing exists to remove.
  const pairScores = [...byPair.values()]
    .filter((scores) => scores.length === 2)
    .map((scores) => (scores[0] + scores[1]) / 2);

  return {
    a: opts.a,
    b: opts.b,
    summary: summarise({ pairScores, wins, losses, draws, unfinished }),
    totalGames,
    averageTurns: totalGames > 0 ? totalTurns / totalGames : 0,
    averageDecisions: totalGames > 0 ? totalDecisions / totalGames : 0,
    byReason,
    elapsedMs,
    gamesPerSecond: elapsedMs > 0 ? (totalGames * 1000) / elapsedMs : 0,
    workers,
  };
}

export interface RunOptions extends SeriesOptions {
  /** Threads to spread the pairs across. 1 runs in this process. */
  workers?: number;
  onProgress?: (donePairs: number, totalPairs: number) => void;
  /**
   * Called with each batch of finished matches as they arrive.
   *
   * A search run is measured in hours, and one that only reports at the end is one
   * where those hours are hostage to a lid closing. This is where a caller persists
   * what it has so a re-run can start from there instead of from nothing.
   */
  onOutcomes?: (outcomes: MatchOutcome[]) => void;
  /** Pairs already played, from a previous run's checkpoint. Skipped rather than replayed. */
  done?: MatchOutcome[];
}

export async function runSeries(opts: RunOptions): Promise<SeriesResult> {
  const started = Date.now();

  /*
   * Only whole pairs are carried over.
   *
   * A pair with one half in it is a pair that is going to be replayed, and keeping
   * its orphaned half would then count that match twice — inflating the sample with
   * a duplicate and, because the pairing rule wants exactly two halves, quietly
   * dropping the pair from the statistics altogether. Half a pair is also worthless
   * on its own: it carries the play/draw bias the pairing exists to cancel.
   */
  const finishedPairs = new Set<number>(countCompletePairs(opts.done ?? []));
  const alreadyDone = (opts.done ?? []).filter((o) => finishedPairs.has(o.pair));

  const todo: number[] = [];
  for (let pair = 0; pair < opts.pairs; pair++) {
    if (!finishedPairs.has(pair)) todo.push(pair);
  }
  if (todo.length === 0) {
    opts.onProgress?.(opts.pairs, opts.pairs);
    return aggregate(opts, alreadyDone, Date.now() - started, 0);
  }

  const threads = Math.max(1, Math.min(opts.workers ?? 1, todo.length));

  if (threads === 1) {
    const outcomes: MatchOutcome[] = [];
    for (const pair of todo) {
      const batch = runPairRange(opts, pair, pair + 1);
      outcomes.push(...batch);
      opts.onOutcomes?.(batch);
      opts.onProgress?.(finishedPairs.size + outcomes.length / 2, opts.pairs);
    }
    return aggregate(opts, [...alreadyDone, ...outcomes], Date.now() - started, 1);
  }

  /*
   * Round-robin rather than contiguous blocks.
   *
   * A resumed run has holes in it, and dealing the remaining pairs out one at a time
   * keeps every worker's share the same size however ragged those holes are. Games
   * here all cost about the same, so nothing else about the split matters.
   */
  const shards: number[][] = Array.from({ length: threads }, () => []);
  todo.forEach((pair, i) => shards[i % threads].push(pair));

  let done = finishedPairs.size;
  const results = await Promise.all(
    shards
      .filter((s) => s.length > 0)
      .map(
        (pairs) =>
          new Promise<MatchOutcome[]>((resolve, reject) => {
            const collected: MatchOutcome[] = [];
            const worker = new Worker(new URL('./worker.ts', import.meta.url), {
              workerData: { opts: stripCallbacks(opts), pairs },
            });
            worker.on('message', (msg: WorkerMessage) => {
              if (msg.t === 'progress') {
                collected.push(...msg.outcomes);
                // Hand them over as they land, so a caller can write them down
                // before the next hour of the run has a chance to go wrong.
                opts.onOutcomes?.(msg.outcomes);
                done += msg.pairs;
                opts.onProgress?.(done, opts.pairs);
                return;
              }
              resolve(collected);
              void worker.terminate();
            });
            worker.on('error', reject);
            worker.on('exit', (code) => {
              if (code !== 0) reject(new Error(`arena worker exited with code ${code}`));
            });
          }),
      ),
  );

  return aggregate(
    opts,
    [...alreadyDone, ...results.flat()],
    Date.now() - started,
    shards.filter((s) => s.length > 0).length,
  );
}

/** Pairs for which both halves have been played, which is the resumable unit. */
function countCompletePairs(outcomes: MatchOutcome[]): number[] {
  const halves = new Map<number, Set<number>>();
  for (const o of outcomes) {
    if (!halves.has(o.pair)) halves.set(o.pair, new Set());
    halves.get(o.pair)!.add(o.half);
  }
  // Half a pair still carries the play/draw bias the pairing exists to remove, so a
  // pair is only worth keeping — and only worth skipping — once both halves are in.
  return [...halves.entries()].filter(([, s]) => s.size === 2).map(([pair]) => pair);
}

/** `workerData` is structured-cloned, and a function is not cloneable. */
function stripCallbacks(opts: RunOptions): SeriesOptions {
  return {
    a: opts.a,
    b: opts.b,
    pairs: opts.pairs,
    bestOf: opts.bestOf,
    seed: opts.seed,
    budgetMs: opts.budgetMs,
    maxSteps: opts.maxSteps,
  };
}

export type WorkerMessage =
  | { t: 'progress'; pairs: number; outcomes: MatchOutcome[] }
  | { t: 'done'; outcomes: MatchOutcome[] };
