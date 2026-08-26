import { describe, expect, it, vi } from 'vitest';
import { ERRATA, errataFor, frontFace, manaValueOf, oracle, oracleByName } from '../oracle.js';
import { testGame, type TestGame } from './harness.js';
import type { PlayerId } from '../types.js';
import { ORACLE_DATA } from '../generated/oracle-cards.gen.js';

/**
 * House changes to printed cards.
 *
 * This is a custom format built out of real cards, so some of them are not the
 * cards they were printed as — a four-mana counterspell arrives a turn after these
 * games are decided, and a mill-one trigger does not threaten a sixty card library
 * inside twelve turns. The changes live in data/errata.json and are applied on top
 * of the Scryfall snapshot rather than written into it.
 *
 * What these tests are for is the failure mode that has no symptoms: an erratum
 * that stops applying. Rename a card upstream, mistype an apostrophe, forget to
 * re-run gen:data, and the card silently goes back to its printed cost with
 * nothing anywhere saying so.
 */

const printed = new Map(
  (ORACLE_DATA as { cards: { name: string; mana_cost?: string; oracle_text?: string }[] }).cards.map(
    (c) => [c.name, c],
  ),
);

describe('the errata layer', () => {
  it('changes every card it claims to change', () => {
    expect(ERRATA.length).toBeGreaterThan(0);
    for (const e of ERRATA) {
      const card = oracleByName(e.name);
      if (e.mana_cost !== undefined) expect(card.manaCost, e.name).toBe(e.mana_cost);
      if (e.oracle_text !== undefined) expect(card.oracleText, e.name).toBe(e.oracle_text);
      // Every one of them says why. A house rule nobody can read the reason for is
      // indistinguishable from a bug.
      expect(e.why, e.name).toBeTruthy();
    }
  });

  it('recomputes mana value from the new cost rather than carrying the old one', () => {
    for (const e of ERRATA) {
      if (e.mana_cost === undefined) continue;
      const card = oracleByName(e.name);
      expect(card.mv, e.name).toBe(manaValueOf(e.mana_cost));
      // And it really moved, or the entry is doing nothing.
      expect(card.manaCost, e.name).not.toBe(printed.get(e.name)?.mana_cost);
    }
  });

  it('says which cards were changed, and only those', () => {
    for (const e of ERRATA) expect(errataFor(e.name)).not.toBeNull();
    expect(errataFor('Show and Tell')).toBeNull();
    expect(errataFor('Brainstorm')).toBeNull();
  });

  /*
   * The four the format asked for, spelled out.
   *
   * Named rather than counted, because the point of each is a specific number: a
   * two-mana Ashiok's Erasure is a counterspell you can hold up on turn two, and a
   * four-mana one is a card you never cast. If one of these ever changes it should
   * be because somebody meant it.
   */
  it('plays these four as the format wants them', () => {
    expect(oracleByName("Ashiok's Erasure").manaCost).toBe('{U}{U}');
    expect(oracleByName("Ashiok's Erasure").mv).toBe(2);

    expect(oracleByName("Jace's Erasure").oracleText).toContain('mill two cards');
    expect(oracleByName("Jace's Erasure").manaCost).toBe('{1}{U}');

    expect(oracleByName('Lier, Disciple of the Drowned').manaCost).toBe('{1}{U}{U}');
    expect(oracleByName('Lier, Disciple of the Drowned').mv).toBe(3);

    expect(oracleByName('Eternal Witness').manaCost).toBe('{2}{G}');
    // Same mana value as printed; what changed is that one pip has to be green
    // instead of two, which is the difference between castable and not.
    expect(oracleByName('Eternal Witness').mv).toBe(3);
  });

  /**
   * A name that matches nothing must be loud.
   *
   * This is the one that keeps the rest honest. Every other test here would still
   * pass if an erratum silently stopped applying to a card nobody thought to
   * assert on — the card would just quietly go back to being the printed one.
   */
  it('refuses to start when an erratum names a card that does not exist', async () => {
    vi.resetModules();
    vi.doMock('../generated/errata.gen.js', () => ({
      ERRATA_DATA: { cards: [{ name: 'Black Lotus', why: 'test', mana_cost: '{0}' }] },
    }));
    await expect(import('../oracle.js')).rejects.toThrow(/not in the pool.*Black Lotus/s);
    vi.doUnmock('../generated/errata.gen.js');
    vi.resetModules();
  });

  it('leaves everything else exactly as printed', () => {
    const changed = new Set(ERRATA.map((e) => e.name));
    for (const [name, card] of printed) {
      if (changed.has(name)) continue;
      const built = oracleByName(name);
      // Modal DFCs carry their cost on the front face, not the card.
      if (built.layout === 'modal_dfc') continue;
      expect(built.manaCost ?? '', name).toBe(card.mana_cost ?? '');
      expect(built.oracleText, name).toBe(card.oracle_text ?? '');
    }
  });
});

/**
 * The errata as the engine plays them, not as the data file states them.
 *
 * A cost written in a JSON file is a claim; what settles it is whether the card is
 * castable off the mana the change was meant to make it castable off. Every one of
 * these puts the card in a hand with exactly the lands its new cost needs and no
 * more, so it would not be offered if the erratum had not landed.
 */
/**
 * Run everything out, pointing every mill trigger at `at` — or declining it all
 * when `at` is null. Anything else that comes up is answered the harness's way.
 */
function settle(t: TestGame, at: PlayerId | null): void {
  for (let guard = 0; guard < 80; guard++) {
    const pc = t.state.pendingChoice;
    if (pc?.kind === 'chooseTargets' && pc.source?.oracleId === 'jaces_erasure') {
      const target = at ? pc.candidates.find((c) => c.kind === 'player' && c.id === at) : undefined;
      t.answer({ kind: 'targets', targets: target ? [target] : [] });
      continue;
    }
    if (pc) {
      // One at a time: `auto()` left to itself answers every open choice, and its
      // answer to an optional target is "no target" — which would decline exactly
      // the triggers this is here to point somewhere.
      t.auto(1);
      continue;
    }
    if (t.state.stack.length === 0 && t.state.pendingTriggers.length === 0) return;
    const p = t.state.priorityPlayer;
    if (!p) {
      t.game.advance();
      continue;
    }
    t.seat(p).pass();
  }
  throw new Error('the stack never settled');
}

describe('the errata in a game', () => {
  /** Every cast p1 could legally make right now, by card name. */
  function castable(t: TestGame): string[] {
    return t.game
      .legalActions('p1')
      .filter((a) => a.intent.t === 'castSpell')
      .map((a) => frontFace(t.state.cards[(a.intent as { iid: number }).iid].oracleId).name);
  }

  it("makes Ashiok's Erasure castable off two lands", () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Show and Tell');
    t.p2.manaBase(3);
    t.begin();
    t.p2.cast('Show and Tell');
    t.p2.pass();

    t.p1.conjure("Ashiok's Erasure");
    t.p1.manaBase(2);
    // Flash, and two mana is now the whole cost. At four it would not be here.
    expect(castable(t)).toContain("Ashiok's Erasure");
  });

  it('makes Lier castable on turn three', () => {
    const t = testGame();
    t.p1.conjure('Lier, Disciple of the Drowned');
    t.p1.manaBase(3);
    t.begin();
    expect(castable(t)).toContain('Lier, Disciple of the Drowned');
  });

  it('makes Eternal Witness castable off one green source', () => {
    const t = testGame();
    t.p1.conjure('Eternal Witness');
    // manaBase deals blue duals: exactly one of them makes green, which is the
    // whole point of the change — at {1}{G}{G} this hand could not cast it.
    t.p1.manaBase(3);
    t.begin();
    const green = t.state.zones.p1.battlefield.filter((iid) =>
      oracle(t.state.cards[iid].oracleId).producedMana.includes('G'),
    );
    expect(green.length).toBe(1);
    expect(castable(t)).toContain('Eternal Witness');
  });

  /**
   * The one erratum that is entirely behaviour: "mills two" is not a cost or a
   * type line, so nothing about it is visible until the card actually resolves.
   */
  it("mills two for Jace's Erasure, not one", () => {
    const t = testGame();
    t.p1.conjure("Jace's Erasure");
    t.p1.hand('Brainstorm');
    t.p1.manaBase(3);
    t.begin();
    t.p1.cast("Jace's Erasure");
    t.resolveStack();

    const before = t.state.zones.p2.graveyard.length;
    const library = t.state.zones.p2.library.length;
    t.p1.cast('Brainstorm');
    settle(t, 'p2');

    // Brainstorm draws three, so three triggers at two cards each.
    expect(t.state.zones.p2.graveyard.length - before).toBe(6);
    expect(library - t.state.zones.p2.library.length).toBe(6);
  });

  it('lets you decline the mill rather than forcing it', () => {
    const t = testGame();
    t.p1.conjure("Jace's Erasure");
    t.p1.hand('Brainstorm');
    t.p1.manaBase(3);
    t.begin();
    t.p1.cast("Jace's Erasure");
    t.resolveStack();

    const before = t.state.zones.p2.graveyard.length;
    t.p1.cast('Brainstorm');
    // "No target" is how the trigger's "you may" is expressed — and declining is a
    // real decision in a format that already loses a fifth of its games to an
    // empty library.
    settle(t, null);
    expect(t.state.zones.p2.graveyard.length).toBe(before);
  });
});
