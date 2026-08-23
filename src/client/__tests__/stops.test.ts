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

describe('settings defaults', () => {
  it('does not hold priority under Omniscience unless asked', () => {
    // Holding for every spell of a combo turn is a click per spell, not a comfort.
    expect(DEFAULT_SETTINGS.autoHoldUnderOmniscience).toBe(false);
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
