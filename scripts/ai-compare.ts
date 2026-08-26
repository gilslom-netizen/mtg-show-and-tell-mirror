import { readFileSync } from 'node:fs';
import { parseArgs } from '../src/ai/args.js';
import { eloFromScore } from '../src/ai/elo.js';
import type { MatchOutcome } from '../src/ai/series.js';

/**
 * Compare two arena runs that shared their seeds, pair by pair.
 *
 *   npm run ai:compare -- --a checkpoints/one.jsonl --b checkpoints/two.jsonl
 *
 * Two agents measured against the same opponent on the same seeds have not been
 * measured independently — pair *i* dealt the same libraries in both runs. Reading
 * their two confidence intervals and checking whether they overlap throws that away,
 * and throws away most of the sensitivity with it: overlapping intervals routinely
 * hide a real difference, because each interval carries the variance of the whole
 * matchup while the difference between them carries only the variance of the
 * disagreement.
 *
 * So this pairs them properly. It is the same trick as the mirror pairing inside a
 * single run (DESIGN-AI.md 5.3), applied one level up — and it is the difference
 * between "these two runs scored 61.0% and 64.3%, who knows" and a straight answer
 * about whether the second agent is better than the first.
 */

const args = parseArgs(process.argv.slice(2));
if (!args.a || !args.b) {
  console.log(
    [
      'npm run ai:compare -- --a <checkpoint> --b <checkpoint>',
      '',
      '  Both runs must have used the same seed, the same opponent and the same',
      '  number of pairs, or the pairing is meaningless.',
    ].join('\n'),
  );
  process.exit(args.a || args.b ? 1 : 0);
}

/** Pair index -> that pair's score, for pairs where both halves were played. */
function load(path: string): Map<number, number> {
  const byPair = new Map<number, number[]>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as MatchOutcome;
      if (!byPair.has(o.pair)) byPair.set(o.pair, []);
      byPair.get(o.pair)!.push(o.aScore);
    } catch {
      // A torn last line from a run that was killed mid-write.
    }
  }
  const out = new Map<number, number>();
  for (const [pair, scores] of byPair) {
    if (scores.length === 2) out.set(pair, (scores[0] + scores[1]) / 2);
  }
  return out;
}

const first = load(args.a);
const second = load(args.b);
const shared = [...second.keys()].filter((p) => first.has(p)).sort((x, y) => x - y);

if (shared.length < 2) {
  console.error('The two runs share fewer than two complete pairs — nothing to compare.');
  process.exit(1);
}

const diffs = shared.map((p) => second.get(p)! - first.get(p)!);
const n = diffs.length;
const mean = diffs.reduce((x, y) => x + y, 0) / n;
const variance = diffs.reduce((acc, d) => acc + (d - mean) ** 2, 0) / (n - 1);
const se = Math.sqrt(variance / n);
const lo = mean - 1.959964 * se;
const hi = mean + 1.959964 * se;

const rateFirst = shared.reduce((acc, p) => acc + first.get(p)!, 0) / n;
const rateSecond = shared.reduce((acc, p) => acc + second.get(p)!, 0) / n;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const signed = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
const elo = (x: number) => `${Math.round(eloFromScore(x, n * 2)) >= 0 ? '+' : ''}${Math.round(eloFromScore(x, n * 2))}`;

console.log(`Paired over ${n} mirror pairs both runs played.\n`);
console.log(`  A  ${args.a}`);
console.log(`     ${pct(rateFirst)}   ${elo(rateFirst)} Elo`);
console.log(`  B  ${args.b}`);
console.log(`     ${pct(rateSecond)}   ${elo(rateSecond)} Elo\n`);
console.log(`  B minus A:  ${signed(mean)} points   95% CI ${signed(lo)} … ${signed(hi)}`);
console.log(
  lo > 0
    ? '  SIGNIFICANT: B is stronger.'
    : hi < 0
      ? '  SIGNIFICANT: A is stronger.'
      : '  NOT SIGNIFICANT: this run cannot tell them apart.',
);

const disagreed = diffs.filter((d) => d !== 0).length;
console.log(
  `\n  they reached a different result in ${disagreed} of ${n} pairs` +
    ` (B won ${diffs.filter((d) => d > 0).length}, A won ${diffs.filter((d) => d < 0).length})`,
);

/*
 * How many pairs it would take to resolve the difference actually seen, so that
 * "not significant" comes with the price of finding out rather than just a shrug.
 */
if (lo <= 0 && hi >= 0 && Math.abs(mean) > 1e-9) {
  const needed = Math.ceil(n * (1.959964 * se / Math.abs(mean)) ** 2);
  console.log(
    `  to resolve a difference this size would take about ${needed} pairs` +
      ` (${needed * 2} games) — this run had ${n}.`,
  );
}
