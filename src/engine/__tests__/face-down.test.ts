import { describe, expect, it } from 'vitest';
import { testGame, type TestGame } from './harness.js';
import { getScript } from '../cards/index.js';
import { FACE_DOWN_ORACLE_ID, redact } from '../redact.js';
import { currentFace, powerOf, scriptIdOf, toughnessOf } from '../state.js';
import { oracleByName } from '../oracle.js';
import type { IID, PlayerId } from '../types.js';

/**
 * Face down means face down.
 *
 * Manifest dread — Abhorrent Oculus's trigger — puts a card onto the battlefield
 * face down as a 2/2 with no abilities, and whose identity only its controller
 * may look at. All three of those were being ignored: the card was sent to both
 * seats naming itself, every ability lookup went to the real card underneath, and
 * the client drew it as the card it was. From the table it was simply being
 * played as normal, which is the one thing it must never be.
 */

/** Manifest a named card for p1, by putting it on top and running the trigger. */
function manifested(name: string): { t: TestGame; iid: IID } {
  const t = testGame({ startingPlayer: 'p2' });
  t.p1.conjureOntoBattlefield('Abhorrent Oculus');
  // Two cards on top, the first of which is the one we want manifested.
  const [wanted] = t.p1.libraryTop(name, 'Island');
  // The Oculus triggers at the beginning of each opponent's upkeep.
  t.begin('beginning', 'upkeep');
  t.auto();
  t.resolveAll();

  const iid = t.state.zones.p1.battlefield.find((i) => t.state.cards[i].faceDown);
  if (iid === undefined) throw new Error('nothing was manifested');
  expect(iid).toBe(wanted);
  return { t, iid };
}

describe('a manifested permanent', () => {
  it('is a 2/2 creature with no name and no other types', () => {
    const { t, iid } = manifested('Orcish Bowmasters');
    const face = currentFace(t.state.cards[iid]);

    expect(face.types).toEqual(['Creature']);
    expect(face.name).not.toBe('Orcish Bowmasters');
    expect(powerOf(t.state, t.state.cards[iid])).toBe(2);
    expect(toughnessOf(t.state, t.state.cards[iid])).toBe(2);
  });

  it('has no abilities, whatever the card under it is', () => {
    const { t, iid } = manifested('Orcish Bowmasters');
    // The real card has one; the face-down object must not reach it.
    expect(getScript(oracleByName('Orcish Bowmasters').oracleId)?.abilities?.length).toBeGreaterThan(
      0,
    );
    expect(scriptIdOf(t.state.cards[iid])).not.toBe(
      oracleByName('Orcish Bowmasters').oracleId,
    );
    expect(getScript(scriptIdOf(t.state.cards[iid]))).toBeUndefined();
  });

  it('does not trigger off the opponent drawing, the way the real card would', () => {
    const { t, iid } = manifested('Orcish Bowmasters');
    const lifeBefore = t.state.players.p2.life;
    t.game.draw('p2', 3);
    t.resolveAll();

    // A real Bowmasters would have pinged for two of those draws.
    expect(t.state.players.p2.life).toBe(lifeBefore);
    expect(t.state.cards[iid].faceDown).toBe(true);
  });

  it('offers no mana when the card under it is a land', () => {
    const { t, iid } = manifested('Mystic Sanctuary');
    const mana = t.game
      .legalActions('p1')
      .filter((a) => a.intent.t === 'tapForMana' && a.intent.iid === iid);
    expect(mana).toEqual([]);
  });

  it('turns face up for its mana cost, and is itself again afterwards', () => {
    const { t, iid } = manifested('Orcish Bowmasters');
    t.p1.manaBase(2);
    t.begin();
    // It is p2's turn, so p1 has to be given priority before it can act.
    t.p2.pass();

    const turn = t.game
      .legalActions('p1')
      .find((a) => a.intent.t === 'turnFaceUp' && a.intent.iid === iid);
    expect(turn).toBeDefined();
    t.intent('p1', turn!.intent);

    expect(t.state.cards[iid].faceDown).toBeFalsy();
    expect(currentFace(t.state.cards[iid]).name).toBe('Orcish Bowmasters');
    expect(getScript(scriptIdOf(t.state.cards[iid]))?.abilities?.length).toBeGreaterThan(0);
  });
});

describe('what each seat is told about it', () => {
  it('never names it to the opponent', () => {
    const { t, iid } = manifested('Orcish Bowmasters');
    const theirs = redact(t.state, 'p2');
    const card = theirs.cards[iid];

    expect(card).toBeDefined();
    expect(card!.faceDown).toBe(true);
    expect(card!.oracleId).toBe(FACE_DOWN_ORACLE_ID);
    // Nowhere else in their view either.
    expect(JSON.stringify(theirs)).not.toContain('orcish_bowmasters');
  });

  it('lets its controller look at their own', () => {
    const { t, iid } = manifested('Orcish Bowmasters');
    const mine = redact(t.state, 'p1');
    const card = mine.cards[iid];

    expect(card!.faceDown).toBe(true);
    expect(card!.oracleId).toBe(oracleByName('Orcish Bowmasters').oracleId);
  });

  it('shows both seats the same 2/2', () => {
    const { t, iid } = manifested('Atraxa, Grand Unifier');
    for (const seat of ['p1', 'p2'] as PlayerId[]) {
      const card = redact(t.state, seat).cards[iid];
      expect(card!.power).toBe(2);
      expect(card!.toughness).toBe(2);
    }
  });
});
