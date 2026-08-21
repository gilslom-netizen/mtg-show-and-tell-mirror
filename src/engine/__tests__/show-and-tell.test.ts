import { describe, expect, it } from 'vitest';
import { testGame } from './harness.js';
import { redact } from '../redact.js';

/**
 * DESIGN.md 15.1 — Show and Tell.
 *
 * This is the format's defining card, and most of these are the tests that stop it
 * from being broken in a way nobody would notice from the outside.
 */

describe('Show and Tell', () => {
  it('1. both players put a permanent onto the battlefield', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Omniscience');
    t.p1.manaBase(3);
    t.p2.hand('Atraxa, Grand Unifier');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();

    t.secret('p1', 'Omniscience');
    t.secret('p2', 'Atraxa, Grand Unifier');
    t.auto();

    expect(t.p1.battlefieldNames()).toContain('Omniscience');
    expect(t.p2.battlefieldNames()).toContain('Atraxa, Grand Unifier');
    t.assertCardConservation();
  });

  it('2. the first player to lock in does not leak their choice', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Omniscience');
    t.p1.manaBase(3);
    t.p2.hand('Atraxa, Grand Unifier', 'Mana Drain');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();
    t.secret('p1', 'Omniscience');

    const view = redact(t.state, 'p2');
    expect(view.choice?.kind).toBe('simultaneousSecret');
    if (view.choice?.kind === 'simultaneousSecret') {
      expect(view.choice.opponentLockedIn).toBe(true);
      expect(view.choice.iHaveLockedIn).toBe(false);
      // p2 only ever sees their own options.
      const optionIds = view.choice.myOptions.map((o) => o.iid);
      expect(optionIds).toEqual(expect.arrayContaining(t.state.zones.p2.hand));
    }
    // No card object anywhere in the view is p1's pick.
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('"oracleId":"omniscience"');
    expect(Object.values(view.cards).some((c) => c.oracleId === 'omniscience')).toBe(false);
    // ...and p1's hand is not in there either.
    for (const iid of t.state.zones.p1.hand) {
      expect(view.cards[iid]).toBeUndefined();
    }
  });

  it('3. a player may choose to put nothing onto the battlefield', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Omniscience');
    t.p1.manaBase(3);
    t.p2.hand('Atraxa, Grand Unifier');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();
    t.secret('p1', null);
    t.secret('p2', 'Atraxa, Grand Unifier');
    t.auto();

    expect(t.p1.battlefieldNames()).not.toContain('Omniscience');
    expect(t.p2.battlefieldNames()).toContain('Atraxa, Grand Unifier');
  });

  it('4. both players may decline', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Omniscience');
    t.p1.manaBase(3);
    t.p2.hand('Atraxa, Grand Unifier');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();
    t.secret('p1', null);
    t.secret('p2', null);
    t.auto();

    expect(t.state.stack).toHaveLength(0);
    expect(t.p1.graveyardNames()).toEqual(['Show and Tell']);
  });

  it('5. a modal DFC in hand is only its front face, so it cannot be chosen', () => {
    // CR 712.8a. Waterlogged Teachings looks like a land because its back face is
    // one, but Show and Tell says "put onto the battlefield" without playing it.
    const t = testGame();
    t.p1.hand('Show and Tell', 'Waterlogged Teachings');
    t.p1.manaBase(3);
    t.p2.hand('Waterlogged Teachings');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();

    const reason = t.secretDisabledReason('p1', 'Waterlogged Teachings');
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/front face/i);
    expect(() => t.secret('p1', 'Waterlogged Teachings')).toThrow();
  });

  it('6. a hand of only instants and sorceries offers nothing selectable', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Brainstorm', 'Mana Drain');
    t.p1.manaBase(3);
    t.p2.hand('Dig Through Time');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();

    const c = t.expectChoice();
    expect(c.kind).toBe('simultaneousSecret');
    if (c.kind === 'simultaneousSecret') {
      expect(c.requests.p1.options.every((o) => o.disabledReason)).toBe(true);
      expect(c.requests.p2.options.every((o) => o.disabledReason)).toBe(true);
    }
  });

  it('7. a countered Show and Tell never asks for a choice', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Omniscience');
    t.p1.manaBase(3);
    t.p2.hand('Mana Drain');
    t.p2.manaBase(2);
    t.begin();

    t.p1.cast('Show and Tell');
    t.p1.pass();
    t.p2.cast('Mana Drain');
    t.resolveStack();

    expect(t.choice()).toBeNull();
    expect(t.p1.graveyardNames()).toContain('Show and Tell');
    expect(t.p1.battlefieldNames()).not.toContain('Omniscience');
  });

  it('8. two Atraxas under different controllers both stay — the legend rule is per player', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Atraxa, Grand Unifier');
    t.p1.manaBase(3);
    t.p2.hand('Atraxa, Grand Unifier');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();
    t.secret('p1', 'Atraxa, Grand Unifier');
    t.secret('p2', 'Atraxa, Grand Unifier');
    t.auto();

    expect(t.p1.battlefieldNames()).toContain('Atraxa, Grand Unifier');
    expect(t.p2.battlefieldNames()).toContain('Atraxa, Grand Unifier');
  });

  it('9. simultaneous ETB triggers are ordered APNAP, so the non-active player resolves first', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Atraxa, Grand Unifier');
    t.p1.manaBase(3);
    t.p2.hand('Atraxa, Grand Unifier');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();
    t.secret('p1', 'Atraxa, Grand Unifier');
    t.secret('p2', 'Atraxa, Grand Unifier');

    // Both ETB triggers are now on the stack. The active player's went on first,
    // so it is underneath and resolves last.
    expect(t.stackNames()).toHaveLength(2);
    t.resolveStack();
    const c = t.expectChoice();
    expect(c.kind).toBe('chooseCards');
    if (c.kind === 'chooseCards') expect(c.player).toBe('p2');
  });

  it('10. an entering land does not see the other card entering at the same time', () => {
    // Scryfall ruling on Mystic Sanctuary: it checks lands already on the battlefield.
    const t = testGame();
    t.p1.hand('Show and Tell', 'Mystic Sanctuary');
    t.p1.battlefield('Island', 'Breeding Pool', 'Watery Grave');
    t.p2.hand('Hallowed Fountain');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();
    t.secret('p1', 'Mystic Sanctuary');
    t.secret('p2', 'Hallowed Fountain');
    t.auto();

    // p1 already controlled three Islands (Island, Breeding Pool, Watery Grave),
    // so Mystic Sanctuary enters untapped. p2's Hallowed Fountain is irrelevant.
    const ms = t.p1.find('Mystic Sanctuary', 'battlefield');
    expect(t.state.cards[ms].tapped).toBe(false);
  });

  it('11. the active player gets priority first after Show and Tell resolves', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Omniscience');
    t.p1.manaBase(3);
    t.p2.hand('Atraxa, Grand Unifier');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();
    t.secret('p1', 'Omniscience');
    t.secret('p2', 'Atraxa, Grand Unifier');
    t.auto();

    expect(t.state.priorityPlayer).toBe('p1');
    expect(t.state.activePlayer).toBe('p1');
  });

  it('12. Mystic Sanctuary entering tapped produces no trigger at all', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Mystic Sanctuary');
    // Only two Islands — Mistrise Village has no land type at all.
    t.p1.battlefield('Island', 'Breeding Pool', 'Mistrise Village');
    t.p1.graveyard('Brainstorm');
    t.p2.hand('Omniscience');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();
    t.secret('p1', 'Mystic Sanctuary');
    t.secret('p2', 'Omniscience');
    t.auto();

    const ms = t.p1.find('Mystic Sanctuary', 'battlefield');
    expect(t.state.cards[ms].tapped).toBe(true);
    // Brainstorm stays in the graveyard — the trigger never happened.
    expect(t.p1.graveyardNames()).toContain('Brainstorm');
  });

  it('13. Borne Upon a Wind lets Show and Tell be cast at instant speed', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Borne Upon a Wind', 'Omniscience');
    t.p1.manaBase(5);
    t.p2.hand('Atraxa, Grand Unifier');
    t.begin();

    expect(t.p1.canCast('Show and Tell')).toBe(true);
    t.p1.cast('Borne Upon a Wind');
    t.resolveAll();

    // Move to a step where sorceries are normally illegal.
    t.passUntil('end_step');
    expect(t.state.step).toBe('end_step');
    expect(t.p1.canCast('Show and Tell')).toBe(true);
  });

  it('14. Omniscience does not lift the sorcery timing restriction', () => {
    const t = testGame();
    t.p1.hand('Show and Tell');
    t.p1.battlefield('Omniscience');
    t.begin();
    expect(t.p1.canCast('Show and Tell')).toBe(true);

    t.passUntil('end_step');
    // Still a sorcery — free does not mean any time.
    expect(t.p1.canCast('Show and Tell')).toBe(false);
  });

  it('15. a locked-in secret choice cannot be changed', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Omniscience', 'Atraxa, Grand Unifier');
    t.p1.manaBase(3);
    t.p2.hand('Atraxa, Grand Unifier');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();
    t.secret('p1', 'Omniscience');
    expect(() => t.secret('p1', 'Atraxa, Grand Unifier')).toThrow(/already locked in/i);
  });
});
