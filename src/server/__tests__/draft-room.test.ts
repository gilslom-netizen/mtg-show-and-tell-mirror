import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyAction,
  deckProblem,
  freshMeta,
  join,
  phaseOf,
  snapshot,
} from '../room.js';
import { getStore, setStore } from '../store.js';
import { MAINDECK } from '../../engine/deck.js';
import { GRANTED_LAND_COUNT } from '../../engine/draft-pool.js';
import { draftedCardPool, mergeEntries } from '../../draft/session.js';
import type { PlayerId } from '../../engine/types.js';

/**
 * A drafted room end to end: draft, then build, then play — over the same
 * replay-the-log machinery the classic room uses, because a serverless request
 * has nothing else to rebuild from.
 */

const CODE = 'DRAFTX';

async function openRoom(): Promise<Record<PlayerId, string>> {
  const store = getStore();
  const a = await join(store, CODE, { name: 'alice', format: 'draft', bestOf: 3 });
  const b = await join(store, CODE, { name: 'bob' });
  if ('error' in a || 'error' in b) throw new Error('could not seat both players');
  return { p1: a.seat === 'p1' ? a.token : b.token, p2: a.seat === 'p2' ? a.token : b.token };
}

async function draftView(seat: PlayerId) {
  const snap = await snapshot(getStore(), CODE, seat);
  if (!snap?.draft) throw new Error('expected a draft view');
  return snap.draft;
}

describe('a drafted room', () => {
  beforeEach(() => setStore(null));

  it('opens in the draft phase with a full purse each', async () => {
    await openRoom();
    const snap = await snapshot(getStore(), CODE, 'p1');
    expect(snap?.phase).toBe('draft');
    expect(snap?.draft?.coins).toEqual({ p1: 24, p2: 24 });
    expect(snap?.draft?.pile?.publicCards).toHaveLength(2);
  });

  it('never puts the opponent’s private card in a snapshot', async () => {
    await openRoom();
    const p1 = await draftView('p1');
    const p2 = await draftView('p2');
    // Each sees their own hidden card, and it is not the same card.
    expect(p1.pile!.myPrivateCard).not.toBe(p2.pile!.myPrivateCard);
    expect(p1.cards[p2.pile!.myPrivateCard]).toBeUndefined();
    expect(p2.cards[p1.pile!.myPrivateCard]).toBeUndefined();
  });

  it('runs a bid, a withdrawal and a pick through the log', async () => {
    const tokens = await openRoom();
    const start = await draftView('p1');
    const opener = start.toAct!;
    const other: PlayerId = opener === 'p1' ? 'p2' : 'p1';

    const bid = await applyAction(getStore(), CODE, opener, {
      t: 'draft',
      action: { t: 'bid', amount: 3 },
    });
    expect(bid.ok).toBe(true);
    await applyAction(getStore(), CODE, other, { t: 'draft', action: { t: 'bid', amount: 0 } });

    const view = await draftView(opener);
    expect(view.phase).toBe('picking');
    expect(view.pickingBy).toBe(opener);
    expect(view.coins[opener]).toBe(21);
    // The buyer can now see all four cards, including the one that was hidden.
    expect(Object.keys(view.cards).length).toBeGreaterThanOrEqual(4);

    const four = [...view.pile!.publicCards, view.pile!.myPrivateCard];
    const all = Object.keys(view.cards).map(Number);
    const fourth = all.find((i) => !four.includes(i))!;
    const keep = await applyAction(getStore(), CODE, opener, {
      t: 'draft',
      action: { t: 'keep', iids: [four[0], fourth] },
    });
    expect(keep.ok).toBe(true);

    const after = await draftView(opener);
    expect(after.myPicks).toHaveLength(2);
    expect(after.pile!.number).toBe(2);
    expect(tokens.p1).toBeTruthy();
  });

  it('refuses a bid from the seat that is not to act', async () => {
    await openRoom();
    const view = await draftView('p1');
    const notThem: PlayerId = view.toAct === 'p1' ? 'p2' : 'p1';
    const res = await applyAction(getStore(), CODE, notThem, {
      t: 'draft',
      action: { t: 'bid', amount: 1 },
    });
    expect(res.ok).toBe(false);
  });

  it('moves to deckbuilding when the last pile is settled', async () => {
    await openRoom();
    // Both players pass on everything, which is the fastest legal draft.
    for (let i = 0; i < 100; i++) {
      const snap = await snapshot(getStore(), CODE, 'p1');
      if (snap?.phase !== 'draft') break;
      const d = snap.draft!;
      if (d.phase === 'bidding') {
        await applyAction(getStore(), CODE, d.toAct!, {
          t: 'draft',
          action: { t: 'bid', amount: 0 },
        });
      } else break;
    }
    const snap = await snapshot(getStore(), CODE, 'p1');
    expect(snap?.phase).toBe('build');
    expect(phaseOf((await getStore().getMeta(CODE))!)).toBe('build');
    // Nobody bought anything, so the pool is the main deck plus the granted lands.
    expect(snap?.pool?.drafted).toEqual([]);
    const landCount = snap!.pool!.lands.reduce((n, e) => n + e.count, 0);
    expect(landCount).toBe(GRANTED_LAND_COUNT);
  });
});

describe('submitting a deck', () => {
  beforeEach(() => setStore(null));

  it('rejects a list with cards the player does not own', () => {
    expect(deckProblem([{ oracleId: 'timetwister', count: 4 }], [])).toMatch(/not in your card pool|only have/);
    // Even a single copy, if it was never drafted.
    expect(deckProblem(mergeEntries(MAINDECK, [{ oracleId: 'timetwister', count: 1 }]), []))
      .toMatch(/not in your card pool|only have/);
  });

  it('rejects a deck that is too small', () => {
    // One of each card the mirror plays: every card is owned, but it is 25 cards.
    const oneOfEach = MAINDECK.map((e) => ({ ...e, count: 1 }));
    expect(deckProblem(oneOfEach, [])).toMatch(/at least 60/);
  });

  it('accepts the main deck as it stands, and a legal drafted swap', () => {
    expect(deckProblem(MAINDECK, [])).toBeNull();
    const { all } = draftedCardPool(['timetwister']);
    expect(all.some((e) => e.oracleId === 'timetwister')).toBe(true);
    // Swap one Island out for the drafted card.
    const swapped = MAINDECK.map((e) =>
      e.oracleId === 'island' ? { ...e, count: e.count - 1 } : e,
    ).concat([{ oracleId: 'timetwister', count: 1 }]);
    expect(deckProblem(swapped, ['timetwister'])).toBeNull();
  });

  it('starts the game only once both players have locked a list in', async () => {
    const store = getStore();
    const meta = freshMeta('BUILD1', { format: 'draft' });
    meta.phase = 'build';
    meta.seats = { p1: { token: 'a', name: 'a' }, p2: { token: 'b', name: 'b' } };
    await store.setMeta('BUILD1', meta);

    const first = await applyAction(store, 'BUILD1', 'p1', { t: 'submitDeck', deck: MAINDECK });
    expect(first.ok).toBe(true);
    expect(phaseOf((await store.getMeta('BUILD1'))!)).toBe('build');

    const second = await applyAction(store, 'BUILD1', 'p2', { t: 'submitDeck', deck: MAINDECK });
    expect(second.ok).toBe(true);
    expect(phaseOf((await store.getMeta('BUILD1'))!)).toBe('game');
  });
});
