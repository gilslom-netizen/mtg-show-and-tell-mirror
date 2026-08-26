import { describe, expect, it } from 'vitest';
import { testGame } from './harness.js';
import { producedManaOf } from '../game.js';
import { frontFace, oracleByName } from '../oracle.js';

/**
 * The cube's mana producers.
 *
 * The engine offers "tap this for {G}" straight off Scryfall's produced_mana, with
 * no script needed. That is right for a land or a Mox — the whole ability is
 * "{T}: Add" — and wrong for anything whose mana costs more than the tap. The cube
 * brought in one of each, so the rule now has to hold rather than merely never
 * having been tested.
 */

describe('what taps for mana without a script', () => {
  const produced = (name: string) => frontFace(oracleByName(name).oracleId).producedMana;

  it('lets a Mox and a Birds tap, because that is all their ability is', () => {
    expect(produced('Mox Emerald')).toEqual(['G']);
    expect(produced('Birds of Paradise').slice().sort()).toEqual(['B', 'G', 'R', 'U', 'W']);
  });

  it('does not let Deathrite Shaman tap, because its mana has a cost first', () => {
    // Scryfall reports it producing all five colours — true, but only after
    // exiling a land from a graveyard. Offered as a plain tap it would be a Birds
    // of Paradise that also fixes, for free. It waits for a script instead.
    expect(oracleByName('Deathrite Shaman').oracleText).toMatch(/Exile target land card/);
    expect(produced('Deathrite Shaman')).toEqual([]);
  });

  it('still lets every land tap, including one that prints no text at all', () => {
    expect(produced('Island')).toEqual(['U']);
    /*
     * Cavern of Souls used to keep its produced_mana here, which was the free
     * half of a card whose whole point is the restriction: "spend this mana only
     * to cast a creature spell of the chosen type" had been dropped on the
     * floor. Any 'spend only' clause now mutes the automatic derivation, and
     * Cavern waits for a script that keeps the leash on.
     */
    expect(produced('Cavern of Souls')).toEqual([]);
    // The land face of a modal DFC inherits it from the card.
    expect(oracleByName('Waterlogged Teachings').faces![1].producedMana.slice().sort()).toEqual(['B', 'U']);
  });
});

describe('a mana creature the turn it arrives', () => {
  it('cannot be tapped for mana until it has been around a turn (CR 302.6)', () => {
    const t = testGame();
    t.begin();
    const [birds] = t.p1.conjureOntoBattlefield('Birds of Paradise');

    // conjureOntoBattlefield clears the sickness, which is the settled case.
    expect(producedManaOf(t.state.cards[birds], t.state).length).toBe(5);

    t.state.cards[birds].summoningSick = true;
    expect(producedManaOf(t.state.cards[birds], t.state)).toEqual([]);
    // And so the engine does not offer it as a source or as an action.
    const offered = t.game
      .legalActions('p1')
      .some((a) => a.intent.t === 'tapForMana' && a.intent.iid === birds);
    expect(offered).toBe(false);
  });

  it('does not apply to an artifact, which has no such rule', () => {
    const t = testGame();
    t.begin();
    const [mox] = t.p1.conjureOntoBattlefield('Mox Emerald');
    t.state.cards[mox].summoningSick = true;
    // Summoning sickness is a creature rule; a Mox taps the turn it lands.
    expect(producedManaOf(t.state.cards[mox], t.state)).toEqual(['G']);
  });
});

/**
 * Gitaxian Probe: {U/P}, "pay {U} or pay two life".
 *
 * The cost parser threw on {U/P} outright before this card entered the pool, so
 * the first thing to prove is that a game containing it runs at all.
 */
describe('paying a Phyrexian cost in a real game', () => {
  it('casts off no lands at all, for two life', () => {
    const t = testGame();
    t.begin();
    t.p1.conjure('Gitaxian Probe');
    expect(t.state.players.p1.life).toBe(20);
    expect(t.p1.canCast('Gitaxian Probe')).toBe(true);

    t.p1.cast('Gitaxian Probe');
    // The Probe has a real target now — payment happens after it is chosen.
    t.targetPlayer('p2');
    expect(t.state.players.p1.life).toBe(18);
  });

  it('takes the land instead when there is one, and leaves the life alone', () => {
    const t = testGame();
    t.p1.manaBase(1);
    t.begin();
    t.p1.conjure('Gitaxian Probe');

    t.p1.cast('Gitaxian Probe');
    t.targetPlayer('p2');
    expect(t.state.players.p1.life).toBe(20);
    expect(t.state.cards[t.state.zones.p1.battlefield[0]].tapped).toBe(true);
  });

  it('cannot be cast at one life with nothing to tap', () => {
    const t = testGame();
    t.begin();
    t.p1.life(1);
    t.p1.conjure('Gitaxian Probe');
    // CR 118.4 — one life does not pay two, and there is no other way to pay it.
    expect(t.p1.canCast('Gitaxian Probe')).toBe(false);
  });
});
