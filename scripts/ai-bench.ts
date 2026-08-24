import { availableParallelism, cpus } from 'node:os';
import { intArg, parseArgs } from '../src/ai/args.js';
import {
  bench,
  formatBench,
  formatParallelism,
  measureParallelism,
} from '../src/ai/bench.js';

/**
 * The measurements the AI plan is built on.
 *
 *   npm run ai:bench
 *
 * Everything in DESIGN-AI.md 1 came from a run of this. Re-run it after touching the
 * engine: which approaches are affordable is a function of these numbers, and a
 * regression in decision cost is a regression in how deep any search can go.
 *
 * A laptop under sustained load throttles, so a second run is usually slower than the
 * first. Compare like with like — and read the ratios, which hold up, rather than the
 * absolute microseconds, which do not.
 */

const args = parseArgs(process.argv.slice(2));
const games = intArg(args, 'games', 40);

console.log(`${cpus()[0]?.model?.trim() ?? 'unknown CPU'} — ${cpus().length} logical cores\n`);

console.log(formatBench(bench(games)));

if (args.parallel !== 'false') {
  console.log('');
  const max = Math.max(1, availableParallelism() - 2);
  const counts = [1, 2, 4, 8, max].filter((n, i, a) => n <= max && a.indexOf(n) === i);
  console.log(formatParallelism(await measureParallelism(counts)));
}
