import { describe, expect, it } from 'vitest';
import { frontFace } from '@engine/oracle';
import { redact } from '@engine/redact';
import type { TargetRef } from '@engine/types';
import { testGame } from '@engine/__tests__/harness';
import { bowmastersTarget, combatCanMatter, shouldStop } from '../hooks';
import { DEFAULT_SETTINGS, loadSettings, type Settings } from '../settings';

/**
 * The comfort layer decides how much of a turn a player has to click through.
 * These are the cases where getting it wrong is felt every single game.
 */

function withStops(patch: Partial<Settings['stops']>): Settings {
  return { ...DEFAULT_SETTINGS, stops: { ...DEFAULT_SETTINGS.stops, ...patch } };
}

describe('stopping in combat', () => {
  it('does not stop when nobody can attack', () => {
    const t = testGame();
    t.p1.battlefield('Island');
    t.begin();
    t.passUntil('begin_combat');
    for (const seat of ['p1', 'p2'] as const) {
      const view = redact(t.state, seat);
      expect(combatCanMatter(view)).toBe(false);
      expect(shouldStop(view, DEFAULT_SETTINGS, 'off')).toBe(false);
    }
  });

  it('stops for both players when the active player has a creature ready', () => {
    const t = testGame();
    t.p1.battlefield('Hullbreaker Horror');
    t.begin();
    t.passUntil('begin_combat');
    for (const seat of ['p1', 'p2'] as const) {
      const view = redact(t.state, seat);
      expect(combatCanMatter(view)).toBe(true);
    }
  });

  it('ignores a creature that could not attack anyway', () => {
    const t = testGame();
    t.p1.battlefieldTapped('Hullbreaker Horror');
    t.begin();
    t.passUntil('begin_combat');
    expect(combatCanMatter(redact(t.state, 'p1'))).toBe(false);
  });

  it('does not count the defender’s creatures as a reason to stop', () => {
    // Only the active player can attack, so their empty board is what decides it.
    const t = testGame();
    t.p2.battlefield('Hullbreaker Horror');
    t.begin();
    t.passUntil('begin_combat');
    expect(t.state.activePlayer).toBe('p1');
    expect(combatCanMatter(redact(t.state, 'p2'))).toBe(false);
  });

  it('still honours "always" and "never"', () => {
    const t = testGame();
    t.p1.battlefield('Island');
    // Something castable, or there is nothing to stop for and the engine passes
    // for us regardless of the setting.
    t.p1.hand('Brainstorm');
    t.begin();
    t.passUntil('begin_combat');
    const view = redact(t.state, 'p1');
    expect(shouldStop(view, withStops({ combat: 'always' }), 'off')).toBe(true);
    expect(shouldStop(view, withStops({ combat: 'never' }), 'off')).toBe(false);
  });
});

/**
 * Which spell on the stack is worth being stopped for.
 *
 * Reported as "you are holding priority on my own spells by default", and that is
 * exactly what it looked like: their Atraxa was at the bottom of a six-deep stack
 * with four of the player's own spells piled on top, so every single one of those
 * casts stopped on a decision that had been made four spells ago.
 */
describe('stopping for the stack', () => {
  /** Their spell on the stack, then one of mine on top of it. */
  function stacked() {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Atraxa, Grand Unifier');
    t.p2.manaBase(7);
    // Something castable, or there is nothing to stop for under 'ifIHaveAnswer'.
    t.p1.hand('Mana Drain', 'Orcish Bowmasters');
    t.p1.manaBase(4);
    t.begin();
    t.p2.cast('Atraxa, Grand Unifier');
    t.p2.pass();
    return t;
  }

  it('stops when the thing about to resolve is theirs', () => {
    const t = stacked();
    const view = redact(t.state, 'p1');
    expect(view.stack).toHaveLength(1);
    expect(shouldStop(view, DEFAULT_SETTINGS, 'off')).toBe(true);
  });

  it('does not stop again once your own spell is on top of theirs', () => {
    const t = stacked();
    t.p1.cast('Orcish Bowmasters');
    const view = redact(t.state, 'p1');
    // Theirs is still on the stack. It is no longer the decision in front of you.
    expect(view.stack).toHaveLength(2);
    expect(view.cards[view.stack[0]]?.controller).toBe('p2');
    expect(shouldStop(view, DEFAULT_SETTINGS, 'off')).toBe(false);
    // Not even for somebody who asked to be stopped every time.
    expect(shouldStop(view, withStops({ opponentSpellOnStack: 'always' }), 'off')).toBe(false);
  });

  /**
   * What "pass to end of turn" is and is not.
   *
   * A playtester put it exactly right: instead of passing the phases and letting
   * you answer cards, it was passing the cards and looking, from the seat, like
   * it had not passed anything. The run used to override every stop there is, so
   * their Show and Tell went on the stack in your end step and the client spent
   * the Mana Drain window without asking — the one window the whole deck is
   * built around.
   *
   * F6 means "do not ask me about steps". It has never meant "do not tell me
   * they are comboing off".
   */
  describe('during a "pass until…" run', () => {
    it('still stops for their spell', () => {
      const t = stacked();
      const view = redact(t.state, 'p1');
      for (const mode of ['endOfTurn', 'myNextTurn'] as const) {
        expect(shouldStop(view, DEFAULT_SETTINGS, mode)).toBe(true);
      }
    });

    it('respects the same setting it does the rest of the time', () => {
      const t = stacked();
      const view = redact(t.state, 'p1');
      expect(shouldStop(view, withStops({ opponentSpellOnStack: 'never' }), 'endOfTurn')).toBe(
        false,
      );
      expect(shouldStop(view, withStops({ opponentSpellOnStack: 'always' }), 'endOfTurn')).toBe(
        true,
      );
    });

    it('does not stop for a spell of your own on top of theirs', () => {
      const t = stacked();
      t.p1.cast('Orcish Bowmasters');
      const view = redact(t.state, 'p1');
      expect(shouldStop(view, DEFAULT_SETTINGS, 'endOfTurn')).toBe(false);
    });

    it('still skips the phase stops, which is the whole point of the run', () => {
      const t = testGame();
      t.p1.hand('Brainstorm');
      t.p1.manaBase(4);
      t.begin();
      const view = redact(t.state, 'p1');
      // My own main phase with something to do: an ordinary stop, and one the
      // run is explicitly there to skip.
      expect(view.stack).toHaveLength(0);
      expect(shouldStop(view, DEFAULT_SETTINGS, 'off')).toBe(true);
      expect(shouldStop(view, DEFAULT_SETTINGS, 'endOfTurn')).toBe(false);
    });
  });

  /**
   * The report this whole thing started from: two blue cards and a Commandeer in
   * hand, their spell on the stack, and the client passed without stopping.
   *
   * It was not the stop rule's fault — with no seven lands out there was no legal
   * cast to stop for, because the engine did not know Commandeer had another cost.
   * Which is exactly why this test lives here as well as in the engine: "can I
   * answer this?" is one question asked in two places, and it only reads the list
   * of legal actions.
   */
  it('stops for a spell you can only afford the other way', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Show and Tell');
    t.p2.manaBase(3);
    t.begin();
    t.p2.cast('Show and Tell');
    t.p2.pass();

    // No lands, so nothing in hand is castable for mana.
    t.p1.hand('Brainstorm', 'Dig Through Time');
    expect(shouldStop(redact(t.state, 'p1'), DEFAULT_SETTINGS, 'off')).toBe(false);

    t.p1.conjure('Commandeer');
    expect(shouldStop(redact(t.state, 'p1'), DEFAULT_SETTINGS, 'off')).toBe(true);
  });

  it('still honours "always" and "never" for a spell of theirs on top', () => {
    const t = stacked();
    const view = redact(t.state, 'p1');
    expect(shouldStop(view, withStops({ opponentSpellOnStack: 'always' }), 'off')).toBe(true);
    expect(shouldStop(view, withStops({ opponentSpellOnStack: 'never' }), 'off')).toBe(false);
  });
});

describe('settings defaults', () => {
  it('never holds priority on its own', () => {
    /*
     * There used to be a setting that held priority for you whenever an Omniscience
     * was out. It is gone rather than defaulted off: holding priority is for
     * responding to the opponent, and doing it for every spell of a combo turn adds
     * a click to each one while making the board look like it has stopped. `H` holds
     * priority at the moment you actually want to chain.
     */
    expect('autoHoldUnderOmniscience' in DEFAULT_SETTINGS).toBe(false);
  });

  it('migrates the old combat checkbox', () => {
    const store: Record<string, string> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    };
    store['satm.settings.v1'] = JSON.stringify({ stops: { combat: true } });
    expect(loadSettings().stops.combat).toBe('always');
    store['satm.settings.v1'] = JSON.stringify({ stops: { combat: false } });
    expect(loadSettings().stops.combat).toBe('never');
    store['satm.settings.v1'] = JSON.stringify({ stops: { combat: 'ifRelevant' } });
    expect(loadSettings().stops.combat).toBe('ifRelevant');
  });
});

describe('the Orcish Bowmasters policy', () => {
  /** A board where p2 controls whatever is named, and a Bowmasters trigger on p1. */
  function boardWith(...theirCreatures: string[]) {
    const t = testGame();
    t.p1.battlefield('Orcish Bowmasters');
    if (theirCreatures.length > 0) t.p2.battlefield(...theirCreatures);
    t.begin();
    const view = redact(t.state, 'p1');
    // Bowmasters can point at either player and at any creature on the table.
    const candidates: TargetRef[] = [
      { kind: 'player', id: 'p1' },
      { kind: 'player', id: 'p2' },
      ...[...view.battlefield.p1, ...view.battlefield.p2]
        .filter((iid) => frontFace(view.cards[iid]!.oracleId).types.includes('Creature'))
        .map((iid) => ({ kind: 'permanent', iid }) as TargetRef),
    ];
    return { view, candidates };
  }

  it('shoots their face when they have no creature', () => {
    const { view, candidates } = boardWith();
    expect(bowmastersTarget('ifUnambiguous', candidates, view, 'p1')).toEqual({
      kind: 'player',
      id: 'p2',
    });
  });

  it('asks once they have a creature, because then it is a real decision', () => {
    const { view, candidates } = boardWith('Atraxa, Grand Unifier');
    expect(bowmastersTarget('ifUnambiguous', candidates, view, 'p1')).toBeNull();
  });

  it('never points at your own board', () => {
    // p1's own Bowmasters is a creature and a legal target; it must not be picked.
    const { view, candidates } = boardWith();
    const chosen = bowmastersTarget('ifUnambiguous', candidates, view, 'p1');
    expect(chosen).not.toBeNull();
    expect(chosen).not.toMatchObject({ kind: 'permanent' });
  });

  it('honours "their face" and "ask me"', () => {
    const { view, candidates } = boardWith('Atraxa, Grand Unifier');
    expect(bowmastersTarget('opponentFace', candidates, view, 'p1')).toEqual({
      kind: 'player',
      id: 'p2',
    });
    expect(bowmastersTarget('ask', candidates, view, 'p1')).toBeNull();
  });
});
