import { describe, expect, it } from 'vitest';
import { testGame, type TestGame } from './harness.js';
import { oracleByName } from '../oracle.js';
import { DRAFT_POOL } from '../draft-pool.js';
import { unimplementedReason } from '../cards/index.js';
import { MANA_KINDS } from '../mana.js';
import type { PlayerId } from '../types.js';

/**
 * The cube, card by card.
 *
 * "It has a script" and "it does what it says" are different claims, and the
 * gap between them is where the playtest found its bugs. So each of these plays
 * the card in a real game and looks at what actually changed.
 *
 * Off-colour lands are conjured rather than taken from `manaBase`, which deals
 * the blue manabase the main deck runs on — a red Pyroblast needs a red source
 * and saying so out loud is cheaper than a confusing failure.
 */

function names(
  t: TestGame,
  zone: 'hand' | 'graveyard' | 'exile' | 'battlefield',
  seat: PlayerId,
): string[] {
  return t.state.zones[seat][zone].map((iid) => t.state.cards[iid].oracleId);
}

function iidOf(t: TestGame, seat: PlayerId, oracleId: string): number {
  const iid = t.state.zones[seat].battlefield.find((i) => t.state.cards[i].oracleId === oracleId);
  if (iid === undefined) throw new Error(`${oracleId} is not on ${seat}'s battlefield`);
  return iid;
}

const poolTotal = (t: TestGame, seat: PlayerId): number =>
  MANA_KINDS.reduce((n, k) => n + t.state.players[seat].manaPool[k], 0);

/** Their Show and Tell on the stack, and it is their turn. */
function theirSpell(theirLands = 3): TestGame {
  const t = testGame({ startingPlayer: 'p2' });
  t.p2.hand('Show and Tell');
  t.p2.manaBase(theirLands);
  t.begin();
  t.p2.cast('Show and Tell');
  t.p2.pass();
  return t;
}

describe('the counterspells', () => {
  it('Spell Pierce counters when they cannot pay the tax', () => {
    // Three lands, all tapped for the Show and Tell: nothing left for {2}, so
    // nothing is asked — a prompt with one answer is a slower counterspell.
    const t = theirSpell();
    t.p1.conjure('Spell Pierce');
    t.p1.manaBase(1);
    t.p1.cast('Spell Pierce');
    t.resolveAll();
    expect(t.wasCountered('Show and Tell')).toBe(true);
  });

  it('and asks them, and stands down, when they can', () => {
    const t = theirSpell(5); // two lands still untapped
    t.p1.conjure('Spell Pierce');
    t.p1.manaBase(1);
    t.p1.cast('Spell Pierce');
    t.resolveStack();
    const c = t.expectChoice();
    expect(c.kind).toBe('yesNo');
    expect(c.player).toBe('p2');
    t.yes();
    t.resolveAll();
    expect(t.wasCountered('Show and Tell')).toBe(false);
  });

  it('Memory Lapse puts it on top of the library, not in the graveyard', () => {
    const t = theirSpell();
    t.p1.conjure('Memory Lapse');
    t.p1.manaBase(2);
    t.p1.cast('Memory Lapse');
    t.resolveAll();
    expect(t.wasCountered('Show and Tell')).toBe(true);
    expect(names(t, 'graveyard', 'p2')).not.toContain('show_and_tell');
    expect(t.state.cards[t.state.zones.p2.library[0]].oracleId).toBe('show_and_tell');
  });

  it('Mystical Dispute costs {2} less against a blue spell', () => {
    const t = theirSpell();
    t.p1.conjure('Mystical Dispute');
    t.p1.manaBase(1);
    // {2}{U} printed; one land only pays for it because Show and Tell is blue.
    expect(t.p1.canCast('Mystical Dispute')).toBe(true);
  });

  it('Krosan Grip shuts everything else off while it is on the stack', () => {
    const t = testGame();
    t.p2.battlefield('Omniscience');
    t.p2.hand('Brainstorm');
    t.p1.conjure('Krosan Grip');
    t.p1.conjureOntoBattlefield('Breeding Pool', 'Breeding Pool', 'Breeding Pool');
    t.begin();
    t.p1.cast('Krosan Grip');
    // Split second: even a free Brainstorm under an Omniscience is not castable.
    expect(t.game.legalActions('p2').filter((a) => a.intent.t === 'castSpell')).toHaveLength(0);
  });

  it('Pyroblast does nothing to a spell that is not blue', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Demonic Tutor');
    t.p2.manaBase(2);
    t.begin();
    t.p2.cast('Demonic Tutor');
    t.p2.pass();
    t.p1.conjure('Pyroblast');
    t.p1.conjureOntoBattlefield('Steam Vents');
    t.p1.cast('Pyroblast');
    t.resolveAll();
    // Black, so the counter half simply does not apply.
    expect(t.wasCountered('Demonic Tutor')).toBe(false);
  });
});

describe('discard and removal', () => {
  it('Thoughtseize takes a card and costs two life', () => {
    const t = testGame();
    t.p1.conjure('Thoughtseize');
    t.p1.manaBase(1);
    t.p2.hand('Omniscience');
    t.begin();
    t.p1.cast('Thoughtseize');
    t.targetPlayer('p2');
    t.resolveAll();
    expect(names(t, 'graveyard', 'p2')).toContain('omniscience');
    expect(t.state.players.p1.life).toBe(18);
  });

  it('Swords to Plowshares exiles and pays its controller', () => {
    const t = testGame();
    t.p2.battlefield('Atraxa, Grand Unifier'); // 7/7
    t.p1.conjure('Swords to Plowshares');
    t.p1.conjureOntoBattlefield('Hallowed Fountain');
    t.begin();
    t.p1.cast('Swords to Plowshares');
    t.resolveAll();
    expect(names(t, 'exile', 'p2')).toContain('atraxa_grand_unifier');
    expect(t.state.players.p2.life).toBe(27);
  });

  it('Bitter Triumph makes you choose between a card and three life', () => {
    const t = testGame();
    t.p2.battlefield('Orcish Bowmasters');
    t.p1.conjure('Bitter Triumph');
    t.p1.hand('Brainstorm');
    t.p1.manaBase(2);
    t.begin();
    t.p1.cast('Bitter Triumph');
    // One legal target, so no target prompt — straight to the additional cost.
    const c = t.expectChoice();
    expect(c.kind).toBe('yesNo');
    t.no(); // pay 3 life instead of discarding
    t.resolveAll();
    expect(t.state.players.p1.life).toBe(17);
    expect(names(t, 'graveyard', 'p2')).toContain('orcish_bowmasters');
  });

  it('Bloodchief’s Thirst reaches a big creature only when it is kicked', () => {
    const t = testGame();
    t.p2.battlefield('Atraxa, Grand Unifier'); // mana value 7
    t.p1.conjure("Bloodchief's Thirst");
    t.p1.manaBase(1);
    t.begin();
    // {B} alone cannot legally point at a seven-drop.
    expect(t.p1.canCast("Bloodchief's Thirst")).toBe(false);
    t.p1.manaBase(3);
    // {2}{B} on top: the kicked cast is legal, and offering it is the fix — the
    // target check used to run once, unkicked, and hide the card entirely.
    expect(t.p1.canCast("Bloodchief's Thirst")).toBe(true);
  });

  it('Surgical Extraction takes every copy, from every zone', () => {
    const t = testGame();
    t.p2.graveyard('Brainstorm');
    t.p2.hand('Brainstorm');
    t.p1.conjure('Surgical Extraction');
    t.begin();
    const before = names(t, 'exile', 'p2').length;
    t.p1.cast('Surgical Extraction');
    t.resolveAll();
    expect(names(t, 'exile', 'p2').length).toBeGreaterThan(before);
    expect(names(t, 'hand', 'p2')).not.toContain('brainstorm');
    expect(names(t, 'graveyard', 'p2')).not.toContain('brainstorm');
  });

  it('Reanimate steals their creature for its mana value in life', () => {
    const t = testGame();
    t.p2.graveyard('Atraxa, Grand Unifier'); // mana value 7
    t.p1.conjure('Reanimate');
    t.p1.manaBase(1);
    t.begin();
    t.p1.cast('Reanimate');
    t.resolveAll();
    expect(names(t, 'battlefield', 'p1')).toContain('atraxa_grand_unifier');
    expect(t.state.players.p1.life).toBe(13);
  });
});

describe('the permanents', () => {
  it('Utopia Sprawl adds its chosen colour when the land is tapped', () => {
    const t = testGame();
    t.p1.conjureOntoBattlefield('Breeding Pool');
    t.p1.conjure('Utopia Sprawl');
    t.p1.conjureOntoBattlefield('Hedge Maze'); // the {G} that pays for it
    t.begin();
    t.p1.cast('Utopia Sprawl');
    t.resolveAll();

    const forest = iidOf(t, 'p1', 'breeding_pool');
    // The solver tapped it to pay for the aura; untap it so this measures the
    // ride-along rather than the payment.
    t.state.cards[forest].tapped = false;
    const before = poolTotal(t, 'p1');
    t.intent('p1', { t: 'tapForMana', iid: forest, kind: 'G' });
    // The land's own mana, plus the aura's ride-along.
    expect(poolTotal(t, 'p1')).toBe(before + 2);
  });

  it('an aura falls off when what it enchants leaves', () => {
    const t = testGame();
    t.p1.conjureOntoBattlefield('Breeding Pool');
    t.p1.conjure('Utopia Sprawl');
    t.p1.conjureOntoBattlefield('Hedge Maze'); // the {G} that pays for it
    t.begin();
    t.p1.cast('Utopia Sprawl');
    t.resolveAll();
    expect(names(t, 'battlefield', 'p1')).toContain('utopia_sprawl');

    t.exileFromBattlefield('p1', iidOf(t, 'p1', 'breeding_pool'));
    t.game.advance();
    expect(names(t, 'battlefield', 'p1')).not.toContain('utopia_sprawl');
    expect(names(t, 'graveyard', 'p1')).toContain('utopia_sprawl');
  });

  it("Ashiok's Erasure exiles the spell and locks out the name", () => {
    const t = theirSpell();
    t.p1.conjure("Ashiok's Erasure");
    t.p1.manaBase(2);
    t.p1.cast("Ashiok's Erasure");
    t.resolveAll();
    expect(names(t, 'exile', 'p2')).toContain('show_and_tell');
    // A second copy of the same card is now uncastable for them.
    t.p2.hand('Show and Tell');
    t.p2.conjureOntoBattlefield('Island', 'Island', 'Island');
    expect(t.p2.canCast('Show and Tell')).toBe(false);
  });

  it('Sneak Attack puts a creature in and takes it back at end of turn', () => {
    const t = testGame();
    t.p1.conjureOntoBattlefield('Sneak Attack', 'Steam Vents');
    t.p1.hand('Atraxa, Grand Unifier');
    t.begin();
    t.intent('p1', { t: 'activateAbility', iid: iidOf(t, 'p1', 'sneak_attack'), index: 0 });
    // The ability goes on the stack first; the "you may" is asked on resolution.
    t.resolveStack();
    t.chooseCards('Atraxa, Grand Unifier');
    t.resolveAll();
    expect(names(t, 'battlefield', 'p1')).toContain('atraxa_grand_unifier');

    t.passUntil('end_step');
    t.resolveAll();
    expect(names(t, 'battlefield', 'p1')).not.toContain('atraxa_grand_unifier');
    expect(names(t, 'graveyard', 'p1')).toContain('atraxa_grand_unifier');
  });

  it('Wilderness Reclamation untaps your lands at end of turn', () => {
    const t = testGame();
    t.p1.conjureOntoBattlefield('Wilderness Reclamation');
    t.p1.battlefieldTapped('Watery Grave', 'Breeding Pool');
    t.begin();
    t.passUntil('end_step');
    t.resolveAll();
    const lands = ['watery_grave', 'breeding_pool'].map((id) => iidOf(t, 'p1', id));
    expect(lands.every((iid) => !t.state.cards[iid].tapped)).toBe(true);
  });
});

describe('the planeswalkers', () => {
  it('arrive with their printed loyalty and die at zero', () => {
    const t = testGame();
    t.p1.conjure('Narset, Parter of Veils');
    t.p1.manaBase(3);
    t.begin();
    t.p1.cast('Narset, Parter of Veils');
    t.resolveAll();
    const narset = iidOf(t, 'p1', 'narset_parter_of_veils');
    expect(t.state.cards[narset].counters['loyalty']).toBe(5);

    t.state.cards[narset].counters['loyalty'] = 0;
    t.game.sbaDirtyForTests();
    t.game.advance();
    expect(names(t, 'graveyard', 'p1')).toContain('narset_parter_of_veils');
  });

  it('Narset stops the opponent drawing more than one a turn', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p1.conjureOntoBattlefield('Narset, Parter of Veils');
    t.p2.hand('Brainstorm');
    t.p2.manaBase(1);
    t.begin();
    t.p2.cast('Brainstorm');
    t.resolveAll();
    expect(t.state.log.some((l) => /draw prevented/.test(l.text))).toBe(true);
  });

  it('a loyalty ability is sorcery speed and once per turn', () => {
    const t = testGame();
    t.p1.conjureOntoBattlefield('Narset, Parter of Veils');
    t.begin();
    const narset = iidOf(t, 'p1', 'narset_parter_of_veils');
    const loyaltyActions = () =>
      t.game.legalActions('p1').filter((a) => a.intent.t === 'activateAbility');
    expect(loyaltyActions()).toHaveLength(1);

    t.intent('p1', { t: 'activateAbility', iid: narset, index: 0 });
    t.resolveAll();
    // Used this turn: gone from the list until it comes back around.
    expect(loyaltyActions()).toHaveLength(0);
    expect(t.state.cards[narset].counters['loyalty']).toBe(3);
  });
});

describe('the cube as a whole', () => {
  it('has a script or generic coverage for every card in the pool', () => {
    for (const name of DRAFT_POOL) {
      const id = oracleByName(name).oracleId;
      expect(unimplementedReason(id), `${name} is not playable`).toBeNull();
    }
  });
});
