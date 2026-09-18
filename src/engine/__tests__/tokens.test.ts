import { describe, expect, it } from 'vitest';
import { testGame, type TestGame } from './harness.js';
import { CLUE } from '../cards/tokens.js';
import { getScript, unimplementedReason } from '../cards/index.js';
import { draftPoolOracleIds } from '../draft-pool.js';
import { MAINDECK } from '../deck.js';
import { oracle } from '../oracle.js';
import { currentFace, scriptIdOf, tokenFace } from '../state.js';
import { redact } from '../redact.js';
import type { IID, PlayerId } from '../types.js';

/**
 * Tokens as permanents in their own right.
 *
 * The Clue is why this file exists. It was created as an artifact, drawn as a
 * 0/0 creature and had no ability at all, so the one thing a Clue is for —
 * paying two and sacrificing it to draw — was not reachable from the table. The
 * three halves of that bug lived in three files, which is what these tests pin
 * down separately.
 */

/** Tamiyo on the battlefield, attacking, so her investigate trigger resolves. */
function clueOnBoard(): { t: TestGame; clue: IID } {
  const t = testGame({ startingPlayer: 'p1' });
  t.p1.conjureOntoBattlefield('Tamiyo, Inquisitive Student');
  t.begin('combat', 'declare_attackers');
  const tamiyo = t.p1.find('Tamiyo, Inquisitive Student', 'battlefield');
  t.answer({ kind: 'attackers', iids: [tamiyo] }, 'p1');
  // The investigate trigger goes on the stack like any other; let it resolve.
  t.resolveAll();
  const clue = t.state.zones.p1.battlefield.find((i) => t.state.cards[i].isToken);
  if (clue === undefined) throw new Error('Tamiyo did not investigate');
  return { t, clue };
}

describe('the Clue token', () => {
  it('is an artifact, not a creature, and has no power or toughness', () => {
    const { t, clue } = clueOnBoard();
    const face = currentFace(t.state.cards[clue]);

    expect(face.types).toEqual(['Artifact']);
    expect(face.types).not.toContain('Creature');
    expect(face.typeLine).toBe('Token Artifact — Clue');
    // CR 208.3. A 0/0 here is not a cosmetic slip: it is a creature that
    // state-based actions should have put into the graveyard on arrival.
    expect(face.power).toBeNull();
    expect(face.toughness).toBeNull();
  });

  it('survives the state-based action pass that kills a 0/0', () => {
    const { t, clue } = clueOnBoard();
    t.game.sbaDirtyForTests();
    t.game.advance();
    expect(t.state.zones.p1.battlefield).toContain(clue);
  });

  it('carries its script, so the engine can find its ability', () => {
    const { t, clue } = clueOnBoard();
    expect(scriptIdOf(t.state.cards[clue])).toBe(CLUE);
    expect(getScript(scriptIdOf(t.state.cards[clue]))?.abilities).toHaveLength(1);
  });

  it('offers "{2}, Sacrifice this artifact: Draw a card" once two mana are available', () => {
    const { t, clue } = clueOnBoard();
    const offered = () =>
      t.game
        .legalActions('p1')
        .filter((a) => a.intent.t === 'activateAbility' && a.intent.iid === clue);

    // No mana: the ability is real but unaffordable, the same as any other.
    expect(offered()).toHaveLength(0);
    t.p1.manaBase(2);
    expect(offered()).toHaveLength(1);
  });

  it('draws a card and goes away when sacrificed', () => {
    const { t, clue } = clueOnBoard();
    t.p1.manaBase(2);
    const handBefore = t.p1.handSize();

    t.intent('p1', { t: 'activateAbility', iid: clue, index: 0 });
    // The sacrifice is part of the cost, so the Clue is gone before the ability
    // is even on the stack.
    expect(t.state.zones.p1.battlefield).not.toContain(clue);
    t.resolveStack();

    expect(t.p1.handSize()).toBe(handBefore + 1);
    // A token that leaves the battlefield ceases to exist (CR 111.7).
    expect(t.state.zones.p1.graveyard).not.toContain(clue);
  });

  it('can be redacted while its own ability is on the stack', () => {
    const { t, clue } = clueOnBoard();
    t.p1.manaBase(2);
    t.intent('p1', { t: 'activateAbility', iid: clue, index: 0 });
    expect(t.state.stack).toHaveLength(1);

    // The ability object outlives the token that made it, and redaction reads a
    // face off every card on the stack — including this one, which has no oracle
    // entry to read. Both seats, because it is public either way.
    for (const seat of ['p1', 'p2'] as PlayerId[]) {
      expect(() => redact(t.state, seat)).not.toThrow();
      const view = redact(t.state, seat);
      expect(view.stack).toHaveLength(1);
    }
  });

  it('tells the client what it is, rather than leaving it to guess', () => {
    const { t, clue } = clueOnBoard();
    for (const seat of ['p1', 'p2'] as PlayerId[]) {
      const view = redact(t.state, seat);
      const card = view.cards[clue];
      expect(card).toBeDefined();
      expect(card!.tokenTypeLine).toBe('Token Artifact — Clue');
      expect(card!.tokenTypes).toEqual(['Artifact']);
      expect(card!.tokenText).toContain('Sacrifice this artifact');
      // No power or toughness reaches the view, so nothing can print a 0/0.
      expect(card!.power).toBeUndefined();
      expect(card!.toughness).toBeUndefined();
    }
  });
});

describe('creature tokens are unchanged', () => {
  it('still read as creatures, with their power and toughness', () => {
    const face = tokenFace({
      name: 'Otter',
      types: ['Creature'],
      subtypes: ['Otter'],
      colors: ['U', 'R'],
      power: 1,
      toughness: 1,
    });
    expect(face.typeLine).toBe('Token Creature — Otter');
    expect(face.power).toBe('1');
    expect(face.toughness).toBe('1');
  });

  it('name a token with no subtypes by its types alone', () => {
    const face = tokenFace({ name: 'Treasure', types: ['Artifact'], subtypes: [], colors: [] });
    expect(face.typeLine).toBe('Token Artifact');
  });
});

/**
 * The audit the Clue earned.
 *
 * Every artifact and enchantment in the pool has to be reachable: either it has
 * a script, or everything it does is behaviour the engine already provides — for
 * a Mox, the unconditional "{T}: Add" that comes straight off the card data. A
 * permanent that is neither is a card that sits on the battlefield doing nothing,
 * which is exactly the shape of the bug this file is named after.
 */
describe('every artifact and enchantment in the pool does something', () => {
  const ids = [...new Set([...draftPoolOracleIds(), ...MAINDECK.map((e) => e.oracleId)])];
  const permanents = ids.filter((id) => {
    const c = oracle(id);
    const types = new Set((c.faces ?? [c]).flatMap((f) => f.types));
    return types.has('Artifact') || types.has('Enchantment');
  });

  it('has some to check', () => {
    expect(permanents.length).toBeGreaterThan(10);
  });

  it.each(permanents)('%s is playable and has behaviour', (id) => {
    expect(unimplementedReason(id)).toBeNull();
    const c = oracle(id);
    const hasScript = getScript(id) !== undefined;
    const tapsForMana = (c.faces ?? [c]).some((f) => f.producedMana.length > 0);
    expect(hasScript || tapsForMana).toBe(true);
  });
});
