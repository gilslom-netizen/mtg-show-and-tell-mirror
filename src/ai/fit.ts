import type { PlayerId } from '../engine/types.js';
import { playGameDetailed } from './arena.js';
import { scoreFeatures, sigmoid } from './evaluate.js';
import { extractFeatures, FEATURE_COUNT, FEATURE_NAMES, newFeatureBuffer } from './features.js';
import { HeuristicAgent } from './heuristic.js';

/**
 * Fitting the evaluation against what actually happened.
 *
 * The training signal is the only one ע2 permits: did this seat go on to win. No
 * credit for damage, no credit for cards — the label is the outcome, and the weights
 * are whatever predicts it. That is what separates this from a hand-written
 * evaluation, which is a pile of opinions about what a good board looks like.
 */

export interface Sample {
  features: number[];
  /** 1 if the seat these features are from won the game, 0 if it lost. */
  label: number;
}

export interface FitOptions {
  games?: number;
  /** Sample a position every N priority decisions, so one game is not one position. */
  every?: number;
  seed?: number;
}

/**
 * Play games and record positions with the outcome that followed them.
 *
 * Positions come from heuristic self-play because that is exactly the distribution
 * the evaluation will be asked about: it is used to cut a rollout short, and a
 * rollout is heuristic self-play. Fitting on positions from some other distribution
 * — random play, say — would be fitting for a question nobody asks.
 */
export function collectSamples(opts: FitOptions = {}): Sample[] {
  const games = opts.games ?? 400;
  const every = opts.every ?? 12;
  const seed = opts.seed ?? 4242;
  const samples: Sample[] = [];

  for (let g = 0; g < games; g++) {
    const pending: { features: number[]; seat: PlayerId }[] = [];
    const buffer = newFeatureBuffer();
    let seen = 0;

    const { record } = playGameDetailed({
      p1: new HeuristicAgent(),
      p2: new HeuristicAgent(),
      seed: seed + g,
      startingPlayer: g % 2 === 0 ? 'p1' : 'p2',
      onDecision: (game, seat, kind) => {
        if (kind !== 'priority') return;
        if (seen++ % every !== 0) return;
        // The opening turns are all the same handful of positions and would swamp
        // the set with board states nobody needs an opinion about.
        if (game.state.turn < 2) return;
        extractFeatures(game.state, seat, buffer);
        pending.push({ features: [...buffer], seat });
      },
    });

    // A game the step guard stopped has no outcome, so its positions have no label.
    if (record.winner === null || record.winner === 'draw') continue;
    for (const p of pending) {
      samples.push({ features: p.features, label: p.seat === record.winner ? 1 : 0 });
    }
  }
  return samples;
}

export interface FitResult {
  weights: number[];
  /** Mean log loss on held-out samples. log(2) = 0.693 is a coin flip. */
  testLogLoss: number;
  /** How often the sign of the prediction was right, on held-out samples. */
  testAccuracy: number;
  trainSamples: number;
  testSamples: number;
  /** Log loss of always answering 0.5, for something to compare against. */
  baselineLogLoss: number;
}

/**
 * Logistic regression by gradient descent.
 *
 * Thirteen features and tens of thousands of samples: a closed-form solver would be
 * overkill and an optimiser dependency would be absurd. What matters is not the
 * optimiser but that a fifth of the samples are held out — an evaluation scored on
 * the positions it was fitted to would report whatever accuracy the feature count
 * allows, which is the classic way to convince yourself a model works.
 */
export function fitLogistic(
  samples: Sample[],
  opts: { steps?: number; learningRate?: number; l2?: number; holdout?: number } = {},
): FitResult {
  const steps = opts.steps ?? 4000;
  const rate = opts.learningRate ?? 0.5;
  const l2 = opts.l2 ?? 1e-4;
  const holdout = opts.holdout ?? 0.2;

  // Split by position in the list, which is by game: samples from one game are
  // correlated, and letting them straddle the split would leak the answer.
  const cut = Math.floor(samples.length * (1 - holdout));
  const train = samples.slice(0, cut);
  const test = samples.slice(cut);

  const weights = new Array<number>(FEATURE_COUNT).fill(0);
  const gradient = new Array<number>(FEATURE_COUNT).fill(0);

  for (let step = 0; step < steps; step++) {
    gradient.fill(0);
    for (const s of train) {
      let z = 0;
      for (let i = 0; i < FEATURE_COUNT; i++) z += s.features[i] * weights[i];
      const error = sigmoid(z) - s.label;
      for (let i = 0; i < FEATURE_COUNT; i++) gradient[i] += error * s.features[i];
    }
    for (let i = 0; i < FEATURE_COUNT; i++) {
      // The bias is not regularised: shrinking it would bias the whole prediction.
      const penalty = i === 0 ? 0 : l2 * weights[i];
      weights[i] -= rate * (gradient[i] / train.length + penalty);
    }
  }

  return {
    weights,
    ...score(test, weights),
    trainSamples: train.length,
    testSamples: test.length,
    baselineLogLoss: Math.log(2),
  };
}

function score(
  samples: Sample[],
  weights: number[],
): { testLogLoss: number; testAccuracy: number } {
  if (samples.length === 0) return { testLogLoss: NaN, testAccuracy: NaN };
  let loss = 0;
  let right = 0;
  for (const s of samples) {
    const p = Math.min(Math.max(scoreFeatures(s.features, weights), 1e-9), 1 - 1e-9);
    loss += -(s.label * Math.log(p) + (1 - s.label) * Math.log(1 - p));
    if ((p >= 0.5 ? 1 : 0) === s.label) right++;
  }
  return { testLogLoss: loss / samples.length, testAccuracy: right / samples.length };
}

export function formatFit(fit: FitResult): string {
  const lines = [
    `Fitted on ${fit.trainSamples} positions, held out ${fit.testSamples}.`,
    '',
    `  log loss   ${fit.testLogLoss.toFixed(4)}   (a coin flip is ${fit.baselineLogLoss.toFixed(4)})`,
    `  accuracy   ${(fit.testAccuracy * 100).toFixed(1)}%`,
    '',
    '  weights, largest first:',
  ];
  const ordered = fit.weights
    .map((w, i) => ({ name: FEATURE_NAMES[i], w }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  for (const { name, w } of ordered) {
    lines.push(`    ${name.padEnd(16)} ${w >= 0 ? ' ' : ''}${w.toFixed(4)}`);
  }
  lines.push('');
  lines.push('  paste into EVAL_WEIGHTS in src/ai/evaluate.ts, in FEATURE_NAMES order:');
  lines.push(
    `  [${fit.weights.map((w, i) => `\n    ${w.toFixed(4)}, // ${FEATURE_NAMES[i]}`).join('')}\n  ]`,
  );
  return lines.join('\n');
}
