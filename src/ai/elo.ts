/**
 * Turning a pile of games into a number you are allowed to believe.
 *
 * This deck has enormous variance — it either assembles a two-card combo or it does
 * not — so the usual "it won 55% of 200 games, it is better" is worth nothing here.
 * Two things fix that, and both are requirements rather than refinements
 * (DESIGN-AI.md 5.3):
 *
 *  - **Mirror pairs.** Every seed is played twice, once with each agent on the play.
 *    Being on the play is worth a great deal in a combo mirror, so pairing removes
 *    the largest single source of noise instead of averaging over it.
 *  - **The pair is the unit.** The two games of a pair share a shuffle and are not
 *    independent, so a confidence interval computed over 2N games would be too
 *    narrow by roughly √2 and would call differences significant that are not. The
 *    statistics below are computed over pair scores.
 */

/** 95% of a normal distribution. */
const Z95 = 1.959964;

export interface SeriesSummary {
  games: number;
  pairs: number;
  wins: number;
  losses: number;
  draws: number;
  /** Unfinished games — the step guard tripped. Always a bug, never a result. */
  unfinished: number;
  /** Win rate for A, counting a draw as a half. */
  score: number;
  scoreLow: number;
  scoreHigh: number;
  elo: number;
  eloLow: number;
  eloHigh: number;
  /** True when the 95% interval excludes an even split. */
  significant: boolean;
}

/**
 * Elo difference implied by a score.
 *
 * A clean sweep implies an infinite gap, which is not a useful thing to print, so it
 * is reported as the gap a single unplayed loss would have shown instead — the
 * conventional way to keep a sweep on the same axis as everything else.
 */
export function eloFromScore(score: number, games: number): number {
  const n = Math.max(games, 1);
  const clamped = Math.min(Math.max(score, 0.5 / (n + 1)), 1 - 0.5 / (n + 1));
  return -400 * Math.log10(1 / clamped - 1);
}

/**
 * The Wilson score interval for a proportion, over `n` pairs scoring `s` in total.
 *
 * Not the textbook `mean ± z·sd/√n`, and the reason is the case that matters most:
 * a short run in which every pair went the same way. The sample standard deviation of
 * five identical results is zero, so that formula reports a zero-width interval and
 * calls five-for-five conclusive — which is exactly backwards, since five-for-five
 * happens by chance three times in a hundred. Wilson has no such degenerate case; it
 * gives three-for-three an interval of roughly 44%–100%, which correctly contains an
 * even split. It behaves at the other end too: it never runs past 0 or 1, and with a
 * thousand pairs it is indistinguishable from the normal interval.
 *
 * Pair scores of a half make this slightly conservative — a split pair varies less
 * than a coin flip does — and being told a result is less certain than it is, is the
 * error worth having.
 */
function wilson(successes: number, n: number): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z95 / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Aggregate a run. `pairScores` holds one entry per mirror pair; the raw counts are
 * only there to be printed.
 */
export function summarise(opts: {
  pairScores: number[];
  wins: number;
  losses: number;
  draws: number;
  unfinished: number;
}): SeriesSummary {
  const pairs = opts.pairScores.length;
  const games = opts.wins + opts.losses + opts.draws;
  const total = opts.pairScores.reduce((a, b) => a + b, 0);
  const mean = pairs > 0 ? total / pairs : 0.5;
  const { lo, hi } = wilson(total, pairs);

  return {
    games,
    pairs,
    wins: opts.wins,
    losses: opts.losses,
    draws: opts.draws,
    unfinished: opts.unfinished,
    score: mean,
    scoreLow: lo,
    scoreHigh: hi,
    elo: eloFromScore(mean, games),
    eloLow: eloFromScore(lo, games),
    eloHigh: eloFromScore(hi, games),
    significant: lo > 0.5 || hi < 0.5,
  };
}

export function formatSummary(a: string, b: string, s: SeriesSummary): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const signed = (x: number) => `${x >= 0 ? '+' : ''}${Math.round(x)}`;
  const lines = [
    `${a}  vs  ${b}`,
    `  ${s.games} games in ${s.pairs} mirror pairs — ${s.wins}W ${s.losses}L ${s.draws}D`,
    `  win rate  ${pct(s.score)}  (95% CI ${pct(s.scoreLow)} … ${pct(s.scoreHigh)})`,
    `  Elo       ${signed(s.elo)}  (95% CI ${signed(s.eloLow)} … ${signed(s.eloHigh)})`,
    s.significant
      ? `  significant at 95%: ${s.score > 0.5 ? a : b} is the stronger agent`
      : `  NOT significant — the interval still contains 50%, so this run decides nothing`,
  ];
  if (s.unfinished > 0) {
    lines.push(`  ${s.unfinished} game(s) hit the step guard without ending — investigate`);
  }
  return lines.join('\n');
}
