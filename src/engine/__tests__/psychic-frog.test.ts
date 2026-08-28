import { describe, expect, it } from 'vitest';
import { testGame, type TestGame } from './harness.js';

/**
 * Psychic Frog, which a playtest found three ways to be wrong about.
 *
 * "You didn't draw from the Frog." "Right — you have the same number in hand and
 * in the yard. This card has several bugs then." "Basically you now have a
 * creature with infinite power and flying."
 *
 * All three come from the same place: the abilities were declared with costs the
 * engine never took. `payActivationCost` handles tap, mana, life, loyalty and
 * sacrifice, and is synchronous by design — so the two costs that need a
 * question, discarding and exiling from the graveyard, were checked in
 * `legalActions` and then quietly skipped. And the draw trigger never fired at
 * all, because damage was pushed to the event list rather than emitted, and only
 * emitting offers an event to the permanents that might trigger on it.
 */

function frogOnBoard(): TestGame {
  const t = testGame({ startingPlayer: 'p1' });
  t.p1.conjureOntoBattlefield('Psychic Frog');
  return t;
}

const frogIid = (t: TestGame) => t.p1.find('Psychic Frog', 'battlefield');

describe('Psychic Frog', () => {
  it('draws a card when it connects', () => {
    const t = frogOnBoard();
    t.p1.hand('Brainstorm');
    t.begin();
    t.state.cards[frogIid(t)].summoningSick = false;
    const before = t.p1.handSize();

    t.passUntil('declare_attackers');
    const choice = t.expectChoice();
    if (choice.kind !== 'declareAttackers') throw new Error(`got ${choice.kind}`);
    t.answer({ kind: 'attackers', iids: choice.candidates });
    t.resolveAll();
    t.passUntil('end_step');

    expect(t.state.players.p2.life).toBe(19);
    expect(t.p1.handSize()).toBe(before + 1);
  });

  describe('"Discard a card:"', () => {
    it('actually discards one', () => {
      const t = frogOnBoard();
      t.p1.hand('Brainstorm', 'Ponder');
      t.begin();
      const before = t.p1.handSize();

      t.p1.activate('Psychic Frog', 1);
      t.chooseCards('Ponder');
      t.resolveAll();

      expect(t.p1.handSize()).toBe(before - 1);
      expect(t.p1.graveyardNames()).toContain('Ponder');
      expect(t.state.cards[frogIid(t)].counters['+1/+1']).toBe(1);
    });

    /**
     * The report, in one line: the hand never went down, so the ability could be
     * activated for ever and the Frog was as big as you had patience for.
     */
    it('runs out when the hand does, rather than growing for ever', () => {
      const t = frogOnBoard();
      t.p1.hand('Brainstorm', 'Ponder');
      t.begin();

      for (let i = 0; i < 2; i++) {
        t.p1.activate('Psychic Frog', 1);
        t.resolveAll();
      }
      expect(t.p1.handSize()).toBe(0);
      expect(t.state.cards[frogIid(t)].counters['+1/+1']).toBe(2);

      // Nothing left to pay with, so there is nothing left to activate.
      const offered = t.game
        .legalActions('p1')
        .filter((a) => a.intent.t === 'activateAbility' && a.label.includes('Discard'));
      expect(offered).toEqual([]);
    });
  });

  describe('"Exile three cards from your graveyard:"', () => {
    it('actually exiles three', () => {
      const t = frogOnBoard();
      t.p1.graveyard('Brainstorm', 'Ponder', 'Dig Through Time', 'Demonic Tutor');
      t.begin();

      t.p1.activate('Psychic Frog', 2);
      t.resolveAll();

      expect(t.state.zones.p1.graveyard).toHaveLength(1);
      expect(t.state.zones.p1.exile).toHaveLength(3);
    });

    it('is not offered with fewer than three down there', () => {
      const t = frogOnBoard();
      t.p1.graveyard('Brainstorm', 'Ponder');
      t.begin();
      const offered = t.game
        .legalActions('p1')
        .filter((a) => a.intent.t === 'activateAbility' && a.label.includes('Exile'));
      expect(offered).toEqual([]);
    });
  });
});
