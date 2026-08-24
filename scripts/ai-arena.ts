import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { intArg, parseArgs } from '../src/ai/args.js';
import { formatSummary } from '../src/ai/elo.js';
import { AGENT_SPECS, makeAgent } from '../src/ai/registry.js';
import { runSeries, type MatchOutcome } from '../src/ai/series.js';

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
      '  --budget <ms>     per-decision time budget handed to the agents (default 50).',
      '                    For a search agent, make this big enough never to bite —',
      '                    a run the clock interrupted is a run that will not repeat.',
      '  --checkpoint <f>  append finished pairs to this file, and resume from it.',
      '                    A search run takes hours; without this, an interruption',
      '                    at hour two costs hour one as well.',
      '  --out <f>         write the finished summary to this file as JSON',
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
 * Measured on the machine this was written on, over 1,200 games: 22 games/s on one
 * thread, 46 on four, 45 on eight, and no better above that. Games are perfectly
 * independent and share nothing, so what flattens the curve is memory bandwidth and
 * worker start-up rather than contention — the ceiling belongs to the machine, not to
 * the arena. Default to the knee and leave the flag for anything bigger.
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

/*
 * A search agent on a small clock is a search agent whose result cannot be repeated:
 * how many determinizations fit into fifty milliseconds depends on what else the
 * machine is doing, and every run then measures a slightly different agent.
 */
if ([a, b].some((spec) => spec.startsWith('pimc')) && budgetMs < 2000) {
  console.log(
    `Warning: --budget ${budgetMs} will cut a search short, and how short depends on how\n` +
      `busy the machine is — so this run will not reproduce. Use --budget 30000 and let\n` +
      `the determinization count (pimc:<n>) decide how hard it thinks.\n`,
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

/*
 * The checkpoint is one JSON object per line, appended as pairs finish.
 *
 * A line at a time rather than a rewritten file, because the failure this is for is
 * the process going away without warning — and appending a line either happens or
 * does not, where rewriting a file can leave half of one. Anything unparseable at the
 * end of the file is the record of exactly that, and is dropped.
 */
const checkpointFile = args.checkpoint;
const alreadyDone: MatchOutcome[] = [];
if (checkpointFile && existsSync(checkpointFile)) {
  for (const line of readFileSync(checkpointFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      alreadyDone.push(JSON.parse(line) as MatchOutcome);
    } catch {
      // A torn last line from a run that was killed mid-write.
    }
  }
  // Whole pairs only — a pair with one half recorded is a pair that gets replayed.
  const halves = new Map<number, number>();
  for (const o of alreadyDone) halves.set(o.pair, (halves.get(o.pair) ?? 0) + 1);
  const complete = [...halves.values()].filter((n) => n >= 2).length;
  console.log(`Resuming from ${checkpointFile}: ${complete} whole pairs already played.\n`);
}

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
  done: alreadyDone,
  onOutcomes: checkpointFile
    ? (outcomes) => {
        appendFileSync(checkpointFile, outcomes.map((o) => JSON.stringify(o)).join('\n') + '\n');
      }
    : undefined,
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
const reproduce = `--a ${a} --b ${b} --games ${matches} --bo ${bestOf} --seed ${seed} --budget ${budgetMs}`;
console.log(`\n  reproduce with: ${reproduce}`);

if (args.out) {
  writeFileSync(
    args.out,
    JSON.stringify(
      {
        a,
        b,
        matches,
        bestOf,
        seed,
        budgetMs,
        workers: result.workers,
        reproduce,
        summary: result.summary,
        totalGames: result.totalGames,
        averageTurns: result.averageTurns,
        averageDecisions: result.averageDecisions,
        byReason: result.byReason,
        elapsedMs: result.elapsedMs,
        gamesPerSecond: result.gamesPerSecond,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cores: availableParallelism(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`  written to ${args.out}`);
}
