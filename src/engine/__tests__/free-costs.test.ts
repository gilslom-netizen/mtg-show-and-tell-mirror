import { describe, expect, it } from 'vitest';
import { testGame, type TestGame } from './harness.js';
import { oracleByName } from '../oracle.js';
import type { PlayerId } from '../types.js';

/**
 * The spells you can cast without paying for them.
 *
 * Reported from a drafted game: two blue cards and a Commandeer in hand, an
 * opposing spell on the stack, and the client passed priority without stopping.
 * It was right to: the engine had no notion of "rather than pay this spell's mana
 * cost", so with no seven lands out there was no legal cast to stop for. The card
 * was in the pool, in the deck and in the hand, and could not be played.
 *
 * These tests are all about a hand that could not pay the printed cost, because
 * that is the only situation in which the alternative cost is the card.
 */

/** Every cast this seat could legally make right now, by label. */
function casts(t: TestGame, seat: PlayerId): string[] {
  return t.game
    .legalActions(seat)
    .filter((a) => a.intent.t === 'castSpell')
    .map((a) => a.label);
}

function cardsOn(t: TestGame, zone: 'exile' | 'graveyard', seat: PlayerId): string[] {
  return t.state.zones[seat][zone].map((iid) => t.state.cards[iid].oracleId);
}

/** Two of their spells on the stack, so a single-target spell has a real choice. */
function theirTwoSpells(): TestGame {
  const t = testGame({ startingPlayer: 'p2' });
  t.p2.hand('Show and Tell', 'Brainstorm');
  t.p2.manaBase(4);
  t.begin();
  t.p2.cast('Show and Tell', { hold: true });
  t.p2.cast('Brainstorm');
  t.p2.pass();
  return t;
}

/** Their Show and Tell on the stack, and it is their turn. */
function theirSpell(): TestGame {
  const t = testGame({ startingPlayer: 'p2' });
  t.p2.hand('Show and Tell');
  t.p2.manaBase(3);
  t.begin();
  t.p2.cast('Show and Tell');
  t.p2.pass();
  return t;
}

describe('an alternative cost', () => {
  it('is offered with no lands at all, which is the whole point', () => {
    const t = theirSpell();
    t.p1.conjure('Commandeer', 'Force of Negation');
    t.p1.hand('Brainstorm', 'Dig Through Time');

    expect(t.state.zones.p1.battlefield).toHaveLength(0);
    expect(casts(t, 'p1')).toEqual([
      'Cast Commandeer (exile two blue cards)',
      'Cast Force of Negation (exile a blue card)',
    ]);
  });

  it('is offered alongside the mana cost, not instead of it', () => {
    const t = theirSpell();
    t.p1.conjure('Force of Negation');
    t.p1.hand('Brainstorm');
    t.p1.manaBase(3);

    // Both ways to pay, because which one is right depends on the rest of the hand.
    expect(casts(t, 'p1')).toContain('Cast Force of Negation (exile a blue card)');
    expect(casts(t, 'p1')).toContain('Cast Force of Negation');
  });

  it('is not offered when it cannot be paid', () => {
    const t = theirSpell();
    t.p1.conjure('Commandeer');
    // One blue card, and Commandeer wants two — and never counts itself.
    t.p1.hand('Brainstorm');
    expect(casts(t, 'p1')).toEqual([]);
  });

  it('is paid after targets are chosen, as any cost is', () => {
    // Two of their spells, because one is no longer a question: a single legal
    // target is taken without asking, and a spell is not a target for itself.
    const t = theirTwoSpells();
    t.p1.conjure('Commandeer');
    t.p1.hand('Brainstorm', 'Dig Through Time');

    t.p1.cast('Commandeer', { alt: true });
    // CR 601.2c before 601.2f: the target first, and only then the two cards —
    // so you know what you are buying before you pay for it.
    expect(t.expectChoice().kind).toBe('chooseTargets');
    t.targetIid(t.state.stack[0]);
    expect(t.expectChoice().prompt).toMatch(/Exile 2 blue cards/);
    t.chooseCards('Brainstorm', 'Dig Through Time');

    expect(cardsOn(t, 'exile', 'p1').sort()).toEqual(['brainstorm', 'dig_through_time']);
    // Their two, plus the Commandeer that is taking one of them.
    expect(t.state.stack).toHaveLength(3);
  });
});

describe('Commandeer', () => {
  it('takes the spell rather than countering it', () => {
    const t = theirSpell();
    t.p1.conjure('Commandeer');
    t.p1.hand('Brainstorm', 'Dig Through Time');
    t.p1.hand('Omniscience');

    t.p1.cast('Commandeer', { alt: true });
    // Their Show and Tell is the only spell it could take — nothing is asked.
    t.chooseCards('Brainstorm', 'Dig Through Time');
    t.resolveAll();

    // Their Show and Tell, resolved for the player who took it. Both players still
    // put something in — that is Show and Tell — but it is p1 who chose to cast it.
    expect(t.wasCountered('Show and Tell')).toBe(false);
    expect(t.wasResolved('Show and Tell')).toBe(true);
    // The card is theirs, so it goes to their graveyard however it resolved.
    expect(cardsOn(t, 'graveyard', 'p2')).toContain('show_and_tell');
  });

  it('points a stolen Mana Drain back the way it came', () => {
    const t = testGame({ startingPlayer: 'p1' });
    t.p1.hand('Ponder', 'Brainstorm', 'Dig Through Time');
    t.p1.conjure('Commandeer');
    t.p1.manaBase(1);
    t.p2.hand('Mana Drain', 'Veil of Summer');
    t.p2.manaBase(3);
    t.begin();

    t.p1.cast('Ponder');
    t.p1.pass();
    // Their Veil, then their Drain. Aiming it is a decision now — their own Veil
    // is a legal target too — so they say out loud that it is my Ponder.
    t.p2.cast('Veil of Summer');
    t.p2.cast('Mana Drain');
    const ponder = t.state.stack.find((iid) => t.state.cards[iid].oracleId === 'ponder')!;
    t.targetIid(ponder);
    t.p2.pass();
    expect(t.state.cards[t.state.stack[2]].oracleId).toBe('mana_drain');

    t.p1.cast('Commandeer', { alt: true });
    t.targetIid(t.state.stack[2]);
    t.chooseCards('Brainstorm', 'Dig Through Time');

    // Commandeer resolves and offers the second half of its text.
    t.resolveStack();
    expect(t.expectChoice().prompt).toMatch(/Choose new targets for Mana Drain/);
    t.yes();
    /*
     * Re-aimed as me, and now it is a real choice: "counter target spell" reaches
     * my own Ponder as well as their Veil, so the game asks which. It used to
     * have exactly one candidate and pick it silently.
     */
    const veil = t.state.stack.find((iid) => t.state.cards[iid].oracleId === 'veil_of_summer')!;
    t.targetIid(veil);
    t.resolveAll();

    /* Their Veil is the one that dies; my Ponder lives. */
    expect(t.wasCountered('Veil of Summer')).toBe(true);
    expect(t.wasCountered('Ponder')).toBe(false);
    // And the ritual half of it pays me, not them.
    expect(t.state.delayed[0]?.controller).toBe('p1');
  });
});

describe('Force of Negation', () => {
  it('is free only on their turn', () => {
    const t = testGame({ startingPlayer: 'p1' });
    t.p1.hand('Brainstorm', 'Dig Through Time');
    t.p1.conjure('Force of Negation');
    t.p1.manaBase(1);
    // An instant, because on my turn they can only answer at instant speed.
    t.p2.hand('Ponder', 'Brainstorm');
    t.p2.manaBase(3);
    t.begin();
    t.p1.cast('Brainstorm');
    t.p1.pass();
    t.p2.cast('Brainstorm');
    t.p2.pass();

    // Their spell is on the stack and I have a blue card in hand — everything the
    // free cast asks for except the one thing it really asks for.
    expect(t.state.activePlayer).toBe('p1');
    expect(t.state.zones.p1.hand.map((i) => t.state.cards[i].oracleId)).toContain(
      'dig_through_time',
    );
    expect(casts(t, 'p1')).not.toContain('Cast Force of Negation (exile a blue card)');
  });

  it('exiles what it counters, so the graveyard stays empty', () => {
    const t = theirSpell();
    t.p1.conjure('Force of Negation');
    t.p1.hand('Brainstorm');

    t.p1.cast('Force of Negation', { alt: true });
    t.chooseCards('Brainstorm');
    t.resolveStack();

    expect(t.wasCountered('Show and Tell')).toBe(true);
    // Not the graveyard: Dig Through Time delves and Mystic Sanctuary buys back,
    // so where a countered spell ends up is a real difference in this format.
    expect(cardsOn(t, 'graveyard', 'p2')).not.toContain('show_and_tell');
    expect(cardsOn(t, 'exile', 'p2')).toContain('show_and_tell');
  });
});

const STORM = ['Brainstorm', 'Dig Through Time', 'Veil of Summer', 'Borne Upon a Wind'];

describe('Mindbreak Trap', () => {
  /** An Omniscience turn: four free spells on the stack in front of you. */
  function stormTurn(): TestGame {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.battlefield('Omniscience');
    // Four instants: after the first cast the stack is not empty, so anything at
    // sorcery speed would not be castable however free it is.
    t.p2.hand('Brainstorm', 'Dig Through Time', 'Veil of Summer', 'Borne Upon a Wind');
    t.begin();
    for (const name of STORM) t.p2.cast(name, { free: true });
    t.p2.pass();
    return t;
  }

  it('is not free until they have cast three spells', () => {
    const t = theirSpell();
    t.p1.conjure('Mindbreak Trap');
    expect(t.state.players.p2.spellsCastThisTurnCount).toBe(1);
    expect(casts(t, 'p1')).toEqual([]);
  });

  it('exiles as many of the spells they just cast as you choose', () => {
    const t = stormTurn();
    t.p1.conjure('Mindbreak Trap');
    expect(t.state.players.p2.spellsCastThisTurnCount).toBe(4);
    expect(casts(t, 'p1')).toEqual(['Cast Mindbreak Trap (free — they have cast three spells)']);

    t.p1.cast('Mindbreak Trap', { alt: true });
    const choice = t.expectChoice();
    if (choice.kind !== 'chooseTargets') throw new Error('expected targets');
    /*
     * Any number: everything else on the stack is on offer at once.
     *
     * The Trap itself is not, which reverses an earlier decision here — "legal and
     * pointless, the player's business" was fine for this card and wrong for the
     * rest. A spell that is a target for itself gives every single-target counter
     * a second candidate, so the game stops to ask a question it used to answer;
     * and it made Pyroblast's "counter target spell" mode castable off an empty
     * stack, pointing at itself. One rule everywhere is worth more than the play
     * it costs: a spell is not a target for itself, every other spell is.
     */
    expect(choice.count).toBe(4);
    expect(choice.optional).toBe(true);
    const theirs = choice.candidates.filter(
      (c) => c.kind === 'spell' && t.state.cards[c.iid]?.controller === 'p2',
    );
    expect(theirs).toHaveLength(4);
    t.answer({ kind: 'targets', targets: theirs });
    t.resolveAll();

    for (const name of STORM) {
      expect(cardsOn(t, 'exile', 'p2')).toContain(oracleByName(name).oracleId);
    }
  });
});

describe('Pact of Negation', () => {
  it('counters for nothing, and the bill arrives at your next upkeep', () => {
    const t = theirSpell();
    t.p1.conjure('Pact of Negation');

    t.p1.cast('Pact of Negation');
    t.resolveStack();
    expect(t.wasCountered('Show and Tell')).toBe(true);
    expect(t.state.delayed).toHaveLength(1);

    // Enough blue to pay {3}{U}{U} when it comes due.
    t.p1.manaBase(5);
    t.passUntilCondition(() => t.state.pendingChoice?.kind === 'yesNo');
    const choice = t.expectChoice();
    expect(choice.prompt).toMatch(/pay \{3\}\{U\}\{U\}/);
    expect(t.state.step).toBe('upkeep');
    expect(t.state.activePlayer).toBe('p1');
    t.yes();
    expect(t.state.winner).toBeNull();
    expect(t.state.delayed).toHaveLength(0);
  });

  it('loses you the game when you cannot pay, without asking a question', () => {
    const t = theirSpell();
    t.p1.conjure('Pact of Negation');

    t.p1.cast('Pact of Negation');
    t.resolveStack();
    // No lands at all: there is nothing to decide, so nothing is asked.
    t.passUntilCondition(() => t.state.winner !== null);
    expect(t.state.winner).toBe('p2');
    expect(t.state.endReason).toBe('a pact came due and went unpaid');
  });

  it('has to be paid even when the counter did nothing', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Hullbreaker Horror');
    t.p2.manaBase(7);
    t.p1.conjure('Pact of Negation');
    t.begin();
    t.p2.cast('Hullbreaker Horror');
    t.p2.pass();

    t.p1.cast('Pact of Negation');
    t.resolveStack();
    // It cannot be countered, and the promise was made anyway.
    expect(t.wasCountered('Hullbreaker Horror')).toBe(false);
    expect(t.state.delayed).toHaveLength(1);
  });
});
