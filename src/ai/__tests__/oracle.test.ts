import { describe, expect, it } from 'vitest';
import { redact } from '../../engine/redact.js';
import { seesTruth, type Agent } from '../agent.js';
import { playGame } from '../arena.js';
import { HeuristicAgent } from '../heuristic.js';
import { OracleAgent } from '../oracle-agent.js';
import { PimcAgent } from '../pimc.js';
import { RandomAgent } from '../random.js';

/**
 * The measuring instrument, and the hole it needs.
 *
 * An agent that is supposed to cheat and silently does not would produce a number
 * that looks like "perfect information is worth nothing" — the most misleading
 * possible result, and one nothing else would catch. So the first thing to check is
 * that it really is being handed the truth.
 */
describe('the oracle agent', () => {
  it('is the only agent that asks to see the state', () => {
    expect(seesTruth(new OracleAgent())).toBe(true);
    expect(seesTruth(new OracleAgent({ knows: 'hands' }))).toBe(true);
    for (const agent of [new HeuristicAgent(), new RandomAgent(1), new PimcAgent()]) {
      expect(seesTruth(agent as Agent)).toBe(false);
    }
  });

  /**
   * The distinction the whole decision rests on. Knowing the hands is knowledge that
   * a belief model could in principle recover; knowing the order of a shuffled
   * library is not knowledge at all, it is the future. An instrument that conflated
   * them would report chance as though it were something worth building for.
   */
  it('knows the hands but not the shuffle, in hands mode', () => {
    const oracle = new OracleAgent({ knows: 'hands', determinizations: 2 });
    let checked = 0;
    playGame({
      p1: oracle,
      p2: new HeuristicAgent(),
      seed: 61003,
      budgetMs: 60_000,
      onDecision: (game, seat, kind) => {
        if (kind !== 'priority' || seat !== 'p1' || checked > 40) return;
        checked++;
        // Whatever board it plays forward from, the hands are the real ones.
        const before = game.state.zones.p2.hand.map((i) => game.state.cards[i].oracleId);
        oracle.observeTruth(game.state);
        const after = game.state.zones.p2.hand.map((i) => game.state.cards[i].oracleId);
        expect(after).toEqual(before);
      },
    });
    expect(checked).toBeGreaterThan(10);
    // And it never mutated the real game while reshuffling its own copy of it.
    expect(oracle.stats.blind).toBe(0);
  }, 60_000);

  it('is actually handed the truth, and uses it', () => {
    const oracle = new OracleAgent();
    playGame({ p1: oracle, p2: new HeuristicAgent(), seed: 61001, budgetMs: 60_000 });
    expect(oracle.stats.searched).toBeGreaterThan(0);
    // Every decision it searched, it searched with the real board — never fell back.
    expect(oracle.stats.blind).toBe(0);
    expect(oracle.stats.playouts).toBeGreaterThan(0);
  }, 60_000);

  /**
   * That it plays *differently* from the same search guessing.
   *
   * Whether it plays *better* is the measurement, and a measurement is what the
   * arena is for — six games cannot say. What a test can say cheaply is that the
   * two agents diverge at all, which is what a hole that had quietly stopped being
   * wired up would hide behind an answer of "perfect information is worth nothing".
   */
  /*
   * Over several seeds, not one.
   *
   * This used to assert divergence on a single game, which is a claim about that
   * shuffle rather than about the agent: two agents playing the same deck agree
   * often enough that any change to the format — a free mulligan, say — can land
   * on a seed where they happen to play identically, and the test then fails for a
   * reason that has nothing to do with what it is testing. Same lesson as the
   * Wilson interval in the arena: the answer is more games.
   */
  it('plays a different game from the same search guessing', () => {
    const seeds = [62001, 62002, 62003, 62004];
    const differ = seeds.filter((seed) => {
      const withTruth = playGame({
        p1: new OracleAgent(),
        p2: new HeuristicAgent(),
        seed,
        budgetMs: 60_000,
      });
      const guessing = playGame({
        p1: new PimcAgent({ determinizations: 1 }),
        p2: new HeuristicAgent(),
        seed,
        budgetMs: 60_000,
      });
      return JSON.stringify(withTruth.actions) !== JSON.stringify(guessing.actions);
    });
    // Most of them, and never none: knowing the hand has to reach the decisions.
    expect(differ.length).toBeGreaterThanOrEqual(seeds.length - 1);
  }, 120_000);

  it('never sees the truth through the view, only through the hole', () => {
    // Belt and braces on ע1: the view handed to the oracle is redacted like anyone
    // else's, and the cheating is confined to the one explicit channel.
    playGame({
      p1: new OracleAgent(),
      p2: new HeuristicAgent(),
      seed: 61002,
      budgetMs: 5,
      onDecision: (game, seat, kind) => {
        if (kind !== 'priority' || seat !== 'p1') return;
        const view = redact(game.state, seat);
        for (const iid of game.state.zones.p2.hand) {
          expect(view.cards[iid]).toBeUndefined();
        }
      },
    });
  }, 60_000);
});
