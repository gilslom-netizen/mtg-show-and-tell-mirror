import { describe, expect, it } from 'vitest';
import { testGame } from '../../engine/__tests__/harness.js';
import type { PlayerId } from '../../engine/types.js';
import { playGameDetailed } from '../arena.js';
import { EVAL_WEIGHTS, sigmoid, winProbability } from '../evaluate.js';
import { extractFeatures, FEATURE_COUNT, newFeatureBuffer } from '../features.js';
import { collectSamples, fitLogistic } from '../fit.js';
import { HeuristicAgent } from '../heuristic.js';

describe('the fitted evaluation', () => {
  it('reads a finished game rather than estimating it', () => {
    const t = testGame();
    t.begin();
    t.state.winner = 'p1';
    expect(winProbability(t.state, 'p1')).toBe(1);
    expect(winProbability(t.state, 'p2')).toBe(0);
    t.state.winner = 'draw';
    expect(winProbability(t.state, 'p1')).toBe(0.5);
  });

  it('is symmetrical: two seats cannot both be winning', () => {
    const { game } = playGameDetailed({
      p1: new HeuristicAgent(),
      p2: new HeuristicAgent(),
      seed: 71001,
      onDecision: (g) => {
        if (g.state.turn !== 6) return;
        const a = winProbability(g.state, 'p1');
        const b = winProbability(g.state, 'p2');
        // Not exactly 1 by construction — the features are not perfectly
        // antisymmetric — but a evaluation that thought both seats were favourites
        // would be useless as a comparison between them.
        expect(a + b).toBeGreaterThan(0.5);
        expect(a + b).toBeLessThan(1.5);
      },
    });
    expect(game.state.winner).not.toBeNull();
  });

  it('stays a probability whatever it is shown', () => {
    const t = testGame();
    t.p1.manaBase(6);
    t.p1.hand('Show and Tell', 'Omniscience', 'Atraxa, Grand Unifier');
    t.p2.librarySize(0);
    t.state.players.p2.life = 1;
    t.begin();
    for (const seat of ['p1', 'p2'] as PlayerId[]) {
      const p = winProbability(t.state, seat);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      expect(Number.isFinite(p)).toBe(true);
    }
  });

  it('never overflows on an extreme input', () => {
    expect(sigmoid(10_000)).toBe(1);
    expect(sigmoid(-10_000)).toBe(0);
    expect(sigmoid(0)).toBeCloseTo(0.5, 12);
  });

  it('has one weight per feature', () => {
    expect(EVAL_WEIGHTS).toHaveLength(FEATURE_COUNT);
    expect(EVAL_WEIGHTS.every((w) => Number.isFinite(w))).toBe(true);
    // All-zero weights are the unfitted placeholder, which would silently turn every
    // truncated playout into a coin flip.
    expect(EVAL_WEIGHTS.some((w) => w !== 0)).toBe(true);
  });

  it('extracts the same features for a position however often it is asked', () => {
    const t = testGame();
    t.p1.manaBase(3);
    t.p1.hand('Show and Tell', 'Omniscience');
    t.begin();
    const a = newFeatureBuffer();
    const b = newFeatureBuffer();
    extractFeatures(t.state, 'p1', a);
    extractFeatures(t.state, 'p1', b);
    expect([...a]).toEqual([...b]);
    // And the two seats see different positions, or nothing here means anything.
    extractFeatures(t.state, 'p2', b);
    expect([...a]).not.toEqual([...b]);
  });

  /**
   * The claim the weights rest on, checked end to end on a fresh sample: a fit
   * against real outcomes predicts real outcomes better than guessing.
   *
   * This is the test that would fail if the labels got shuffled, if the features
   * stopped describing the position, or if the held-out split stopped being held out
   * — and none of those would show up anywhere else until an agent started playing
   * badly for reasons nobody could see.
   */
  it('predicts held-out outcomes better than a coin flip', () => {
    const samples = collectSamples({ games: 60, every: 12, seed: 91000 });
    expect(samples.length).toBeGreaterThan(1500);

    const fit = fitLogistic(samples, { steps: 1500 });
    expect(fit.testSamples).toBeGreaterThan(200);
    expect(fit.testLogLoss).toBeLessThan(fit.baselineLogLoss);
    expect(fit.testAccuracy).toBeGreaterThan(0.6);
  }, 120_000);

  /**
   * Fitting on shuffled labels must produce something no better than a coin flip.
   * If it does not, the pipeline is finding signal that is not there — which is what
   * a leak between the training and held-out sets looks like from the outside.
   */
  it('learns nothing from labels that mean nothing', () => {
    const samples = collectSamples({ games: 40, every: 12, seed: 92000 });
    const shuffled = samples.map((s, i) => ({ ...s, label: i % 2 }));
    const fit = fitLogistic(shuffled, { steps: 1500 });
    expect(fit.testAccuracy).toBeLessThan(0.6);
    expect(fit.testLogLoss).toBeGreaterThan(0.6);
  }, 120_000);
});
