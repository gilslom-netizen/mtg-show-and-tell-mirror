import { describe, expect, it } from 'vitest';
import { applyBid, applyKeep, createDraft, minimumBid, picksRequired, pileCards } from '../draft.js';
import { draftedCardPool } from '../session.js';
import { deckProblem } from '../../server/room.js';
import { unimplementedReason } from '../../engine/cards/index.js';
import { runToEnd } from '../../ai/arena.js';
import { HeuristicAgent } from '../../ai/heuristic.js';
import { Game } from '../../engine/game.js';
import type { DeckEntry } from '../../engine/state.js';
import type { PlayerId } from '../../engine/types.js';

/**
 * Can you actually play a draft?
 *
 * There is already a test saying every cube card has a script, and it is worth
 * much less than it sounds: a script that exists can still throw the moment it
 * meets a board it did not expect. "Every card is implemented" is a far smaller
 * claim than "a draft can be played", and only the second one is what anybody
 * wants to know.
 *
 * So this plays the whole thing: a real auction, real decks built out of what was
 * won, and the game itself driven to a winner by the same agent that plays the
 * single-player game. Nothing here is a mock — the deck is checked by the very
 * function the server uses to decide whether to accept a decklist, so a deck that
 * passes here is a deck the server would deal.
 */

/**
 * Both seats want cards and neither will overpay, which is enough to split a
 * draft roughly evenly. The earlier version of this had one seat want a pile only
 * on some piles, and it won sixteen cards to two — a lopsided draft that says
 * nothing about whether the format works.
 */
const CAP = 3;

function runDraft(seed: number) {
  const s = createDraft({ draftId: `playable-${seed}`, seed });
  let guard = 0;
  while (s.phase !== 'done' && guard++ < 2000) {
    if (s.phase === 'bidding') {
      const bidder = s.auction.toAct;
      if (!bidder) break;
      const min = minimumBid(s);
      if (min <= CAP && s.coins[bidder] >= min) applyBid(s, bidder, min);
      else applyBid(s, bidder, 0);
    } else if (s.phase === 'picking') {
      const picker = s.pickingBy;
      if (!picker || !s.pile) break;
      applyKeep(s, picker, pileCards(s.pile).slice(0, picksRequired(s)));
    } else break;
  }
  expect(s.phase).toBe('done');
  return s;
}

/** Everything won, the lands that come with it, then the maindeck up to sixty. */
function buildDeck(won: string[]): DeckEntry[] {
  const { base, drafted, lands } = draftedCardPool(won);
  const deck: DeckEntry[] = [...drafted, ...lands];
  let n = deck.reduce((a, e) => a + e.count, 0);
  for (const e of base) {
    if (n >= 60) break;
    const take = Math.min(e.count, 60 - n);
    deck.push({ ...e, count: take });
    n += take;
  }
  return deck;
}

describe('a draft can be played', () => {
  /*
   * Twelve rather than three. Every bug this test has ever caught was found by a
   * seed the previous run did not have — the mode loop on seed 5, the Chrome Mox
   * one on seed 6, the graveyard self-target on seed 51 — so the number of seeds
   * is the sensitivity of the test.
   */
  const seeds = [1, 2, 3, 4, 5, 6, 10, 34, 51, 77, 103, 149];

  it.each(seeds)('seed %i: drafts, builds and plays out to a winner', (seed) => {
    const s = runDraft(seed);

    const won: Record<PlayerId, string[]> = {
      p1: s.won.p1.map((i) => s.cards[i].oracleId),
      p2: s.won.p2.map((i) => s.cards[i].oracleId),
    };

    // Both seats have to come out of it with cards, or the auction is broken
    // rather than the cards being unplayable.
    expect(won.p1.length).toBeGreaterThan(0);
    expect(won.p2.length).toBeGreaterThan(0);

    // Nothing drafted may be unplayable: a card you won and cannot cast is worse
    // than a card that was never in the cube.
    const unplayable = [...won.p1, ...won.p2]
      .map((id) => ({ id, why: unimplementedReason(id) }))
      .filter((x) => x.why);
    expect(unplayable).toEqual([]);

    const decks = { p1: buildDeck(won.p1), p2: buildDeck(won.p2) };

    // The server's own gate, so this is a deck it would actually deal.
    expect(deckProblem(decks.p1, won.p1)).toBeNull();
    expect(deckProblem(decks.p2, won.p2)).toBeNull();

    const game = Game.create({
      gameId: `draft-playable-${seed}`,
      seed: seed * 7919,
      decks,
      startingPlayer: 'p1',
    });
    const { unfinished } = runToEnd(game, { p1: new HeuristicAgent(), p2: new HeuristicAgent() });

    // The claim: a game of drafted decks reaches an ending on its own. An
    // unfinished game is a loop or a stuck prompt, and either one means a draft
    // cannot be played however complete the card list is.
    expect(unfinished).toBe(false);
    expect(game.state.winner).not.toBeNull();
  });
});
