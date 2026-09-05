import { beforeEach, describe, expect, it } from 'vitest';
import { applyAction, freshMeta, join, phaseOf, snapshot } from '../room.js';
import { getStore, setStore } from '../store.js';
import { MAINDECK } from '../../engine/deck.js';
import type { PlayerId } from '../../engine/types.js';

/**
 * Extending a decided series by two more games, over the serverless path.
 *
 * A request here has no memory: the room is `(seed, log)` and every poll rebuilds
 * the game by replaying it. That makes the end of a game a delicate moment — the
 * finished game is still what the log describes, so anything that changes the
 * seed without clearing the log replays the old result into a new identity, and
 * the series records it a second time.
 */

const CODE = 'EXTEND';

async function openRoom(bestOf = 3): Promise<void> {
  const store = getStore();
  const a = await join(store, CODE, { name: 'alice', bestOf });
  const b = await join(store, CODE, { name: 'bob' });
  if ('error' in a || 'error' in b) throw new Error('could not seat both players');
}

async function match() {
  const snap = await snapshot(getStore(), CODE, 'p1');
  if (!snap) throw new Error('no room');
  return snap.match;
}

/** Lose the current game on purpose, then read the series back. */
async function concede(seat: PlayerId) {
  const r = await applyAction(getStore(), CODE, seat, { t: 'intent', intent: { t: 'concede' } });
  if (!r.ok) throw new Error(r.error);
  // A poll is what records the result; nothing else runs between requests.
  await match();
}

describe('extending a series', () => {
  beforeEach(() => setStore(null));

  it('does not replay the last game into the games it just added', async () => {
    await openRoom(3);

    await concede('p1');
    let m = await match();
    expect(m.wins).toEqual({ p1: 0, p2: 1 });
    // The loser picks who is on the play, which is what starts game two.
    expect(m.awaitingFirstChoiceFrom).toBe('p1');
    await applyAction(getStore(), CODE, 'p1', { t: 'chooseFirst', onPlay: 'p1' });

    await concede('p1');
    m = await match();
    expect(m.matchWinner).toBe('p2');
    expect(m.wins).toEqual({ p1: 0, p2: 2 });

    // Two more games, please.
    expect((await applyAction(getStore(), CODE, 'p1', { t: 'offerExtend' })).ok).toBe(true);
    expect((await applyAction(getStore(), CODE, 'p2', { t: 'answerExtend', accept: true })).ok).toBe(
      true,
    );

    m = await match();
    expect(m.bestOf).toBe(5);
    // The extension has to survive the very next poll. It used to not: the
    // accepted offer reshuffled the room without clearing the log, so the
    // rebuild replayed the concession under a new game id and scored it again.
    expect(m.matchWinner).toBeNull();
    expect(m.wins).toEqual({ p1: 0, p2: 2 });
    expect(m.awaitingFirstChoiceFrom).toBe('p1');

    // And it has to survive being polled repeatedly, which is all a client does.
    for (let i = 0; i < 5; i++) await match();
    m = await match();
    expect(m.matchWinner).toBeNull();
    expect(m.wins).toEqual({ p1: 0, p2: 2 });
  });

  it('deals a real game after the extension rather than the old one again', async () => {
    await openRoom(3);
    await concede('p1');
    await applyAction(getStore(), CODE, 'p1', { t: 'chooseFirst', onPlay: 'p1' });
    await concede('p1');

    await applyAction(getStore(), CODE, 'p1', { t: 'offerExtend' });
    await applyAction(getStore(), CODE, 'p2', { t: 'answerExtend', accept: true });
    await applyAction(getStore(), CODE, 'p1', { t: 'chooseFirst', onPlay: 'p2' });

    const snap = await snapshot(getStore(), CODE, 'p1');
    expect(snap?.match.gameNumber).toBe(3);
    expect(snap?.match.matchWinner).toBeNull();
    // A game in progress, not a finished one.
    expect(snap?.view.winner ?? null).toBeNull();
    expect(snap?.finished).toBeUndefined();
  });

  it('sideboards between the games it added, in a drafted room', async () => {
    const store = getStore();
    const meta = freshMeta('DEXT', { format: 'draft', bestOf: 3 });
    // Past the draft: two locked lists and a game already being played.
    meta.phase = 'game';
    meta.seats = { p1: { token: 'a', name: 'a' }, p2: { token: 'b', name: 'b' } };
    meta.decks = { p1: MAINDECK, p2: MAINDECK };
    meta.ready = ['p1', 'p2'];
    await store.setMeta('DEXT', meta);

    const lose = async (seat: PlayerId) => {
      await applyAction(store, 'DEXT', seat, { t: 'intent', intent: { t: 'concede' } });
      await snapshot(store, 'DEXT', 'p1');
    };
    const rebuild = async () => {
      await applyAction(store, 'DEXT', 'p1', { t: 'chooseFirst', onPlay: 'p1' });
      await applyAction(store, 'DEXT', 'p1', { t: 'submitDeck', deck: MAINDECK });
      await applyAction(store, 'DEXT', 'p2', { t: 'submitDeck', deck: MAINDECK });
    };

    await lose('p1');
    await rebuild();
    await lose('p1');
    expect((await snapshot(store, 'DEXT', 'p1'))!.match.matchWinner).toBe('p2');

    await applyAction(store, 'DEXT', 'p1', { t: 'offerExtend' });
    await applyAction(store, 'DEXT', 'p2', { t: 'answerExtend', accept: true });

    // Still the finished board, with the play/draw choice back on the loser —
    // an extension reopens the series, it does not deal.
    let snap = (await snapshot(store, 'DEXT', 'p1'))!;
    expect(snap.phase).toBe('game');
    expect(snap.match.matchWinner).toBeNull();
    expect(snap.match.awaitingFirstChoiceFrom).toBe('p1');

    // Choosing is what sends a drafted room back to the builder.
    await applyAction(store, 'DEXT', 'p1', { t: 'chooseFirst', onPlay: 'p1' });
    expect(phaseOf((await store.getMeta('DEXT'))!)).toBe('build');
    await applyAction(store, 'DEXT', 'p1', { t: 'submitDeck', deck: MAINDECK });
    await applyAction(store, 'DEXT', 'p2', { t: 'submitDeck', deck: MAINDECK });

    snap = (await snapshot(store, 'DEXT', 'p1'))!;
    expect(snap.phase).toBe('game');
    expect(snap.match.gameNumber).toBe(3);
    expect(snap.match.matchWinner).toBeNull();
    expect(snap.view.winner ?? null).toBeNull();
  });
});
