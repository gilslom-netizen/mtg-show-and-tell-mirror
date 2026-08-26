import { describe, expect, it } from 'vitest';
import { testGame, type TestGame } from './harness.js';

/** The mana a Mana Drain has promised, or null if it promised none. */
function drainedMana(t: TestGame): number | null {
  const d = t.state.delayed[0];
  return d && d.kind === 'manaDrain' ? d.amount : null;
}


/** DESIGN.md 15.3 (Mana Drain), 15.4 (Orcish Bowmasters), 15.5 (Veil of Summer). */

describe('Mana Drain', () => {
  it("25. produces mana equal to the countered spell's mana value, hybrids included", () => {
    // Rakshasa's Bargain is {2/B}{2/G}{2/U}. CR 202.3f makes that mana value 6,
    // which is enough colourless next main phase to cast a hard Omniscience.
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand("Rakshasa's Bargain");
    t.p2.manaBase(6);
    t.p1.hand('Mana Drain');
    t.p1.manaBase(2);
    t.begin();

    t.p2.cast("Rakshasa's Bargain");
    t.p2.pass();
    t.p1.cast('Mana Drain');
    t.resolveAll();

    expect(drainedMana(t)).toBe(6);
    expect(t.p2.graveyardNames()).toContain("Rakshasa's Bargain");
  });

  it('27. an Atraxa spell is worth seven', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Atraxa, Grand Unifier');
    t.p2.manaBase(7);
    t.p1.hand('Mana Drain');
    t.p1.manaBase(2);
    t.begin();

    t.p2.cast('Atraxa, Grand Unifier');
    t.p2.pass();
    t.p1.cast('Mana Drain');
    t.resolveAll();
    expect(drainedMana(t)).toBe(7);
  });

  it('28. a modal DFC cast from its front face is worth its front face mana value', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Waterlogged Teachings');
    t.p2.manaBase(4);
    t.p1.hand('Mana Drain');
    t.p1.manaBase(2);
    t.begin();

    t.p2.cast('Waterlogged Teachings');
    t.p2.pass();
    t.p1.cast('Mana Drain');
    t.resolveAll();
    expect(drainedMana(t)).toBe(4);
  });

  it('29. Veil of Summer stops the counter but NOT the mana', () => {
    // Official ruling: "If the target is legal but not countered ... you do add mana."
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Veil of Summer', 'Show and Tell');
    t.p2.manaBase(4);
    t.p1.hand('Mana Drain');
    t.p1.manaBase(2);
    t.begin();

    t.p2.cast('Show and Tell');
    t.p2.pass();
    t.p1.cast('Mana Drain');
    // CR 117.3c: p1 keeps priority after casting, and passes it on deliberately.
    t.p1.pass();
    t.p2.cast('Veil of Summer');
    t.resolveAll();

    // Show and Tell survived the counter...
    expect(t.wasCountered('Show and Tell')).toBe(false);
    expect(t.wasResolved('Show and Tell')).toBe(true);
    // ...but p1 still gets the ritual.
    expect(drainedMana(t)).toBe(3);
  });

  it('30. Mistrise Village protects a single spell from being countered', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Show and Tell', 'Brainstorm');
    t.p2.battlefield('Mistrise Village', 'Island', 'Breeding Pool', 'Watery Grave', 'Hedge Maze');
    t.p1.hand('Mana Drain');
    t.p1.manaBase(2);
    t.begin();

    t.p2.activate('Mistrise Village');
    t.resolveStack();
    t.p2.cast('Show and Tell');
    t.p2.pass();
    t.p1.cast('Mana Drain');
    t.resolveAll();

    expect(t.wasCountered('Show and Tell')).toBe(false);
    expect(t.wasResolved('Show and Tell')).toBe(true);
  });

  it('31. the shield only covers the NEXT spell, not the one after it', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Brainstorm', 'Show and Tell');
    t.p2.battlefield(
      'Mistrise Village',
      'Island',
      'Breeding Pool',
      'Watery Grave',
      'Hedge Maze',
      'Undercity Sewers',
      'Hallowed Fountain',
    );
    t.p1.hand('Mana Drain');
    t.p1.manaBase(2);
    t.begin();

    t.p2.activate('Mistrise Village');
    t.resolveStack();
    // Brainstorm consumes the shield. Put back two cards that are not the ones
    // this test still needs.
    t.p2.cast('Brainstorm');
    t.resolveStack();
    const hand = t.expectChoice();
    if (hand.kind === 'chooseCards') {
      const keep = t.p2.find('Show and Tell', 'hand');
      const putBack = hand.options.filter((o) => o.iid !== keep && !o.disabledReason).slice(0, 2);
      t.answer({ kind: 'cards', iids: putBack.map((o) => o.iid) });
    }
    t.resolveAll();

    t.p2.cast('Show and Tell');
    t.p2.pass();
    t.p1.cast('Mana Drain');
    t.resolveAll();

    expect(t.wasCountered('Show and Tell')).toBe(true);
  });

  it('33. floating mana is lost at the end of the phase', () => {
    const t = testGame();
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.state.delayed.push({ id: 1, kind: 'manaDrain', controller: 'p1', amount: 6, armedOnTurn: 1 });
    t.begin('beginning', 'upkeep');

    t.passUntilCondition(() => t.state.step === 'main');
    expect(t.state.players.p1.manaPool.C).toBe(6);

    t.passUntilCondition(() => t.state.step === 'begin_combat');
    expect(t.state.players.p1.manaPool.C).toBe(0);
  });

  it('35. drained mana can pay for a hard Omniscience', () => {
    const t = testGame();
    t.p1.hand('Omniscience');
    t.p1.manaBase(4);
    t.state.delayed.push({ id: 1, kind: 'manaDrain', controller: 'p1', amount: 6, armedOnTurn: 1 });
    t.begin('beginning', 'upkeep');
    t.passUntilCondition(() => t.state.step === 'main');

    // {7}{U}{U}{U} = 10, from 6 floating colourless plus four blue lands.
    expect(t.p1.canCast('Omniscience')).toBe(true);
    t.p1.cast('Omniscience');
    t.resolveAll();
    expect(t.p1.battlefieldNames()).toContain('Omniscience');
  });
});

describe('Orcish Bowmasters', () => {
  it('36. an opposing Brainstorm is three separate draws, so three triggers', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p1.battlefield('Orcish Bowmasters');
    t.p2.hand('Brainstorm');
    t.p2.manaBase(1);
    t.begin();

    t.clearEvents();
    t.p2.cast('Brainstorm');
    t.resolveAll();

    expect(t.countDraws('p2')).toBe(3);
    expect(t.countTriggers('Orcish Bowmasters')).toBe(3);
  });

  it('37. the normal draw-step draw is exempt', () => {
    const t = testGame({ startingPlayer: 'p1' });
    t.p1.battlefield('Orcish Bowmasters');
    t.p2.hand('Island');
    t.begin();

    t.clearEvents();
    // Advance into p2's turn, which includes their draw step.
    t.passUntilCondition(() => t.state.step === 'main' && t.state.activePlayer === 'p2');

    expect(t.countDraws('p2')).toBe(1);
    expect(t.countTriggers('Orcish Bowmasters')).toBe(0);
  });

  it.each([
    ['Dig Through Time', 8],
    ["Rakshasa's Bargain", 6],
    ['Planar Genesis', 2],
  ])('38-40. %s puts cards into hand and is not a draw', (card, lands) => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p1.battlefield('Orcish Bowmasters');
    t.p2.hand(card);
    t.p2.manaBase(lands);
    t.begin();

    t.clearEvents();
    t.p2.cast(card);
    t.resolveAll();

    expect(t.countDraws('p2')).toBe(0);
    expect(t.countTriggers('Orcish Bowmasters')).toBe(0);
  });

  it('41. Atraxa filling her controller’s hand is not a draw either', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p1.battlefield('Orcish Bowmasters');
    t.p2.hand('Atraxa, Grand Unifier');
    t.p2.manaBase(7);
    t.begin();

    t.clearEvents();
    t.p2.cast('Atraxa, Grand Unifier');
    t.resolveAll();

    expect(t.countDraws('p2')).toBe(0);
    expect(t.countTriggers('Orcish Bowmasters')).toBe(0);
    // Atraxa's trigger did happen — it just moved cards without drawing them.
    expect(t.countTriggers('Atraxa, Grand Unifier')).toBe(1);
  });

  it('42. Borne Upon a Wind draws a card, so it does trigger', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p1.battlefield('Orcish Bowmasters');
    t.p2.hand('Borne Upon a Wind');
    t.p2.manaBase(2);
    t.begin();

    t.clearEvents();
    t.p2.cast('Borne Upon a Wind');
    t.resolveAll();

    expect(t.countDraws('p2')).toBe(1);
    expect(t.countTriggers('Orcish Bowmasters')).toBe(1);
  });

  it('44/46. its own arrival triggers once and amasses a 1/1 Orc Army', () => {
    const t = testGame();
    t.p1.hand('Orcish Bowmasters');
    t.p1.manaBase(2);
    t.begin();

    t.p1.cast('Orcish Bowmasters');
    t.resolveAll();

    expect(t.countTriggers('Orcish Bowmasters')).toBe(1);
    const army = t.state.zones.p1.battlefield
      .map((i) => t.state.cards[i])
      .find((c) => c.token?.subtypes.includes('Army'));
    expect(army).toBeTruthy();
    expect(t.pt(army!.iid)).toBe('1/1');
    expect(army!.token!.name).toBe('Orc Army');
  });

  it('45. two Bowmasters and an opposing Brainstorm make six triggers and a 5/5 Army', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p1.battlefield('Orcish Bowmasters', 'Orcish Bowmasters');
    t.p2.hand('Brainstorm');
    t.p2.manaBase(1);
    t.p2.life(40);
    t.begin();

    t.clearEvents();
    t.p2.cast('Brainstorm');
    t.resolveAll();

    expect(t.countTriggers('Orcish Bowmasters')).toBe(6);
    const army = t.state.zones.p1.battlefield
      .map((i) => t.state.cards[i])
      .find((c) => c.token?.subtypes.includes('Army'));
    // One token, then five more counters.
    expect(t.pt(army!.iid)).toBe('6/6');
  });

  it('48. Veil of Summer removes the opponent from the target list but not you', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p1.battlefield('Orcish Bowmasters');
    t.p2.hand('Veil of Summer', 'Brainstorm');
    t.p2.manaBase(3);
    t.begin();

    t.p2.cast('Veil of Summer');
    t.resolveAll();
    t.p2.cast('Brainstorm');
    t.resolveStack();
    // Brainstorm's own choice comes first, during its resolution.
    t.auto(1);

    const c = t.expectChoice();
    // Three identical triggers first need ordering.
    if (c.kind === 'orderTriggers') {
      t.answer({ kind: 'order', ids: c.triggers.map((x) => x.id) });
    }
    const target = t.expectChoice();
    expect(target.kind).toBe('chooseTargets');
    if (target.kind === 'chooseTargets') {
      // p2 is a black-source-proof target now; p1 (the Bowmasters controller) is not.
      expect(target.candidates.some((x) => x.kind === 'player' && x.id === 'p2')).toBe(false);
      expect(target.candidates.some((x) => x.kind === 'player' && x.id === 'p1')).toBe(true);
    }
  });

  it('49/51. one damage does not kill an Atraxa but can finish a player', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p1.hand('Orcish Bowmasters');
    t.p1.manaBase(2);
    t.p2.battlefield('Atraxa, Grand Unifier');
    t.p2.life(1);
    t.begin('precombat_main', 'main');
    // Give p1 priority by moving to p2's end step where p1 can flash it in.
    t.passUntilCondition(() => t.state.step === 'end_step');
    t.p2.pass();

    t.p1.cast('Orcish Bowmasters');
    t.resolveStack();
    t.targetPlayer('p2');
    t.resolveAll();

    expect(t.state.winner).toBe('p1');
  });
});

describe('Veil of Summer', () => {
  it('52/53. the draw is conditional on the opponent having cast blue or black', () => {
    const noBlue = testGame();
    noBlue.p1.hand('Veil of Summer');
    noBlue.p1.manaBase(2);
    noBlue.begin();
    noBlue.clearEvents();
    noBlue.p1.cast('Veil of Summer');
    noBlue.resolveAll();
    expect(noBlue.countDraws('p1')).toBe(0);

    const withBlue = testGame({ startingPlayer: 'p2' });
    withBlue.p2.hand('Brainstorm');
    withBlue.p2.manaBase(1);
    withBlue.p1.hand('Veil of Summer');
    withBlue.p1.manaBase(2);
    withBlue.begin();
    withBlue.p2.cast('Brainstorm');
    withBlue.resolveAll();
    withBlue.clearEvents();
    withBlue.p2.pass();
    withBlue.p1.cast('Veil of Summer');
    withBlue.resolveAll();
    expect(withBlue.countDraws('p1')).toBe(1);
  });

  it('54. spells cast AFTER Veil resolves are also uncounterable', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Veil of Summer', 'Show and Tell');
    t.p2.manaBase(4);
    t.p1.hand('Mana Drain');
    t.p1.manaBase(2);
    t.begin();

    t.p2.cast('Veil of Summer');
    t.resolveAll();
    t.p2.cast('Show and Tell');
    t.p2.pass();
    t.p1.cast('Mana Drain');
    t.resolveAll();

    expect(t.wasCountered('Show and Tell')).toBe(false);
  });

  it('55. permanents that arrive after Veil resolves are NOT protected', () => {
    // "You and permanents you control gain hexproof" is evaluated once, on
    // resolution. Anything that shows up later is naked.
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Veil of Summer', 'Orcish Bowmasters');
    t.p2.manaBase(4);
    t.p1.battlefield('Hullbreaker Horror');
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.begin();

    t.p2.cast('Veil of Summer');
    t.resolveAll();
    t.p2.cast('Orcish Bowmasters');
    t.resolveAll();
    t.p2.pass();

    t.p1.cast('Brainstorm');
    t.chooseMode(1);
    const c = t.expectChoice();
    expect(c.kind).toBe('chooseTargets');
    if (c.kind === 'chooseTargets') {
      const bow = t.p2.find('Orcish Bowmasters', 'battlefield');
      // The hexproof list was locked in before the Bowmasters existed.
      expect(c.candidates.some((x) => x.kind === 'permanent' && x.iid === bow)).toBe(true);
    }
  });

  it('57. an opposing Hullbreaker Horror cannot bounce a protected permanent', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.battlefield('Omniscience');
    t.p2.hand('Veil of Summer');
    t.p2.manaBase(2);
    t.p1.battlefield('Hullbreaker Horror');
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.begin();

    t.p2.cast('Veil of Summer');
    t.resolveAll();
    t.p2.pass();

    t.p1.cast('Brainstorm');
    const c = t.expectChoice();
    expect(c.kind).toBe('chooseMode');
    const omni = t.p2.find('Omniscience', 'battlefield');
    t.chooseMode(1);

    const next = t.choice();
    if (next && next.kind === 'chooseTargets') {
      expect(next.candidates.some((x) => x.kind === 'permanent' && x.iid === omni)).toBe(false);
    } else {
      // Auto-picked because p1's own Horror was the only legal target left.
      const ability = t.state.stack.map((iid) => t.state.cards[iid]).find((x) => x.isAbility);
      expect(ability?.targets?.[0]).toEqual({
        kind: 'permanent',
        iid: t.p1.find('Hullbreaker Horror', 'battlefield'),
      });
    }
  });

  it('58. Veil does NOT protect your spells from being bounced off the stack', () => {
    // A spell is not "you or a permanent you control". This is the crack in Veil
    // that the mirror is actually played through.
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Veil of Summer', 'Show and Tell');
    t.p2.manaBase(4);
    t.p1.battlefield('Hullbreaker Horror');
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.begin();

    t.p2.cast('Veil of Summer');
    t.resolveAll();
    t.p2.cast('Show and Tell');
    t.p2.pass();

    t.p1.cast('Brainstorm');
    t.chooseMode(0);
    t.resolveAll();

    expect(t.p2.handNames()).toContain('Show and Tell');
  });
});
