import { parentPort, workerData } from 'node:worker_threads';
import { runPairRange, type MatchOutcome, type SeriesOptions, type WorkerMessage } from './series.js';

/**
 * One shard of an arena run.
 *
 * Games are independent, the engine is pure, and an agent is rebuildable from its
 * name — so a worker needs nothing but two names and a range of pair indices, and the
 * parallelism is perfect. This is where the 12 cores on a laptop turn into 12× the
 * self-play, with no shared state to get wrong. See DESIGN-AI.md 6.4.
 */

const { opts, from, to } = workerData as { opts: SeriesOptions; from: number; to: number };

const outcomes: MatchOutcome[] = [];
const CHUNK = 8;

for (let start = from; start < to; start += CHUNK) {
  const end = Math.min(to, start + CHUNK);
  outcomes.push(...runPairRange(opts, start, end));
  const progress: WorkerMessage = { t: 'progress', pairs: end - start };
  parentPort?.postMessage(progress);
}

const done: WorkerMessage = { t: 'done', outcomes };
parentPort?.postMessage(done);
