import { describe, expect, it } from 'vitest';
import {
  applyBid,
  applyKeep,
  averagePileValue,
  canBid,
  createDraft,
  pileCards,
  pilesRemaining,
} from '../draft.js';
import { redactDraft } from '../redact.js';
import { COINS_PER_PLAYER, draftPoolOracleIds } from '../../engine/draft-pool.js';
import type { DraftState } from '../types.js';
import type { PlayerId } from '../../engine/types.js';

/**
 * The auction is the whole format, so it is pinned down here rule by rule:
 * who may bid what, what a withdrawal means depending on when it happens, and
 * who pays.
 */

function draft(seed = 1, pool?: string[], coins?: number): DraftState {
  return createDraft({ draftId: 'test', seed, poolOracleIds: pool, coins });
}

/** A short pool, so a test can run a draft to the end quickly. */
function shortPool(piles: number): string[] {
  return draftPoolOracleIds().slice(0, piles * 4);
}

function opener(s: DraftState): PlayerId {
  return s.auction.toAct!;
}

function opponentOf(p: PlayerId): PlayerId {
  return p === 'p1' ? 'p2' : 'p1';
}

describe('setting up a draft', () => {
  it('deals four cards a pile: two public and one private to each player', () => {
    const s = draft();
    expect(s.pile).not.toBeNull();
    expect(s.pile!.publicCards).toHaveLength(2);
    expect(pileCards(s.pile!)).toHaveLength(4);
    // Every card in the pile is a different card.
    expect(new Set(pileCards(s.pile!)).size).toBe(4);
  });

  it('gives both players the same purse', () => {
    const s = draft();
    expect(s.coins).toEqual({ p1: COINS_PER_PLAYER, p2: COINS_PER_PLAYER });
  });

  it('sets aside cards that cannot make a whole pile', () => {
    // 63 cards is 15 piles and three cards over — those cannot be dealt two
    // public and one to each player, so they sit the draft out.
    const s = draft();
    expect(s.pilesTotal).toBe(15);
    expect(s.setAside).toHaveLength(draftPoolOracleIds().length - 15 * 4);
  });

  it('is deterministic in the seed, and different across seeds', () => {
    const a = draft(7);
    const b = draft(7);
    const c = draft(8);
    expect(pileCards(a.pile!)).toEqual(pileCards(b.pile!));
    expect(a.opener).toBe(b.opener);
    // Not a guarantee for every pair of seeds, but these two do differ.
    expect(pileCards(a.pile!)).not.toEqual(pileCards(c.pile!));
  });
});

describe('bidding', () => {
  it('makes the opener bid at least one, or withdraw', () => {
    const s = draft();
    const me = opener(s);
    expect(canBid(s, me, 1)).toBeNull();
    expect(canBid(s, me, 0)).toBeNull(); // withdrawing is always allowed
    expect(canBid(s, me, -1)).toMatch(/whole number/);
  });

  it('refuses a bid from the player whose turn it is not', () => {
    const s = draft();
    expect(canBid(s, opponentOf(opener(s)), 1)).toMatch(/not your turn/i);
  });

  it('refuses a bid bigger than your purse', () => {
    const s = draft(1, undefined, 5);
    const me = opener(s);
    expect(canBid(s, me, 6)).toMatch(/only have 5/);
    expect(canBid(s, me, 5)).toBeNull();
  });

  it('makes each bid beat the one before it', () => {
    const s = draft();
    const a = opener(s);
    const b = opponentOf(a);
    applyBid(s, a, 3);
    expect(canBid(s, b, 3)).toMatch(/must beat 3/);
    expect(canBid(s, b, 4)).toBeNull();
  });

  it('hands the pile to the other player when one withdraws against a standing bid', () => {
    const s = draft();
    const a = opener(s);
    const b = opponentOf(a);
    applyBid(s, a, 4);
    applyBid(s, b, 0);
    expect(s.phase).toBe('picking');
    expect(s.pickingBy).toBe(a);
    expect(s.coins[a]).toBe(COINS_PER_PLAYER - 4);
    expect(s.coins[b]).toBe(COINS_PER_PLAYER);
  });

  it('lets the second player claim a pile the opener passed on', () => {
    const s = draft();
    const a = opener(s);
    const b = opponentOf(a);
    applyBid(s, a, 0);
    // The opener is out, but the pile is not gone: b may still buy it, and a
    // one coin bid is enough because there is nothing to beat.
    expect(s.phase).toBe('bidding');
    expect(s.auction.toAct).toBe(b);
    expect(canBid(s, b, 1)).toBeNull();
    applyBid(s, b, 1);
    expect(s.phase).toBe('picking');
    expect(s.pickingBy).toBe(b);
    expect(s.coins[b]).toBe(COINS_PER_PLAYER - 1);
  });

  it('throws the pile away when both players withdraw', () => {
    const s = draft();
    const a = opener(s);
    const b = opponentOf(a);
    const wasOnTable = pileCards(s.pile!);
    applyBid(s, a, 0);
    applyBid(s, b, 0);
    expect(s.unclaimed).toEqual(wasOnTable);
    expect(s.coins).toEqual({ p1: COINS_PER_PLAYER, p2: COINS_PER_PLAYER });
    // And the next pile is already on the table.
    expect(s.pile!.number).toBe(2);
  });

  it('runs a bidding war and charges only the winner, only the final bid', () => {
    const s = draft();
    const a = opener(s);
    const b = opponentOf(a);
    applyBid(s, a, 1);
    applyBid(s, b, 2);
    applyBid(s, a, 5);
    applyBid(s, b, 6);
    applyBid(s, a, 0);
    expect(s.pickingBy).toBe(b);
    expect(s.coins[b]).toBe(COINS_PER_PLAYER - 6);
    expect(s.coins[a]).toBe(COINS_PER_PLAYER);
  });

  it('alternates who opens the bidding on each pile', () => {
    const s = draft();
    const first = s.opener;
    applyBid(s, first, 0);
    applyBid(s, opponentOf(first), 0);
    expect(s.opener).toBe(opponentOf(first));
    expect(s.auction.toAct).toBe(opponentOf(first));
  });
});

describe('keeping cards', () => {
  function winAPile(s: DraftState): PlayerId {
    const a = opener(s);
    applyBid(s, a, 2);
    applyBid(s, opponentOf(a), 0);
    return a;
  }

  it('keeps exactly two and throws the rest away', () => {
    const s = draft();
    const winner = winAPile(s);
    const all = pileCards(s.pile!);
    applyKeep(s, winner, [all[0], all[3]]);
    expect(s.won[winner]).toEqual([all[0], all[3]]);
    expect(s.discarded[winner]).toEqual([all[1], all[2]]);
  });

  it('refuses the wrong number of cards, a repeat, or a card from another pile', () => {
    const s = draft();
    const winner = winAPile(s);
    const all = pileCards(s.pile!);
    expect(() => applyKeep(s, winner, [all[0]])).toThrow(/exactly 2/);
    expect(() => applyKeep(s, winner, [all[0], all[0]])).toThrow(/same card twice/i);
    expect(() => applyKeep(s, winner, [all[0], 9999])).toThrow(/not in this pile/);
  });

  it('refuses a pick from the player who did not win the pile', () => {
    const s = draft();
    const winner = winAPile(s);
    const all = pileCards(s.pile!);
    expect(() => applyKeep(s, opponentOf(winner), [all[0], all[1]])).toThrow(/not yours/);
  });

  it('moves on to the next pile once the picks are in', () => {
    const s = draft();
    const winner = winAPile(s);
    const all = pileCards(s.pile!);
    applyKeep(s, winner, [all[0], all[1]]);
    expect(s.phase).toBe('bidding');
    expect(s.pile!.number).toBe(2);
  });
});

describe('running out of piles', () => {
  it('ends after the last pile', () => {
    const s = draft(3, shortPool(2));
    expect(s.pilesTotal).toBe(2);
    for (let i = 0; i < 2; i++) {
      const a = opener(s);
      applyBid(s, a, 1);
      applyBid(s, opponentOf(a), 0);
      const all = pileCards(s.pile!);
      applyKeep(s, a, [all[0], all[1]]);
    }
    expect(s.phase).toBe('done');
    expect(s.pile).toBeNull();
    expect(pilesRemaining(s)).toBe(0);
  });

  it('conserves every card: kept, thrown away, unclaimed or set aside', () => {
    const s = draft(11, shortPool(4));
    let guard = 0;
    while (s.phase !== 'done' && guard++ < 50) {
      if (s.phase === 'bidding') {
        const p = s.auction.toAct!;
        // Alternate buying and passing so both outcomes are exercised.
        applyBid(s, p, s.pileNumber % 2 === 0 && s.auction.highest === 0 ? 1 : 0);
      } else if (s.phase === 'picking') {
        const p = s.pickingBy!;
        applyKeep(s, p, pileCards(s.pile!).slice(0, 2));
      }
    }
    const accounted =
      s.won.p1.length +
      s.won.p2.length +
      s.discarded.p1.length +
      s.discarded.p2.length +
      s.unclaimed.length +
      s.setAside.length;
    expect(accounted).toBe(Object.keys(s.cards).length);
  });
});

describe('what each player is told', () => {
  it('never sends the opponent’s private card', () => {
    const s = draft();
    const view = redactDraft(s, 'p1');
    const secret = s.pile!.privateTo.p2;
    expect(view.cards[secret]).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain(`"${secret}"`);
    // But the viewer is told a card is there, so the table can show its back.
    expect(view.pile!.opponentHasPrivateCard).toBe(true);
    expect(view.pile!.myPrivateCard).toBe(s.pile!.privateTo.p1);
  });

  it('shows the buyer all four cards while they pick', () => {
    const s = draft();
    const a = opener(s);
    applyBid(s, a, 1);
    applyBid(s, opponentOf(a), 0);
    const buyer = redactDraft(s, a);
    for (const iid of pileCards(s.pile!)) expect(buyer.cards[iid]).toBeDefined();
    // The other player still cannot see the card they were never shown.
    const loser = redactDraft(s, opponentOf(a));
    expect(loser.cards[s.pile!.privateTo[a]]).toBeUndefined();
  });

  it('keeps what each player took and threw away to themselves', () => {
    const s = draft();
    const a = opener(s);
    applyBid(s, a, 1);
    applyBid(s, opponentOf(a), 0);
    const all = pileCards(s.pile!);
    applyKeep(s, a, [all[0], all[1]]);

    const mine = redactDraft(s, a);
    expect(mine.myPicks).toHaveLength(2);
    expect(mine.myDiscards).toHaveLength(2);

    const theirs = redactDraft(s, opponentOf(a));
    expect(theirs.myPicks).toHaveLength(0);
    expect(theirs.opponentPickCount).toBe(2);
    // The two cards the buyer chose to keep are not named to the other player.
    expect(theirs.log.some((e) => /^keeps /.test(e.text))).toBe(false);
  });

  it('shows both purses, because the auction is played against them', () => {
    const s = draft();
    const a = opener(s);
    applyBid(s, a, 4);
    applyBid(s, opponentOf(a), 0);
    const view = redactDraft(s, opponentOf(a));
    expect(view.coins[a]).toBe(COINS_PER_PLAYER - 4);
    expect(view.myCoins).toBe(COINS_PER_PLAYER);
  });
});

describe('the numbers on screen', () => {
  it('counts the pile on the table as still to be won', () => {
    const s = draft(1, shortPool(3));
    expect(s.pilesTotal).toBe(3);
    expect(pilesRemaining(s)).toBe(3);
  });

  it('divides both purses by the piles left', () => {
    const s = draft(1, shortPool(4), 10);
    expect(averagePileValue(s)).toBe(20 / 4);
    const a = opener(s);
    applyBid(s, a, 4);
    applyBid(s, opponentOf(a), 0);
    applyKeep(s, a, pileCards(s.pile!).slice(0, 2));
    // 16 coins left between them, three piles to go.
    expect(averagePileValue(s)).toBeCloseTo(16 / 3);
  });

  it('has no average left once the piles run out', () => {
    const s = draft(1, shortPool(1));
    const a = opener(s);
    applyBid(s, a, 1);
    applyBid(s, opponentOf(a), 0);
    applyKeep(s, a, pileCards(s.pile!).slice(0, 2));
    expect(averagePileValue(s)).toBeNull();
  });
});
