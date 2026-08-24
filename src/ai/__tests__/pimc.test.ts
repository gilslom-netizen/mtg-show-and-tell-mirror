import { describe, expect, it } from 'vitest';
import { testGame } from '../../engine/__tests__/harness.js';
import { redact } from '../../engine/redact.js';
import { seedRng } from '../../engine/rng.js';
import type { Agent } from '../agent.js';
import { playGame } from '../arena.js';
import { HeuristicAgent } from '../heuristic.js';
import { sampleStrategy, solveMatrix } from '../matrix.js';
import { PimcAgent } from '../pimc.js';
import { RandomAgent } from '../random.js';
import { showAndTellStrategy } from '../showandtell.js';

/**
 * Two-player zero-sum matrix games with answers known in advance, so the solver is
 * checked against arithmetic rather than against itself.
 */
describe('solving a matrix game', () => {
  it('mixes evenly on matching pennies', () => {
    const { rowStrategy, colStrategy, value } = solveMatrix([
      [1, -1],
      [-1, 1],
    ]);
    expect(rowStrategy[0]).toBeCloseTo(0.5, 1);
    expect(colStrategy[0]).toBeCloseTo(0.5, 1);
    expect(value).toBeCloseTo(0, 1);
  });

  it('mixes evenly on rock paper scissors', () => {
    const { rowStrategy, value } = solveMatrix([
      [0, -1, 1],
      [1, 0, -1],
      [-1, 1, 0],
    ]);
    for (const p of rowStrategy) expect(p).toBeCloseTo(1 / 3, 1);
    expect(value).toBeCloseTo(0, 1);
  });

  it('plays a dominant option every time, and never a dominated one', () => {
    // Row 1 beats row 0 against every column, so a solution never touches row 0.
    const { rowStrategy } = solveMatrix([
      [0, 0],
      [1, 2],
    ]);
    expect(rowStrategy[1]).toBeCloseTo(1, 2);
    expect(rowStrategy[0]).toBeCloseTo(0, 2);
  });

  it('finds a saddle point when there is one', () => {
    // Row 0 / column 0 is a pure equilibrium worth 3.
    const { rowStrategy, colStrategy, value } = solveMatrix([
      [3, 5],
      [1, 4],
    ]);
    expect(rowStrategy[0]).toBeCloseTo(1, 2);
    expect(colStrategy[0]).toBeCloseTo(1, 2);
    expect(value).toBeCloseTo(3, 1);
  });

  it('samples a mixed strategy in proportion, and reproducibly', () => {
    const counts = [0, 0, 0];
    const rng = seedRng(4);
    for (let i = 0; i < 3000; i++) counts[sampleStrategy([0.5, 0.3, 0.2], rng)]++;
    expect(counts[0] / 3000).toBeCloseTo(0.5, 1);
    expect(counts[1] / 3000).toBeCloseTo(0.3, 1);
    expect(counts[2] / 3000).toBeCloseTo(0.2, 1);

    const a = seedRng(9);
    const b = seedRng(9);
    expect(sampleStrategy([0.5, 0.5], a)).toBe(sampleStrategy([0.5, 0.5], b));
  });
});

/**
 * The Show and Tell choice. The point of solving it rather than scoring it is that
 * the answer is a distribution — so the test that matters is that it is not always
 * the same answer, while still being the right answer most of the time.
 */
describe('the Show and Tell matrix', () => {
  /** Ask the same position many times and count what comes back. */
  const picks = (hand: string[], samples = 200): Record<string, number> => {
    const t = testGame();
    t.p1.hand('Show and Tell', ...hand);
    t.p1.manaBase(3);
    t.p2.hand('Atraxa, Grand Unifier', 'Omniscience', 'Brainstorm');
    t.p2.manaBase(3);
    t.begin();
    t.p1.cast('Show and Tell');
    t.resolveStack();

    const view = redact(t.state, 'p1');
    if (view.choice?.kind !== 'simultaneousSecret') throw new Error('expected the secret choice');

    const counts: Record<string, number> = {};
    const rng = seedRng(11);
    for (let i = 0; i < samples; i++) {
      const response = showAndTellStrategy(view, view.choice, rng);
      if (response.kind !== 'secret') throw new Error('expected a secret response');
      const name = response.iid === null ? 'nothing' : t.state.cards[response.iid].oracleId;
      counts[name] = (counts[name] ?? 0) + 1;
    }
    return counts;
  };

  it('never picks something the engine would refuse', () => {
    const counts = picks(['Omniscience', 'Atraxa, Grand Unifier', 'Brainstorm', 'Island']);
    // Brainstorm is an instant: Show and Tell cannot put it onto the battlefield.
    expect(counts.brainstorm).toBeUndefined();
  });

  it('favours Omniscience when there is a hand waiting behind it', () => {
    const counts = picks([
      'Omniscience',
      'Atraxa, Grand Unifier',
      'Brainstorm',
      'Dig Through Time',
      'Mana Drain',
    ]);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect((counts.omniscience ?? 0) / total).toBeGreaterThan(0.5);
  });

  it('always returns something the choice actually offered', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Omniscience', 'Atraxa, Grand Unifier', 'Brainstorm');
    t.p1.manaBase(3);
    t.p2.hand('Brainstorm');
    t.begin();
    t.p1.cast('Show and Tell');
    t.resolveStack();

    const view = redact(t.state, 'p1');
    if (view.choice?.kind !== 'simultaneousSecret') throw new Error('expected the secret choice');
    const legal = new Set(
      view.choice.myOptions.filter((o) => !o.disabledReason).map((o) => o.iid),
    );

    const rng = seedRng(3);
    for (let i = 0; i < 100; i++) {
      const response = showAndTellStrategy(view, view.choice, rng);
      if (response.kind !== 'secret') throw new Error('expected a secret response');
      if (response.iid !== null) expect(legal.has(response.iid)).toBe(true);
    }
  });

  /**
   * A finding rather than a requirement, and worth pinning down because it is not
   * what §13.1 expects.
   *
   * Solving a matrix game only produces a mixture when the payoffs genuinely
   * interact — when what is worth showing depends on what they show. The stage 2
   * payoff model is very nearly *separable*: my Omniscience is worth what my hand is
   * worth almost regardless of what lands opposite it, because with a live hand I
   * combo off on my own turn and their permanent never gets to do anything. A
   * separable matrix has a dominant row, and a dominant row is a pure strategy.
   *
   * So the machinery here is right and currently unexercised. What would make it
   * bite is a payoff that knows what happens when the combo turn *fizzles* into a
   * seven-power flier — which is exactly the judgement §10's value head is for, and
   * is not something worth inventing numbers for now.
   */
  it('is currently a pure strategy, because these payoffs barely interact', () => {
    const counts = picks([
      'Omniscience',
      'Atraxa, Grand Unifier',
      'Hullbreaker Horror',
      'Brainstorm',
    ]);
    expect(Object.keys(counts)).toEqual(['omniscience']);
  });
});

/*
 * Every test below plays real games with a real search in them, and a playout is
 * about a tenth of a second. They are given a minute each — not because they take
 * one, but because the default twenty seconds is close enough to what they do take
 * that a warm laptop turns a passing test into a failing one.
 */
const SLOW = 60_000;

describe('the PIMC agent', () => {
  const smallGame = (seed: number, dets = 2) => {
    const pimc = new PimcAgent({ determinizations: dets, seed: 3 });
    const record = playGame({
      p1: pimc,
      p2: new HeuristicAgent(),
      seed,
      // One determinization's worth of thinking: enough that search happens and is
      // observable, not enough to make the suite a benchmark.
      budgetMs: 120,
    });
    return { record, stats: pimc.stats };
  };

  it(
    'plays a legal game through to a real ending',
    () => {
      const { record } = smallGame(52001);
      expect(record.unfinished).toBe(false);
      expect(record.winner).not.toBeNull();
      expect(record.reason).toBeTruthy();
    },
    SLOW,
  );

  it(
    'rebuilds every position it searches',
    () => {
      const { stats } = smallGame(52002);
      expect(stats.searched).toBeGreaterThan(0);
      // A single failed reconstruction would mean it searched a board that was not
      // the one it was looking at — or, here, correctly declined to.
      expect(stats.unfaithful).toBe(0);
    },
    SLOW,
  );

  /**
   * §9.4 in one assertion. The measured median branching factor is two and most of
   * those are "pass, or tap a land"; if search fired on all of them it would cost
   * fifty times what it does and buy nothing.
   */
  it(
    'spends its playouts on the few decisions that are decisions',
    () => {
      const { stats } = smallGame(52003);
      expect(stats.searched).toBeLessThan(stats.decisions * 0.35);
      expect(stats.playouts).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    'is reproducible from its seed',
    () => {
      const once = smallGame(52004);
      const twice = smallGame(52004);
      expect(twice.record.winner).toBe(once.record.winner);
      expect(JSON.stringify(twice.record.actions)).toBe(JSON.stringify(once.record.actions));
    },
    SLOW,
  );

  it('falls back to the heuristic where a position cannot be searched', () => {
    // Every choice — a mulligan, a Brainstorm, a target — arrives mid-resolution,
    // which is exactly where determinization refuses. Those must still be answered.
    const agent: Agent = new PimcAgent({ determinizations: 1, seed: 5 });
    const heuristic: Agent = new HeuristicAgent();
    let compared = 0;
    playGame({
      p1: agent,
      p2: new RandomAgent(2),
      seed: 52005,
      budgetMs: 50,
      onDecision: (game, seat, kind) => {
        if (kind !== 'choice' || seat !== 'p1' || compared >= 25) return;
        const view = redact(game.state, seat);
        if (!view.choice || view.choice.kind === 'simultaneousSecret') return;
        // Everything but the matrix game is the heuristic's answer, verbatim.
        expect(JSON.stringify(agent.respond(view, view.choice, 50))).toBe(
          JSON.stringify(heuristic.respond(view, view.choice, 50)),
        );
        compared++;
      },
    });
    expect(compared).toBeGreaterThan(5);
  }, SLOW);

  it(
    'answers the mirror without ever hanging',
    () => {
      const a = new PimcAgent({ determinizations: 1, seed: 1 });
      const b = new PimcAgent({ determinizations: 1, seed: 2 });
      const record = playGame({ p1: a, p2: b, seed: 52006, budgetMs: 200 });
      expect(record.unfinished).toBe(false);
    },
    180_000,
  );
});
