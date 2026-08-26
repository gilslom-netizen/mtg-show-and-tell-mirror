import { describe, expect, it } from 'vitest';
import { testGame, type TestGame } from './harness.js';
import { oracleByName } from '../oracle.js';
import { unimplementedReason } from '../cards/index.js';
import { untappedManaSources } from '../game.js';
import { DRAFT_POOL } from '../draft-pool.js';

/**
 * A card the engine cannot resolve is not a card you can lose a game to.
 *
 * From the playtest that prompted all of this: Thoughtseize was offered, paid
 * for, cast and resolved, and nothing happened — the opponent's hand untouched,
 * the log happy to say "casts Thoughtseize". These tests hold the two halves of
 * the fix: unimplemented cards are not offered at all, and the judgement of
 * what "implemented" means is honest in both directions.
 */

function offers(t: TestGame, name: string): boolean {
  const id = oracleByName(name).oracleId;
  return t.game
    .legalActions('p1')
    .some(
      (a) =>
        (a.intent.t === 'castSpell' || a.intent.t === 'playLand') &&
        t.state.cards[a.intent.iid]?.oracleId === id,
    );
}

describe('the unimplemented-card gate', () => {
  it('does not offer a spell that would resolve into nothing', () => {
    const t = testGame();
    t.p1.conjure('Thoughtseize');
    t.p1.manaBase(3);
    t.begin();
    expect(unimplementedReason('thoughtseize')).toMatch(/not implemented/);
    expect(offers(t, 'Thoughtseize')).toBe(false);
  });

  it('does not offer a land that would sit there producing nothing', () => {
    const t = testGame();
    t.p1.conjure('Cavern of Souls');
    t.begin();
    expect(offers(t, 'Cavern of Souls')).toBe(false);
  });

  /**
   * The other half of the playtest report: "on some of the cards he did not put
   * the warning". Birds of Paradise was flagged as unimplemented while working
   * completely — the whole card is an unconditional mana ability plus flying,
   * which the engine plays generically.
   */
  it('recognises a card that works without a script', () => {
    expect(unimplementedReason('birds_of_paradise')).toBeNull();
    expect(unimplementedReason('mox_emerald')).toBeNull();
    expect(unimplementedReason('island')).toBeNull();

    const t = testGame();
    t.p1.conjure('Mox Emerald');
    t.p1.conjure('Birds of Paradise');
    t.begin();
    expect(offers(t, 'Mox Emerald')).toBe(true);
    expect(offers(t, 'Birds of Paradise')).toBe(false); // no green source yet
    t.p1.manaBase(2); // Breeding Pool makes {G}
    expect(offers(t, 'Birds of Paradise')).toBe(true);
  });

  /**
   * Chrome Mox was the inverse and worse: no warning, and a mana ability the
   * card does not have yet. "{T}: Add one mana of any of the exiled card's
   * colors" with nothing imprinted is no colours — the old string-match saw
   * "{T}: Add" and offered all five.
   */
  it('gives Chrome Mox and Cavern of Souls no free mana', () => {
    expect(oracleByName('Chrome Mox').producedMana).toEqual([]);
    expect(oracleByName('Cavern of Souls').producedMana).toEqual([]);
    // And the honest duals still work — their mana is intrinsic to the land types.
    expect(oracleByName('Watery Grave').producedMana.sort()).toEqual(['B', 'U']);
    expect(oracleByName('Birds of Paradise').producedMana).toHaveLength(5);
  });

  it('lets a summoning-sick mana creature produce nothing this turn', () => {
    // CR 302.6 — a fresh Birds of Paradise is not a mana source until your next
    // turn. It was, which was a free extra mana in any game it appeared in.
    const t = testGame();
    const [birds] = t.p1.conjureOntoBattlefield('Birds of Paradise');
    t.state.cards[birds].summoningSick = true;
    t.begin();
    expect(untappedManaSources(t.state, 'p1').some((s) => s.iid === birds)).toBe(false);
    t.state.cards[birds].summoningSick = false;
    expect(untappedManaSources(t.state, 'p1').some((s) => s.iid === birds)).toBe(true);
  });

  /**
   * The measure of the whole card-implementation effort. This number reaching
   * zero is the definition of "you can draft and just play" — it is asserted
   * exactly so it can only go down.
   */
  it('counts the cube cards that still cannot be played', () => {
    const gaps = DRAFT_POOL.filter((name) => unimplementedReason(oracleByName(name).oracleId));
    expect(gaps.length).toBeLessThanOrEqual(59);
  });
});
