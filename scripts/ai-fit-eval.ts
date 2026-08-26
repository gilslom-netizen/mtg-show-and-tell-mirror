import { intArg, parseArgs } from '../src/ai/args.js';
import { collectSamples, fitLogistic, formatFit } from '../src/ai/fit.js';

/**
 * Fit the position evaluation against real outcomes.
 *
 *   npm run ai:fit-eval -- --games 2400
 *
 * Prints the weights to paste into `EVAL_WEIGHTS`. Nothing is written automatically:
 * a fit that turns out no better than a coin flip should not silently become the
 * thing every search in the project consults, and the numbers deserve to be read
 * before they are believed.
 */

const args = parseArgs(process.argv.slice(2));
const games = intArg(args, 'games', 1200);
const every = intArg(args, 'every', 12);
const steps = intArg(args, 'steps', 4000);

console.log(`Playing ${games} heuristic games and sampling a position every ${every} decisions…`);
const started = Date.now();
const samples = collectSamples({ games, every });
console.log(
  `  ${samples.length} labelled positions in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
);

const won = samples.filter((s) => s.label === 1).length;
console.log(`  label balance: ${won} won, ${samples.length - won} lost\n`);

console.log(formatFit(fitLogistic(samples, { steps })));
