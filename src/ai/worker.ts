import { parentPort, workerData } from 'node:worker_threads';
import { runPairs, type MatchOutcome, type SeriesOptions, type WorkerMessage } from './series.js';

/**
 * One shard of an arena run.
 *
 * Games are independent, the engine is pure, and an agent is rebuildable from its
 * name — so a worker needs nothing but two names and a range of pair indices, and the
 * parallelism is perfect. This is where the 12 cores on a laptop turn into 12× the
 * self-play, with no shared state to get wrong. See DESIGN-AI.md 6.4.
 */

const { opts, pairs } = workerData as { opts: SeriesOptions; pairs: number[] };

/**
 * Results are sent back as they are finished rather than in one lump at the end.
 *
 * A search run takes hours, and a run that only reports when it is over is a run
 * where an hour of it is lost to a laptop lid or an out-of-memory kill. Streaming
 * lets the caller checkpoint, and lets a re-run pick up where the last one stopped.
 */
const CHUNK = 4;

for (let start = 0; start < pairs.length; start += CHUNK) {
  const batch = pairs.slice(start, start + CHUNK);
  const outcomes: MatchOutcome[] = runPairs(opts, batch);
  const progress: WorkerMessage = { t: 'progress', pairs: batch.length, outcomes };
  parentPort?.postMessage(progress);
}

const done: WorkerMessage = { t: 'done', outcomes: [] };
parentPort?.postMessage(done);
