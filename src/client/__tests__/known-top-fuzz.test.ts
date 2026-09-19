import { describe, expect, it } from 'vitest';
import { RandomBot } from '@engine/__tests__/bot';
import { Game } from '@engine/game';
import { oracleByName } from '@engine/oracle';
import { redactEvents } from '@engine/redact';
import { applyEventsToKnownTop, emptyKnownTop, type KnownTopEntry } from '../known-top';
import type { GameState, PlayerId } from '@engine/types';

/**
 * The panel is right, or it is worse than nothing.
 *
 * "It remembers what a Brainstorm put back" is a claim about one card, and the
 * two tests that made it were the only ones there were. The claim that matters
 * is the general one — whatever the panel lists really is the top of that
 * library, in that order, at every moment of a game — and the only honest way to
 * check it is to play games and look after every single event.
 *
 * Driven off the engine rather than the store, for the same reason the arena is:
 * the tracker is a pure reducer over the events a seat was sent, so it can be run
 * against whole random games without a browser, a timer or an auto-pass layer in
 * the way. What it consumes here is exactly `redactEvents(state, seat, …)` —
 * byte for byte what that seat receives over the wire.
 */

/** Where the tracker and the real library first disagree, or null. */
function divergence(state: GameState, seat: PlayerId, known: KnownTopEntry[]): string | null {
  const library = state.zones[seat].library;
  for (const [i, entry] of known.entries()) {
    if (library[i] !== entry.iid) {
      return `position ${i + 1}: panel says iid ${entry.iid}, library has ${
        library[i] ?? 'nothing (the panel is longer than the library)'
      }`;
    }
    // A remembered name that is not the card actually sitting there is the
    // failure a playtester would actually see.
    const real = state.cards[library[i]];
    if (entry.oracleId && real && real.oracleId !== entry.oracleId) {
      return `position ${i + 1}: panel says ${entry.oracleId}, library has ${real.oracleId}`;
    }
  }
  return null;
}

/**
 * A deck that is nothing but the cards this panel exists for.
 *
 * The real sixty casts a Brainstorm every few games under random play, which is
 * far too rare to establish anything: the first run of this test watched forty
 * whole games and found the panel non-empty nine times. Stacking the deck is not
 * cheating here — the tracker's rules do not know what deck it is, and the point
 * is to reach the states it has rules for.
 */
function cantripGame(seed: number): Game {
  const deck = [
    { oracleId: oracleByName('Brainstorm').oracleId, count: 16 },
    { oracleId: oracleByName('Ponder').oracleId, count: 16 },
    { oracleId: oracleByName('Mystic Sanctuary').oracleId, count: 8 },
    { oracleId: oracleByName('Island').oracleId, count: 20 },
  ];
  const game = Game.create({
    gameId: `known-top-${seed}`,
    seed,
    deck,
    startingPlayer: seed % 2 === 0 ? 'p1' : 'p2',
  });
  game.advance();
  return game;
}

describe('the top-of-library panel, across random games', () => {
  const seeds = Array.from({ length: 40 }, (_, i) => i + 1);

  it('never claims a card that is not there', () => {
    const failures: string[] = [];
    let everKnew = 0;
    let deepest = 0;

    for (const seed of seeds) {
      const game = cantripGame(seed);
      const bot = new RandomBot(seed * 7919);
      let known = emptyKnownTop();

      for (let step = 0; step < 600; step++) {
        if (game.state.winner !== null) break;

        const events = game.flushEvents();
        if (events.length > 0) {
          for (const seat of ['p1', 'p2'] as PlayerId[]) {
            known = {
              ...known,
              [seat]: applyEventsToKnownTop(
                known,
                redactEvents(game.state, seat, events),
                (iid) => game.state.cards[iid]?.oracleId,
              )[seat],
            };
          }
        }

        for (const seat of ['p1', 'p2'] as PlayerId[]) {
          const n = known[seat].length;
          if (n > 0) everKnew++;
          deepest = Math.max(deepest, n);
          const bad = divergence(game.state, seat, known[seat]);
          if (bad) failures.push(`seed ${seed} step ${step} ${seat}: ${bad}`);
        }
        if (failures.length > 0) break;

        if (!bot.step(game)) break;
      }
      if (failures.length > 0) break;
    }

    // The check is worthless if the panel was empty the whole way through.
    expect(everKnew).toBeGreaterThan(200);
    expect(deepest).toBeGreaterThan(2);
    expect(failures.slice(0, 5)).toEqual([]);
  });
});
