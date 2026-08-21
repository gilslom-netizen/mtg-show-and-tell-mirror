import { describe, expect, it } from 'vitest';
import { testGame } from './harness.js';

/** Priority, passing, auto-pass and backing out of a half-finished action. */

describe('priority', () => {
  it('hands priority back to the active player after a spell is cast', () => {
    const t = testGame({ startingPlayer: 'p1' });
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.p2.hand('Mana Drain');
    t.p2.manaBase(2);
    t.begin();

    t.p1.cast('Brainstorm');
    // Not the caster — the active player.
    expect(t.state.priorityPlayer).toBe('p1');
    t.p1.pass();
    expect(t.state.priorityPlayer).toBe('p2');
  });

  it('resolves the top of the stack once both players pass', () => {
    const t = testGame();
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.begin();

    t.p1.cast('Brainstorm');
    t.p1.pass();
    t.p2.pass();
    // Brainstorm is mid-resolution and asking which cards to put back. CR 608.2m:
    // the spell stays on the stack until the very last step of its resolution.
    expect(t.expectChoice().kind).toBe('chooseCards');
    t.auto();
    expect(t.state.stack).toHaveLength(0);
    expect(t.p1.graveyardNames()).toEqual(['Brainstorm']);
  });

  it('rejects an action from the player who does not hold priority', () => {
    const t = testGame();
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.p2.hand('Brainstorm');
    t.p2.manaBase(1);
    t.begin();
    expect(() => t.p2.cast('Brainstorm')).toThrow(/priority/i);
  });

  it('holding priority keeps it with the caster', () => {
    const t = testGame();
    t.p1.hand('Brainstorm', 'Brainstorm');
    t.p1.manaBase(2);
    t.begin();

    t.p1.cast('Brainstorm', { hold: true });
    expect(t.state.priorityPlayer).toBe('p1');
    t.p1.cast('Brainstorm', { hold: true });
    expect(t.state.stack).toHaveLength(2);
  });

  it('auto-passes a player who has nothing but mana abilities available', () => {
    const t = testGame({ autoPass: true });
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    // p2 has lands but no cards, so tapping for mana is all they could do.
    t.p2.manaBase(2);
    t.begin();

    t.p1.cast('Brainstorm');
    // p1 has nothing left, p2 has only mana abilities: both auto-pass and the
    // spell resolves straight through to its own choice.
    expect(t.expectChoice().kind).toBe('chooseCards');
  });
});

describe('backing out of an action', () => {
  it('restores the board when a cast is cancelled mid-choice', () => {
    const t = testGame();
    t.p1.hand('Dig Through Time');
    t.p1.manaBase(2);
    t.p1.graveyard('Brainstorm', 'Brainstorm', 'Mana Drain', 'Veil of Summer', 'Brainstorm', 'Mana Drain');
    t.begin();

    const landsBefore = t.state.zones.p1.battlefield.filter((i) => t.state.cards[i].tapped).length;
    t.p1.cast('Dig Through Time');
    expect(t.expectChoice().kind).toBe('chooseCards'); // the delve prompt

    expect(t.game.cancelPendingAction('p1')).toBe(true);
    expect(t.state.pendingChoice).toBeNull();
    expect(t.p1.handNames()).toContain('Dig Through Time');
    expect(t.state.stack).toHaveLength(0);
    expect(t.state.zones.p1.graveyard).toHaveLength(6);
    expect(t.state.zones.p1.battlefield.filter((i) => t.state.cards[i].tapped).length).toBe(
      landsBefore,
    );
  });

  it('belongs to the player who started the action, and never rewinds past it', () => {
    const t = testGame();
    t.p1.hand('Dig Through Time');
    t.p1.manaBase(2);
    // Six cards in the graveyard reduce the cost to {U}{U}, which two lands cover.
    t.p1.graveyard('Brainstorm', 'Brainstorm', 'Mana Drain', 'Mana Drain', 'Veil of Summer', 'Show and Tell');
    t.begin();

    expect(t.game.cancelPendingAction('p2')).toBe(false);
    t.p1.cast('Dig Through Time');
    expect(t.game.cancelPendingAction('p1')).toBe(true);
    const after = JSON.stringify(t.state);

    // Cancelling again is a no-op: the consumed snapshot is replaced by one taken
    // at the position we are now in, so there is nothing further to rewind.
    t.game.cancelPendingAction('p1');
    expect(JSON.stringify(t.state)).toBe(after);
    expect(t.p1.handNames()).toContain('Dig Through Time');
    expect(t.state.zones.p1.graveyard).toHaveLength(6);
  });

  it('cannot rewind a spell that is already resolving', () => {
    // Once a spell starts resolving the opponent has seen it, and the choices it
    // raises belong to the resolution rather than to the cast.
    const t = testGame();
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.begin();

    t.p1.cast('Brainstorm');
    t.resolveStack();
    expect(t.expectChoice().kind).toBe('chooseCards');
    expect(t.game.cancelPendingAction('p1')).toBe(false);
  });
});
