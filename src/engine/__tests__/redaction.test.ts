import { describe, expect, it } from 'vitest';
import { testGame } from './harness.js';
import { redact } from '../redact.js';
import type { PlayerId } from '../types.js';

/**
 * DESIGN.md 14.3 — information leaks.
 *
 * In a mirror where both players know the decklist by heart, the only secrets left
 * are order and count. These are the tests that protect them.
 */

function leaks(view: unknown, iids: number[]): boolean {
  const cards = (view as { cards: Record<number, unknown> }).cards;
  return iids.some((iid) => cards[iid] !== undefined);
}

describe('redaction', () => {
  it("never reveals the opponent's hand", () => {
    const t = testGame();
    t.p2.hand('Atraxa, Grand Unifier', 'Mana Drain', 'Omniscience');
    t.begin();

    const view = redact(t.state, 'p1');
    expect(view.players.p2.handCount).toBe(3);
    expect(leaks(view, t.state.zones.p2.hand)).toBe(false);
    for (const name of ['atraxa', 'mana_drain', 'omniscience']) {
      expect(JSON.stringify(view)).not.toContain(`"oracleId":"${name}`);
    }
  });

  it('never reveals library order, not even to the library owner', () => {
    const t = testGame();
    t.begin();
    const view = redact(t.state, 'p1');
    expect(view.players.p1.libraryCount).toBe(60);
    expect(leaks(view, t.state.zones.p1.library)).toBe(false);
    // There is no field carrying an ordered library anywhere in the view.
    expect(Object.keys(view)).not.toContain('library');
  });

  it('shows both graveyards in full — Delve makes them public information', () => {
    const t = testGame();
    t.p1.graveyard('Brainstorm', 'Mana Drain');
    t.p2.graveyard('Show and Tell');
    t.begin();

    const view = redact(t.state, 'p1');
    expect(view.graveyard.p1).toHaveLength(2);
    expect(view.graveyard.p2).toHaveLength(1);
    expect(leaks(view, t.state.zones.p2.graveyard)).toBe(true);
  });

  it('hides a Show and Tell pick until both players have committed', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Omniscience');
    t.p1.manaBase(3);
    t.p2.hand('Atraxa, Grand Unifier');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();
    t.secret('p1', 'Omniscience');

    const p2View = redact(t.state, 'p2');
    expect(p2View.choice?.kind).toBe('simultaneousSecret');
    if (p2View.choice?.kind === 'simultaneousSecret') {
      expect(p2View.choice.opponentLockedIn).toBe(true);
      // p2's own options only.
      const ids = p2View.choice.myOptions.map((o) => o.iid);
      expect(ids).toEqual(t.state.zones.p2.hand);
    }
    expect(JSON.stringify(p2View)).not.toContain('secretResponses');
    expect(leaks(p2View, t.state.zones.p1.hand)).toBe(false);
  });

  it('shows a search only to the player searching', () => {
    const t = testGame();
    t.p1.hand('Demonic Tutor');
    t.p1.manaBase(2);
    t.begin();

    t.p1.cast('Demonic Tutor');
    t.resolveStack();
    expect(t.expectChoice().kind).toBe('chooseCards');

    const searcher = redact(t.state, 'p1');
    const bystander = redact(t.state, 'p2');
    expect(searcher.choice).not.toBeNull();
    expect(bystander.choice).toBeNull();
    expect(bystander.waitingOnOpponentChoice).toBe(true);
    // The 60 revealed library cards reach p1 only.
    expect(Object.keys(searcher.cards).length).toBeGreaterThan(Object.keys(bystander.cards).length);
  });

  it('shows a surveil only to its controller', () => {
    const t = testGame();
    t.p1.hand('Hedge Maze');
    t.begin();

    t.p1.playLand('Hedge Maze');
    t.resolveStack();
    expect(t.expectChoice().kind).toBe('chooseCards');

    const opponent = redact(t.state, 'p2');
    expect(opponent.choice).toBeNull();
    expect(leaks(opponent, t.state.zones.p1.library.slice(0, 1))).toBe(false);
  });

  it("Atraxa's reveal IS public, so both players see the same ten cards", () => {
    const t = testGame();
    t.p1.hand('Atraxa, Grand Unifier');
    t.p1.manaBase(7);
    t.begin();

    t.p1.cast('Atraxa, Grand Unifier');
    t.resolveStack();
    const choice = t.expectChoice();
    expect(choice.kind).toBe('chooseCards');
    if (choice.kind !== 'chooseCards') return;
    expect(choice.publicReveal).toBe(true);

    const opponent = redact(t.state, 'p2');
    // p2 cannot answer the choice, but does get to see the revealed cards.
    expect(opponent.choice).toBeNull();
    expect(leaks(opponent, choice.options.map((o) => o.iid))).toBe(true);
  });

  it('reports the same public facts to both players', () => {
    const t = testGame();
    t.p1.battlefield('Omniscience');
    t.p2.battlefield('Atraxa, Grand Unifier');
    t.p1.life(11);
    t.begin();

    const a = redact(t.state, 'p1');
    const b = redact(t.state, 'p2');
    for (const p of ['p1', 'p2'] as PlayerId[]) {
      expect(a.players[p].life).toBe(b.players[p].life);
      expect(a.players[p].handCount).toBe(b.players[p].handCount);
      expect(a.battlefield[p]).toEqual(b.battlefield[p]);
    }
    expect(a.turn).toBe(b.turn);
    expect(a.priorityPlayer).toBe(b.priorityPlayer);
  });

  it('only offers legal actions to the player who holds priority', () => {
    const t = testGame();
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.begin();

    expect(redact(t.state, 'p1').legalActions.length).toBeGreaterThan(0);
    expect(redact(t.state, 'p2').legalActions).toHaveLength(0);
  });
});
