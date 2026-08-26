import { nextInt, type RngState } from '../engine/rng.js';

/**
 * Solving a small two-player zero-sum matrix game.
 *
 * This exists for one node in the whole game, and it is worth a file because that
 * node is the format (DESIGN-AI.md 13.1). The Show and Tell choice is made by both
 * players in secret and revealed together — which makes it a matrix game rather than
 * a decision, and matrix games are the one place where "play the best response"
 * is provably the wrong algorithm. A player who always shows Omniscience is a player
 * whose opponent knows what is coming; the unexploitable answer is a *mixture*, and a
 * mixture is not something a scoring function can produce by taking an argmax.
 *
 * It is also the cheapest win available anywhere in this project: the matrix is five
 * by five at most, it is the single most important decision in the game, and it can
 * be solved rather than approximated.
 */

export interface MatrixSolution {
  /** Probability of each row option. Sums to one. */
  rowStrategy: number[];
  /** The same for the column player. */
  colStrategy: number[];
  /** The game's value to the row player. */
  value: number;
}

/**
 * Fictitious play: both players repeatedly best-respond to the average of what the
 * other has done so far.
 *
 * Chosen over a linear program because it is thirty lines instead of a simplex
 * implementation, has no failure modes on degenerate input, and converges to a Nash
 * equilibrium for zero-sum games (Robinson, 1951). Convergence is slow in the tail —
 * error falls off like 1/√n — but on a five by five matrix, thousands of iterations
 * cost microseconds, and the answer only has to be better than "always the same
 * pick", which it is after about ten.
 */
export function solveMatrix(payoff: number[][], iterations = 5000): MatrixSolution {
  const rows = payoff.length;
  const cols = rows > 0 ? payoff[0].length : 0;
  if (rows === 0 || cols === 0) {
    return { rowStrategy: [], colStrategy: [], value: 0 };
  }
  if (rows === 1 && cols === 1) {
    return { rowStrategy: [1], colStrategy: [1], value: payoff[0][0] };
  }

  // How often each option has been played, and the running payoff of each option
  // against everything the other side has played.
  const rowCounts = new Array<number>(rows).fill(0);
  const colCounts = new Array<number>(cols).fill(0);
  const rowPayoff = new Array<number>(rows).fill(0);
  const colPayoff = new Array<number>(cols).fill(0);

  // Seed the loop with the row player's first move, so the column player has
  // something to respond to.
  let rowChoice = argmax(payoff.map((r) => average(r)));
  rowCounts[rowChoice]++;
  for (let c = 0; c < cols; c++) colPayoff[c] += payoff[rowChoice][c];

  for (let i = 0; i < iterations; i++) {
    // The column player minimises the row player's payoff.
    const colChoice = argmin(colPayoff);
    colCounts[colChoice]++;
    for (let r = 0; r < rows; r++) rowPayoff[r] += payoff[r][colChoice];

    rowChoice = argmax(rowPayoff);
    rowCounts[rowChoice]++;
    for (let c = 0; c < cols; c++) colPayoff[c] += payoff[rowChoice][c];
  }

  const rowStrategy = normalise(rowCounts);
  const colStrategy = normalise(colCounts);

  let value = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) value += rowStrategy[r] * colStrategy[c] * payoff[r][c];
  }
  return { rowStrategy, colStrategy, value };
}

/**
 * Draw one option from a mixed strategy.
 *
 * Deliberate randomness, and the only randomness in any agent here. It is not the
 * noise §15 warns against — that is a strong agent made to play badly on purpose.
 * This is a strong agent refusing to be predictable at the one node where being
 * predictable is what loses.
 */
export function sampleStrategy(strategy: number[], rng: RngState): number {
  if (strategy.length === 0) return -1;
  // Integer arithmetic, so that a sampled strategy is exactly reproducible from a
  // seed the way everything else in this engine is.
  const scale = 1_000_000;
  const weights = strategy.map((p) => Math.max(0, Math.round(p * scale)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let roll = nextInt(rng, total);
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

function average(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function argmax(xs: number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return best;
}

function argmin(xs: number[]): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] < xs[best]) best = i;
  return best;
}

function normalise(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 1 / counts.length);
  return counts.map((c) => c / total);
}
