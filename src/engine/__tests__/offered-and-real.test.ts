import { describe, expect, it } from 'vitest';
import { testGame } from './harness.js';
import { manaValueOfCard, untappedManaSources } from '../game.js';

/**
 * What the game offers, it can do.
 *
 * Every bug here is the same bug wearing a different card: two pieces of code
 * answering one question and disagreeing. Deciding what to offer used one
 * answer, carrying it out used the other, and the gap between them was a legal
 * action that did nothing at all — no message, no mana spent, the card sitting
 * back where it started. A person clicks it again. So does the AI, and a drafted
 * game hung on turn seven with twelve thousand decisions behind it.
 *
 * All four were found by playing drafted decks out rather than by reading the
 * code, and they are kept here as well as there so a failure says which of the
 * two answers moved.
 */

describe('an offered cast can be paid for', () => {
  /**
   * Chrome Mox's mana depends on the card it exiled, so answering "what can this
   * produce?" needs the game state to look that card up. The offer asked with
   * the state and the payment asked without it, so the payment saw an artifact
   * that made nothing: Narset was offered, accepted, and silently refused. The
   * parameter is required now, which is what stops it happening again.
   */
  it('counts an imprinted Chrome Mox the same way when paying as when offering', () => {
    const t = testGame();
    t.p1.conjure('Chrome Mox', 'Narset, Parter of Veils');
    t.p1.hand('Brainstorm');
    t.p1.manaBase(2);
    t.begin();

    t.p1.cast('Chrome Mox');
    // Stop at the prompt rather than letting the harness answer it: which card is
    // imprinted is the whole point, and Narset is the other candidate.
    t.resolveStack();
    t.chooseCards('Brainstorm');
    t.resolveAll();

    const mox = t.p1.find('Chrome Mox', 'battlefield');
    expect(untappedManaSources(t.state, 'p1').find((s) => s.iid === mox)?.produces).toEqual(['U']);

    // Two blue lands and a blue Mox is exactly {1}{U}{U}.
    expect(t.p1.canCast('Narset, Parter of Veils')).toBe(true);
    t.p1.cast('Narset, Parter of Veils');

    // The claim: it actually left hand. Before the fix it was offered, taken,
    // and put straight back.
    expect(t.p1.handNames()).not.toContain('Narset, Parter of Veils');
  });
});

describe('a discount the card prints is a discount you get', () => {
  /**
   * Mystical Dispute costs {2}{U}, or {U} against a blue spell. The discount was
   * applied when deciding what to offer and nowhere else, so with two lands
   * untapped the game offered the cast, took it, tried to charge the printed
   * {2}{U}, could not, and put the card back — no message, no mana spent.
   *
   * Nothing had caught it because the discount only matters when you cannot
   * afford the full price, which is exactly the position the card is for.
   */
  it('charges the reduced cost, not the printed one', () => {
    const t = testGame({ startingPlayer: 'p1' });
    t.p1.hand('Show and Tell');
    t.p1.conjure('Mystical Dispute');
    t.p1.manaBase(5);
    t.begin();

    // Show and Tell takes three of the five, leaving two — enough for {U}, not
    // for {2}{U}.
    t.p1.cast('Show and Tell', { hold: true });
    const untapped = () =>
      t.state.zones.p1.battlefield.filter((iid) => !t.state.cards[iid].tapped).length;
    expect(untapped()).toBe(2);

    expect(t.p1.canCast('Mystical Dispute')).toBe(true);
    t.p1.cast('Mystical Dispute');

    // On the stack, having cost one land rather than three.
    expect(t.p1.handNames()).not.toContain('Mystical Dispute');
    expect(t.state.cards[t.state.stack[t.state.stack.length - 1]].oracleId).toBe(
      'mystical_dispute',
    );
    expect(untapped()).toBe(1);
  });
});

describe('a modal spell only offers modes it can carry out', () => {
  /**
   * Pyroblast counters a blue spell or destroys a blue permanent. Casting checked
   * both modes and offered the card if *either* worked; the mode prompt then
   * checked only whether a mode was switched on, and offered "counter target
   * spell" with an empty stack. Targeting found nothing, the cast rewound to
   * hand, and the AI cast it again — forever.
   */
  it('does not offer countering when there is nothing on the stack', () => {
    const t = testGame();
    t.p1.conjure('Pyroblast');
    t.p1.conjureOntoBattlefield('Steam Vents');
    // A blue permanent, so the other mode works and the card is castable at all.
    t.p2.conjureOntoBattlefield('Snapcaster Mage');
    t.begin();

    t.p1.cast('Pyroblast');

    const choice = t.game.state.pendingChoice;
    if (choice?.kind === 'chooseMode') {
      const usable = choice.modes.filter((m) => m.enabled).map((m) => m.text.toLowerCase());
      expect(usable.some((text) => text.includes('counter'))).toBe(false);
    }
    // Either way it is on the stack rather than back in hand.
    expect(t.p1.handNames()).not.toContain('Pyroblast');
  });
});

describe('a token is a permanent like any other', () => {
  /**
   * A token has no oracle entry — its characteristics live on the instance. Any
   * code that looked one up by id threw, so Abrupt Decay measuring the mana value
   * of every permanent crashed the whole game the moment an Otter was on the
   * battlefield.
   */
  it('can be measured and targeted without an oracle entry', () => {
    const t = testGame();
    t.p1.conjureOntoBattlefield('Ral, Crackling Wit');
    t.p2.conjure('Abrupt Decay');
    t.p2.battlefield('Watery Grave', 'Breeding Pool'); // {B} and {G} for the Decay
    t.begin();

    // +1: create a 1/1 Otter.
    t.p1.activate('Ral, Crackling Wit', 1);
    t.resolveAll();
    const token = t.state.zones.p1.battlefield
      .map((iid) => t.state.cards[iid])
      .find((c) => c.isToken);
    expect(token).toBeDefined();
    if (!token) return;

    // CR 202.3b — no mana cost, so mana value zero. Asking used to throw.
    expect(manaValueOfCard(token)).toBe(0);

    // And the whole board enumerates without the token blowing it up.
    expect(() => t.game.legalActions('p2')).not.toThrow();
  });
});

describe('a spell cast from the graveyard is not in the graveyard', () => {
  /**
   * CR 601.2c — targets are chosen once the spell is on the stack. Auroral
   * Procession returns a card from your graveyard, and Lier lets you cast it out
   * of your graveyard: counting itself made the cast look legal, and it rewound
   * the moment targeting found the graveyard empty.
   */
  it('does not count itself as the target it needs', () => {
    const t = testGame();
    t.p1.conjureOntoBattlefield('Lier, Disciple of the Drowned');
    t.p1.manaBase(4);
    t.p1.conjureIntoGraveyard('Auroral Procession');
    t.begin();

    const offers = t.game
      .legalActions('p1')
      .filter((a) => a.label.includes('Auroral Procession'));
    // Nothing else is down there, so there is no card for it to return.
    expect(offers).toEqual([]);
  });

  it('is castable once there is something else down there', () => {
    const t = testGame();
    t.p1.conjureOntoBattlefield('Lier, Disciple of the Drowned');
    t.p1.manaBase(4);
    t.p1.conjureIntoGraveyard('Auroral Procession');
    t.p1.graveyard('Brainstorm');
    t.begin();

    const offers = t.game
      .legalActions('p1')
      .filter((a) => a.label.includes('Auroral Procession'));
    expect(offers.length).toBeGreaterThan(0);
  });
});
