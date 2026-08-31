import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpConnection } from '../connection';
import { useStore } from '../store';
import type { Connection } from '../connection';

/**
 * What the online client does when a request does not arrive.
 *
 * The bug these are written against is the one a player reports as the site
 * dying on them for no reason: `fetch` rejects whenever a request never reaches
 * the server — a dropped wifi, a phone changing network, a laptop waking up, an
 * edge that resets the connection — and every call here is fire-and-forget, so
 * the rejection went nowhere. A move vanished with no message and no offline
 * banner, and a *join* that missed took the whole session with it: the poll loop
 * will not run without the seat that call brings back, so the tab sat on
 * "Connecting…" for ever and never recovered, even once the network did.
 *
 * Nothing here is about being online. It is about a connection failing the way
 * connections actually fail, which is at random and usually briefly.
 */

interface Fetching {
  calls: number;
  fail: boolean;
}

const SNAPSHOT = {
  seat: 'p1',
  phase: 'game',
  version: 0,
  rev: 1,
  view: null,
  match: null,
  events: [],
  players: [{ seat: 'p1', name: 'me' }],
  ready: false,
  token: 'seat-token',
};

function stubNetwork(): Fetching {
  const state: Fetching = { calls: 0, fail: true };
  vi.stubGlobal('fetch', async () => {
    state.calls++;
    if (state.fail) throw new TypeError('Failed to fetch');
    return {
      ok: true,
      status: 200,
      json: async () => ({ ...SNAPSHOT }),
    } as unknown as Response;
  });
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  // The client schedules its polling and its retries on the window, which a
  // node test does not have. Delegating keeps the fake timers in charge.
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('an online connection that cannot reach the server', () => {
  it('does not throw out of a move, and says the move was not sent', async () => {
    const net = stubNetwork();
    net.fail = false;
    const conn = new HttpConnection({ room: 'ROOM', playerName: 'me' });
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.seats()).toEqual(['p1']);

    net.fail = true;
    // The crash this replaces was an unhandled rejection out of exactly this
    // call, with nothing on screen to show for it.
    expect(() => conn.submitIntent('p1', { t: 'passPriority' })).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(conn.info().status).toBe('closed');
    expect(conn.lastError()).toMatch(/not sent/i);

    conn.dispose();
  });

  it('keeps trying to take a seat, and gets in when the network comes back', async () => {
    const net = stubNetwork();
    const conn = new HttpConnection({ room: 'ROOM', playerName: 'me' });

    await vi.advanceTimersByTimeAsync(0);
    // The join failed. Before the retry existed this was the end of the
    // session: no seat, no poll, no error, and no way back but a reload.
    expect(conn.seats()).toEqual([]);
    expect(conn.info().status).toBe('closed');
    expect(conn.lastError()).toMatch(/still trying/i);

    net.fail = false;
    await vi.advanceTimersByTimeAsync(2000);

    expect(conn.seats()).toEqual(['p1']);
    expect(conn.info().status).toBe('open');

    conn.dispose();
  });

  it('stops retrying once the connection is thrown away', async () => {
    const net = stubNetwork();
    const conn = new HttpConnection({ room: 'ROOM', playerName: 'me' });
    await vi.advanceTimersByTimeAsync(0);
    const attempted = net.calls;

    conn.dispose();
    await vi.advanceTimersByTimeAsync(30000);

    expect(net.calls).toBe(attempted);
  });
});

describe('a move that was never sent can be made again', () => {
  it('re-arms the one-action-per-state guard when the connection has dropped', () => {
    /*
     * The guard stops a second click going out while the first is still in the
     * air. An action that never reached the server is not in the air — but the
     * guard only cleared when a new view arrived, and a poll of an unchanged
     * game brings none. So a move lost to a blip locked the seat out of retrying
     * until the opponent happened to move, while the banner cheerfully said
     * nothing had been lost.
     */
    const view = { viewer: 'p1' } as never;
    const conn = {
      kind: 'remote',
      subscribe: () => () => {},
      seats: () => ['p1'],
      view: (seat: string) => (seat === 'p1' ? view : null),
      drainEvents: () => [],
      info: () => ({ kind: 'remote', status: 'closed', players: [], ready: true }),
      phase: () => 'game',
      draftView: () => null,
      cardPool: () => null,
      lastDeck: () => null,
      deckReady: () => [],
      lastError: () => null,
      match: () => null,
      dispose: () => {},
    } as unknown as Connection;

    useStore.getState().attach(conn, 'p1');
    useStore.setState({ actedFrom: { p1: view, p2: null }, actedFromDraft: {} as never });
    useStore.getState().refresh();

    expect(useStore.getState().actedFrom.p1).toBeNull();
    expect(useStore.getState().actedFromDraft).toBeNull();

    useStore.getState().detach();
  });
});
