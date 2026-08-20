import { describe, expect, it } from 'vitest';
import { RandomBot, newGame, stateHash } from './bot';
import type { GameState, IID, PlayerId } from '../types';

/**
 * DESIGN.md 14.4 — property tests.
 *
 * Random legal play across many games, asserting things that must hold in every
 * reachable state. This is what catches zone-transition bugs that no hand-written
 * test thought to look for.
 */

function checkInvariants(s: GameState): void {
  for (const p of ['p1', 'p2'] as PlayerId[]) {
    const z = s.zones[p];
    const onStack = s.stack.filter((i) => {
      const c = s.cards[i];
      return c && c.owner === p && !c.isAbility && !c.isToken;
    }).length;
    const total =
      z.library.length + z.hand.length + z.graveyard.length + z.exile.length + onStack +
      z.battlefield.filter((i) => !s.cards[i]?.isToken).length;

    if (total !== 60) {
      throw new Error(`${p} has ${total} cards across zones, expected 60`);
    }

    // A card may only appear in one zone.
    const all = [...z.library, ...z.hand, ...z.battlefield, ...z.graveyard, ...z.exile];
    if (new Set(all).size !== all.length) {
      throw new Error(`${p} has a card in two zones at once`);
    }

    // Each card's own `zone` field must agree with the zone list it is in.
    for (const [zoneName, list] of Object.entries(z)) {
      for (const iid of list as IID[]) {
        const c = s.cards[iid];
        if (!c) throw new Error(`${p}'s ${zoneName} references a card that does not exist`);
        if (c.zone !== zoneName) {
          throw new Error(`${c.oracleId} says it is in ${c.zone} but sits in ${zoneName}`);
        }
      }
    }

    if (s.players[p].life > 100) throw new Error('life total is implausible');
  }

  // Unless the game is over, someone must be able to act.
  if (s.winner === null && s.priorityPlayer === null && s.pendingChoice === null) {
    // Legal only in the middle of a step transition, which is never observed
    // from outside advance().
    throw new Error('nobody has priority and no choice is pending');
  }
}

describe('invariants under random play', () => {
  it('holds across 150 random games', () => {
    let finished = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const game = newGame(seed, seed % 2 === 0 ? 'p1' : 'p2');
      const bot = new RandomBot(seed * 7919);
      // Check after every single action, not just at the end.
      const origAdvance = game.advance.bind(game);
      game.advance = () => {
        origAdvance();
        checkInvariants(game.state);
      };
      const result = bot.play(game, 1500);
      if (result.finished) finished++;
      checkInvariants(game.state);
    }
    // Most random games should actually reach a conclusion within the budget.
    expect(finished).toBeGreaterThan(100);
  });

  it('is deterministic: the same seeds always produce the same game', () => {
    const run = (seed: number) => {
      const game = newGame(seed);
      new RandomBot(seed * 31).play(game, 1500);
      return stateHash(game.state);
    };
    for (const seed of [3, 17, 42]) {
      expect(run(seed)).toBe(run(seed));
    }
    expect(run(3)).not.toBe(run(17));
  });

  it('never leaves a game hanging with nobody to act', () => {
    for (let seed = 200; seed < 220; seed++) {
      const game = newGame(seed);
      const result = new RandomBot(seed).play(game, 2000);
      if (!result.finished) {
        // Still running is fine, but it must be running on someone's decision.
        expect(
          game.state.pendingChoice !== null || game.state.priorityPlayer !== null,
        ).toBe(true);
      }
    }
  });

  it('ends games for a legitimate reason', () => {
    const reasons = new Set<string>();
    for (let seed = 300; seed < 340; seed++) {
      const game = newGame(seed);
      const result = new RandomBot(seed * 13).play(game, 2000);
      if (result.finished) {
        expect(game.state.endReason).toBeTruthy();
        reasons.add(game.state.endReason!);
      }
    }
    for (const r of reasons) {
      expect(['life total reached 0', 'tried to draw from an empty library', 'conceded']).toContain(r);
    }
  });
});
