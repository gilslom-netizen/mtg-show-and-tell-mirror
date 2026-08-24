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

/** One shard: pairs `[from, to)`. Shared by the in-process path and the worker. */
export function runPairRange(opts: SeriesOptions, from: number, to: number): MatchOutcome[] {
  const baseSeed = opts.seed ?? 12345;
  const bestOf = opts.bestOf ?? 1;
  const out: MatchOutcome[] = [];

  for (let pair = from; pair < to; pair++) {
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
}

export async function runSeries(opts: RunOptions): Promise<SeriesResult> {
  const started = Date.now();
  const threads = Math.max(1, Math.min(opts.workers ?? 1, opts.pairs));

  if (threads === 1) {
    const outcomes = runPairRange(opts, 0, opts.pairs);
    opts.onProgress?.(opts.pairs, opts.pairs);
    return aggregate(opts, outcomes, Date.now() - started, 1);
  }

  // Contiguous shards rather than round-robin: a shard is two numbers, and games in
  // this deck all cost about the same, so there is nothing to gain from interleaving.
  const bounds: [number, number][] = [];
  const per = Math.ceil(opts.pairs / threads);
  for (let i = 0; i < threads; i++) {
    const from = i * per;
    if (from >= opts.pairs) break;
    bounds.push([from, Math.min(opts.pairs, from + per)]);
  }

  let done = 0;
  const shards = await Promise.all(
    bounds.map(
      ([from, to]) =>
        new Promise<MatchOutcome[]>((resolve, reject) => {
          const worker = new Worker(new URL('./worker.ts', import.meta.url), {
            workerData: { opts: stripCallbacks(opts), from, to },
          });
          worker.on('message', (msg: WorkerMessage) => {
            if (msg.t === 'progress') {
              done += msg.pairs;
              opts.onProgress?.(done, opts.pairs);
              return;
            }
            resolve(msg.outcomes);
            void worker.terminate();
          });
          worker.on('error', reject);
          worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`arena worker exited with code ${code}`));
          });
        }),
    ),
  );

  return aggregate(opts, shards.flat(), Date.now() - started, bounds.length);
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
  | { t: 'progress'; pairs: number }
  | { t: 'done'; outcomes: MatchOutcome[] };
