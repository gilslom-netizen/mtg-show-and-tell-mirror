import { beforeEach, describe, expect, it } from 'vitest';
import { applyAction, join, snapshot } from '../room.js';
import { getStore, setStore } from '../store.js';
import {
  COINS_PER_PLAYER,
  MAX_COINS,
  MIN_COINS,
  draftCoins,
} from '../../engine/draft-pool.js';
import type { PlayerId } from '../../engine/types.js';

/**
 * The purse is part of the starting position.
 *
 * Which means it has to survive the thing every other part of a room survives:
 * being thrown away and rebuilt from (seed, action log) on the next request. A
 * purse that lived only in the request that opened the room would be 24 again by
 * the time the first bid was replayed, and the draft would start rejecting bids
 * it had already accepted.
 */

const CODE = 'COINSX';

async function openRoom(coins?: number): Promise<Record<PlayerId, string>> {
  const store = getStore();
  const a = await join(store, CODE, { name: 'alice', format: 'draft', bestOf: 3, coins });
  const b = await join(store, CODE, { name: 'bob' });
  if ('error' in a || 'error' in b) throw new Error('could not seat both players');
  return { p1: a.seat === 'p1' ? a.token : b.token, p2: a.seat === 'p2' ? a.token : b.token };
}

describe('draftCoins', () => {
  it('takes any whole purse in range', () => {
    expect(draftCoins(1)).toBe(1);
    expect(draftCoins(12)).toBe(12);
    expect(draftCoins(40)).toBe(40);
    expect(draftCoins(MAX_COINS)).toBe(MAX_COINS);
  });

  it('falls back to the format’s own number for anything else', () => {
    // Nothing asked for, and everything a hand-rolled request might send.
    expect(draftCoins(undefined)).toBe(COINS_PER_PLAYER);
    expect(draftCoins(0)).toBe(COINS_PER_PLAYER);
    expect(draftCoins(-5)).toBe(COINS_PER_PLAYER);
    expect(draftCoins(2.5)).toBe(COINS_PER_PLAYER);
    expect(draftCoins(MAX_COINS + 1)).toBe(COINS_PER_PLAYER);
    expect(draftCoins(Number.NaN)).toBe(COINS_PER_PLAYER);
    expect(draftCoins('24' as unknown as number)).toBe(COINS_PER_PLAYER);
  });

  it('refuses a purse nobody could bid out of', () => {
    // Zero is the one that reads like a legal choice: both players would be
    // unable to open, so fourteen piles would be dealt and none of them bought.
    expect(MIN_COINS).toBeGreaterThan(0);
    expect(draftCoins(0)).toBe(COINS_PER_PLAYER);
  });
});

describe('a room opened with a custom purse', () => {
  beforeEach(() => setStore(null));

  it('deals both players that many coins', async () => {
    await openRoom(40);
    const snap = await snapshot(getStore(), CODE, 'p1');
    expect(snap?.draft?.coins).toEqual({ p1: 40, p2: 40 });
  });

  it('still defaults when the room says nothing', async () => {
    await openRoom();
    const snap = await snapshot(getStore(), CODE, 'p1');
    expect(snap?.draft?.coins).toEqual({ p1: COINS_PER_PLAYER, p2: COINS_PER_PLAYER });
  });

  it('ignores a purse the auction has no rule for', async () => {
    await openRoom(0);
    const snap = await snapshot(getStore(), CODE, 'p1');
    expect(snap?.draft?.coins).toEqual({ p1: COINS_PER_PLAYER, p2: COINS_PER_PLAYER });
  });

  it('keeps the purse across the replay a bid goes through', async () => {
    const tokens = await openRoom(12);
    const before = await snapshot(getStore(), CODE, 'p1');
    const opener = before!.draft!.toAct as PlayerId;

    const out = await applyAction(getStore(), CODE, opener, {
      t: 'draft',
      action: { t: 'bid', amount: 5 },
    });
    expect(out.ok).toBe(true);

    // Rebuilt from the log by this very call, which is the point.
    const after = await snapshot(getStore(), CODE, opener);
    expect(after!.draft!.coins[opener]).toBe(12);
    expect(tokens[opener]).toBeTruthy();
  });

  it('will not let a player bid more than the purse it was opened with', async () => {
    await openRoom(12);
    const snap = await snapshot(getStore(), CODE, 'p1');
    const opener = snap!.draft!.toAct as PlayerId;

    const out = await applyAction(getStore(), CODE, opener, {
      t: 'draft',
      action: { t: 'bid', amount: 13 },
    });
    expect(out.ok).toBe(false);
    // The default purse would have allowed it, which is how a lost purse shows up.
    expect(out.ok ? '' : out.error).toContain('12');
  });
});
