import { describe, expect, it } from 'vitest';
import { testGame } from './harness.js';
import type { Step } from '../types.js';

/**
 * CR 506.5 — with no attackers declared, the declare blockers and combat damage
 * steps do not happen at all.
 *
 * In this format that is nearly every turn: the deck wins by resolving a spell,
 * not by attacking. Two extra rounds of priority per turn with nothing legal to
 * do in them is the difference between a game that flows and one that is mostly
 * pressing pass.
 */

function stepsVisited(t: ReturnType<typeof testGame>, until: () => boolean): Step[] {
  const seen: Step[] = [];
  let guard = 0;
  while (!until() && t.state.winner === null && guard++ < 400) {
    if (t.state.step !== seen[seen.length - 1]) seen.push(t.state.step);
    if (t.game.state.pendingChoice) {
      t.auto();
      continue;
    }
    const p = t.state.priorityPlayer;
    if (!p) break;
    t.game.submitIntent(p, { t: 'passPriority' });
  }
  if (t.state.step !== seen[seen.length - 1]) seen.push(t.state.step);
  return seen;
}

describe('combat with nothing to attack with', () => {
  it('skips declare blockers and combat damage entirely', () => {
    const t = testGame();
    t.p1.hand('Island');
    t.begin();
    const seen = stepsVisited(t, () => t.state.phase === 'postcombat_main');
    expect(seen).toContain('begin_combat');
    expect(seen).toContain('declare_attackers');
    expect(seen).toContain('end_of_combat');
    expect(seen).not.toContain('declare_blockers');
    expect(seen).not.toContain('combat_damage');
    expect(t.state.phase).toBe('postcombat_main');
    t.assertCardConservation();
  });

  it('still runs the full combat when a creature does attack', () => {
    const t = testGame();
    const [horror] = t.p1.battlefield('Hullbreaker Horror');
    t.p2.battlefield('Atraxa, Grand Unifier');
    t.begin();
    t.passUntil('declare_attackers');
    t.answer({ kind: 'attackers', iids: [horror] }, 'p1');
    const seen = stepsVisited(t, () => t.state.phase === 'postcombat_main');
    expect(seen).toContain('declare_blockers');
    expect(seen).toContain('combat_damage');
    t.assertCardConservation();
  });

  it('leaves the rest of the turn intact', () => {
    // The skip must not eat the second main phase or the end step with it.
    const t = testGame();
    t.p1.hand('Island', 'Brainstorm');
    t.begin();
    t.passUntil('end_step');
    expect(t.state.step).toBe('end_step');
    expect(t.state.activePlayer).toBe('p1');
  });
});
