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
    for (const agent of [new HeuristicAgent(), new RandomAgent(1), new PimcAgent()]) {
      expect(seesTruth(agent as Agent)).toBe(false);
    }
  });

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
  it('plays a different game from the same search guessing', () => {
    const withTruth = playGame({
      p1: new OracleAgent(),
      p2: new HeuristicAgent(),
      seed: 62001,
      budgetMs: 60_000,
    });
    const guessing = playGame({
      p1: new PimcAgent({ determinizations: 1 }),
      p2: new HeuristicAgent(),
      seed: 62001,
      budgetMs: 60_000,
    });
    expect(JSON.stringify(withTruth.actions)).not.toBe(JSON.stringify(guessing.actions));
  }, 60_000);

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
