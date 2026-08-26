import { describe, expect, it } from 'vitest';
import { testGame, type TestGame } from './harness.js';

/** The mana a Mana Drain has promised, or null if it promised none. */
function drainedMana(t: TestGame): number | null {
  const d = t.state.delayed[0];
  return d && d.kind === 'manaDrain' ? d.amount : null;
}


/** DESIGN.md 15.2 (Omniscience) and 15.6 (Hullbreaker Horror). */

describe('Omniscience', () => {
  it('16. casting Dig Through Time for free skips the delve prompt entirely', () => {
    const t = testGame();
    t.p1.hand('Dig Through Time');
    t.p1.battlefield('Omniscience');
    t.p1.graveyard('Brainstorm', 'Brainstorm', 'Mana Drain');
    t.begin();

    t.p1.cast('Dig Through Time', { free: true });
    // No delve question at all — there is no cost left to reduce.
    expect(t.choice()).toBeNull();

    t.resolveStack();
    const c = t.expectChoice();
    expect(c.kind).toBe('chooseCards');
    if (c.kind === 'chooseCards') expect(c.prompt).toMatch(/into your hand/i);
    // Nothing was exiled from the graveyard.
    expect(t.p1.graveyardNames()).toHaveLength(3);
    expect(t.state.zones.p1.exile).toHaveLength(0);
  });

  it('16b. paying mana for Dig Through Time does prompt for delve', () => {
    const t = testGame();
    t.p1.hand('Dig Through Time');
    t.p1.manaBase(8);
    t.p1.graveyard('Brainstorm', 'Brainstorm', 'Mana Drain');
    t.begin();

    t.p1.cast('Dig Through Time');
    const c = t.expectChoice();
    expect(c.kind).toBe('chooseCards');
    if (c.kind === 'chooseCards') {
      expect(c.prompt).toMatch(/delve/i);
      // Never more than the generic part of the cost, which is 6 here.
      expect(c.max).toBe(3);
    }
  });

  it('17. hybrid costs are irrelevant when casting for free', () => {
    const t = testGame();
    t.p1.hand("Rakshasa's Bargain");
    t.p1.battlefield('Omniscience');
    t.begin();

    expect(t.p1.canCast("Rakshasa's Bargain")).toBe(true);
    t.p1.cast("Rakshasa's Bargain", { free: true });
    t.resolveStack();
    t.auto();
    // Two cards to hand, two to the graveyard.
    expect(t.p1.handSize()).toBe(2);
    expect(t.p1.graveyardNames()).toHaveLength(3);
  });

  it('18. lands are not spells, so Omniscience cannot put one onto the battlefield', () => {
    const t = testGame();
    t.p1.hand('Island');
    t.p1.battlefield('Omniscience');
    t.begin();

    const actions = t.game.legalActions('p1');
    const islandIid = t.p1.find('Island', 'hand');
    expect(actions.some((a) => a.intent.t === 'castSpell' && a.intent.iid === islandIid)).toBe(false);
    // Playing it as a land is still fine.
    expect(actions.some((a) => a.intent.t === 'playLand' && a.intent.iid === islandIid)).toBe(true);
  });

  it('21. losing Omniscience mid-sequence revokes the free cast immediately', () => {
    const t = testGame();
    t.p1.battlefield('Omniscience');
    t.p1.hand('Atraxa, Grand Unifier');
    t.p2.battlefield('Hullbreaker Horror');
    t.p2.hand('Brainstorm');
    t.p2.manaBase(1);
    t.begin();

    expect(t.p1.canCast('Atraxa, Grand Unifier')).toBe(true);

    // Pass to p2, who casts something and uses the Horror trigger on Omniscience.
    t.p1.pass();
    t.p2.cast('Brainstorm');
    // The Horror trigger is being put on the stack and asks for its mode now.
    t.chooseMode(1);
    const omni = t.p1.find('Omniscience', 'battlefield');
    t.targetIid(omni);
    t.resolveStack();
    t.auto();

    expect(t.p1.battlefieldNames()).not.toContain('Omniscience');
    expect(t.p1.handNames()).toContain('Omniscience');
    expect(t.p1.canCast('Atraxa, Grand Unifier')).toBe(false);
  });

  it('22. a free Mana Drain still counters and still produces its mana', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p1.battlefield('Omniscience');
    t.p1.hand('Mana Drain');
    t.p2.hand('Show and Tell');
    t.p2.manaBase(3);
    t.begin();

    t.p2.cast('Show and Tell');
    t.p2.pass();
    t.p1.cast('Mana Drain', { free: true });
    t.resolveStack();

    expect(t.p2.graveyardNames()).toContain('Show and Tell');
    expect(t.state.delayed).toHaveLength(1);
    expect(drainedMana(t)).toBe(3);
  });

  it('23. both players can be casting for free at once; the active player acts first', () => {
    const t = testGame();
    t.p1.battlefield('Omniscience');
    t.p2.battlefield('Omniscience');
    t.p1.hand('Brainstorm');
    t.p2.hand('Brainstorm');
    t.begin();

    expect(t.p1.canCast('Brainstorm')).toBe(true);
    expect(t.state.priorityPlayer).toBe('p1');
    // p2 does not hold priority yet, so nothing is offered to them.
    expect(t.game.legalActions('p2')).toHaveLength(0);
  });

  it('24. holding priority lets a free cast chain without giving the opponent a window', () => {
    const t = testGame();
    t.p1.battlefield('Omniscience');
    t.p1.hand('Brainstorm', 'Mana Drain');
    t.begin();

    t.p1.cast('Brainstorm', { free: true, hold: true });
    expect(t.state.priorityPlayer).toBe('p1');
    expect(t.state.stack).toHaveLength(1);
    // Mana Drain has no legal target (only your own spell is on the stack).
    expect(t.p1.canCast('Mana Drain')).toBe(false);
  });

  it('rejects a free cast when no Omniscience is on the battlefield', () => {
    const t = testGame();
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.begin();
    const iid = t.p1.find('Brainstorm', 'hand');
    expect(() => t.game.submitIntent('p1', { t: 'castSpell', iid, free: true })).toThrow(
      /illegal intent/i,
    );
  });
});

describe('Hullbreaker Horror', () => {
  it('61. casting the Horror itself does not trigger it', () => {
    const t = testGame();
    t.p1.hand('Hullbreaker Horror');
    t.p1.manaBase(7);
    t.begin();

    t.p1.cast('Hullbreaker Horror');
    expect(t.stackNames()).toEqual(['Hullbreaker Horror']);
    expect(t.state.pendingTriggers).toHaveLength(0);
    t.resolveStack();
    expect(t.p1.battlefieldNames()).toContain('Hullbreaker Horror');
  });

  it('62. "choose up to one" allows choosing nothing', () => {
    const t = testGame();
    t.p1.battlefield('Hullbreaker Horror');
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.begin();

    t.p1.cast('Brainstorm');
    const c = t.expectChoice();
    expect(c.kind).toBe('chooseMode');
    if (c.kind === 'chooseMode') expect(c.min).toBe(0);
    t.chooseMode();
    t.resolveAll();
    expect(t.p1.battlefieldNames()).toContain('Hullbreaker Horror');
  });

  it('63. bouncing a spell off the stack stops it resolving, and is not countering', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Show and Tell');
    t.p2.manaBase(3);
    t.p1.battlefield('Hullbreaker Horror');
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.begin();

    t.p2.cast('Show and Tell');
    t.p2.pass();
    t.p1.cast('Brainstorm');
    t.chooseMode(0);
    t.resolveAll();

    // Back to hand, not to the graveyard: it was never countered.
    expect(t.p2.handNames()).toContain('Show and Tell');
    expect(t.p2.graveyardNames()).not.toContain('Show and Tell');
  });

  it('66. Mana Drain cannot counter the Horror', () => {
    const t = testGame();
    t.p1.hand('Hullbreaker Horror');
    t.p1.manaBase(7);
    t.p2.hand('Mana Drain');
    t.p2.manaBase(2);
    t.begin();

    t.p1.cast('Hullbreaker Horror');
    t.p1.pass();
    t.p2.cast('Mana Drain');
    t.resolveAll();

    expect(t.p1.battlefieldNames()).toContain('Hullbreaker Horror');
    // Ruling: the target was legal, it just could not be countered — so the mana
    // still arrives.
    expect(drainedMana(t)).toBe(7);
  });

  it('67. every free cast under Omniscience triggers the Horror separately', () => {
    const t = testGame();
    t.p1.battlefield('Hullbreaker Horror', 'Omniscience');
    t.p1.hand('Brainstorm', 'Brainstorm', 'Brainstorm');
    t.begin();

    let triggers = 0;
    for (let i = 0; i < 3; i++) {
      t.p1.cast('Brainstorm', { free: true, hold: true });
      const c = t.expectChoice();
      expect(c.kind).toBe('chooseMode');
      triggers++;
      t.chooseMode();
    }
    expect(triggers).toBe(3);
    expect(t.state.stack.filter((iid) => !t.state.cards[iid].isAbility)).toHaveLength(3);
  });

  it('69. the Horror can bounce an opposing Omniscience', () => {
    const t = testGame();
    t.p1.battlefield('Hullbreaker Horror');
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.p2.battlefield('Omniscience');
    t.begin();

    t.p1.cast('Brainstorm');
    t.chooseMode(1);
    t.targetIid(t.p2.find('Omniscience', 'battlefield'));
    t.resolveAll();

    expect(t.p2.battlefieldNames()).not.toContain('Omniscience');
    expect(t.p2.handNames()).toContain('Omniscience');
  });

  it('70. a Horror arriving via Show and Tell is live from the next spell onward', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Hullbreaker Horror', 'Brainstorm');
    t.p1.manaBase(4);
    t.p2.hand('Omniscience');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();
    t.secret('p1', 'Hullbreaker Horror');
    t.secret('p2', 'Omniscience');
    t.auto();

    expect(t.p1.battlefieldNames()).toContain('Hullbreaker Horror');
    t.p1.cast('Brainstorm');
    const c = t.expectChoice();
    expect(c.kind).toBe('chooseMode');
  });
});
