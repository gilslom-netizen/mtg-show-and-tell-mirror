import { availableParallelism } from 'node:os';
import { intArg, parseArgs } from '../src/ai/args.js';
import { formatSummary } from '../src/ai/elo.js';
import { AGENT_SPECS, makeAgent } from '../src/ai/registry.js';
import { runSeries } from '../src/ai/series.js';

/**
 * The evaluation arena.
 *
 *   npm run ai:arena -- --a heuristic --b random --games 2000
 *
 * Defaults are chosen to stop the most common way of fooling yourself: 2,000 games
 * minimum, played as mirror pairs, and a confidence interval printed next to every
 * number. A 55% win rate over 200 games in this deck means nothing, and the output
 * says so out loud when the interval still straddles an even split.
 */

const args = parseArgs(process.argv.slice(2));

if (args.help === 'true') {
  console.log(
    [
      'npm run ai:arena -- [options]',
      '',
      `  --a <agent>       first agent   (default heuristic).  Known: ${AGENT_SPECS.join(', ')}`,
      '  --b <agent>       second agent  (default random)',
      '  --games <n>       matches to play, rounded up to whole mirror pairs (default 2000)',
      '  --bo <1|3|5>      length of each match (default 1)',
      '  --seed <n>        base seed; the same seed replays the same run exactly',
      '  --workers <n>     threads (default: cores - 2). 1 keeps it in this process',
      '  --budget <ms>     per-decision time budget handed to the agents (default 50)',
    ].join('\n'),
  );
  process.exit(0);
}

const a = args.a ?? 'heuristic';
const b = args.b ?? 'random';
const matches = intArg(args, 'games', 2000);
const pairs = Math.max(1, Math.ceil(matches / 2));
const bestOf = intArg(args, 'bo', 1);
const seed = intArg(args, 'seed', 20260824);
/*
 * Measured on the machine this was written on: 21 games/s on one thread, 33 on four,
 * 40 on eight, and worse again above that. Games are perfectly independent, so what
 * flattens the curve is memory bandwidth and worker start-up, not contention — which
 * means the ceiling is a property of the machine rather than of the arena. Default to
 * the knee of that curve and leave the flag for anything bigger.
 */
const workers = intArg(args, 'workers', Math.max(1, Math.min(8, availableParallelism() - 2)));
const budgetMs = intArg(args, 'budget', 50);

// Fail on a typo now rather than inside a worker thread in thirty seconds.
makeAgent(a);
makeAgent(b);

if (matches < 2000 && args.games !== undefined) {
  console.log(
    `Note: ${matches} matches is below the 2,000 this deck needs for a meaningful comparison.\n`,
  );
}

// Only when someone is watching: redrawn into a pipe, a progress bar is a thousand
// lines of noise in front of the result.
const bar = process.stdout.isTTY
  ? (done: number, total: number) => {
      const width = 30;
      const filled = Math.round((done / total) * width);
      process.stdout.write(
        `\r  ${'█'.repeat(filled)}${'·'.repeat(width - filled)}  ${done}/${total} pairs`,
      );
    }
  : undefined;

console.log(
  `${a} vs ${b} — ${pairs} mirror pairs (${pairs * 2} matches, best of ${bestOf}) on ${workers} thread${
    workers === 1 ? '' : 's'
  }\n`,
);

const result = await runSeries({
  a,
  b,
  pairs,
  bestOf,
  seed,
  budgetMs,
  workers,
  onProgress: bar,
});
process.stdout.write(bar ? '\n\n' : '\n');

console.log(formatSummary(a, b, result.summary));
console.log('');
console.log(`  ${result.totalGames} games, ${result.averageTurns.toFixed(1)} turns each on average`);
console.log(`  ${result.averageDecisions.toFixed(0)} agent decisions per game`);
console.log(
  `  ${(result.elapsedMs / 1000).toFixed(1)}s wall clock — ${result.gamesPerSecond.toFixed(
    0,
  )} games/s across ${result.workers} thread${result.workers === 1 ? '' : 's'}`,
);
console.log('');
console.log('  how the games ended:');
for (const [reason, n] of Object.entries(result.byReason).sort((x, y) => y[1] - x[1])) {
  console.log(`    ${String(n).padStart(6)}  ${reason}`);
}
console.log(`\n  reproduce with: --a ${a} --b ${b} --games ${matches} --bo ${bestOf} --seed ${seed}`);
