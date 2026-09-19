import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../store';
import type { Connection, SessionPhase } from '../connection';
import type { DeckEntry } from '@engine/state';
import type { PlayerId } from '@engine/types';

/**
 * Pressing "Lock in deck".
 *
 * Submitting a list is a POST, and until it comes back the server's own ready
 * list still says nobody is ready — so the button stayed live, still reading
 * "Lock in deck", after it had been pressed. On anything slower than a local
 * server that is a click that appears to have done nothing, and an invitation to
 * press it again.
 */

/**
 * A connection that never answers, which is the case under test: everything the
 * button does before the server has said a word.
 */
function silentConnection(phase: SessionPhase = 'build') {
  const submitted: { seat: PlayerId; deck: DeckEntry[] }[] = [];
  const conn = {
    kind: 'remote' as const,
    subscribe: () => () => {},
    info: () => ({ kind: 'remote' as const, status: 'open' as const, players: [], ready: true }),
    phase: () => phase,
    view: () => null,
    seats: () => ['p1'] as PlayerId[],
    drainEvents: () => [],
    match: () => null,
    draftView: () => null,
    cardPool: () => null,
    lastDeck: () => null,
    deckReady: () => [] as PlayerId[],
    submitDeck: (seat: PlayerId, deck: DeckEntry[]) => submitted.push({ seat, deck }),
    submitIntent: () => {},
    submitChoice: () => {},
    submitDraftAction: () => {},
    cancel: () => false,
    answerExtend: () => {},
    lastError: () => null,
    clearError: () => {},
    dispose: () => {},
  };
  return { conn: conn as unknown as Connection, submitted };
}

const st = () => useStore.getState();
const DECK: DeckEntry[] = [{ oracleId: 'island', count: 60 }];

describe('locking a deck in', () => {
  beforeEach(() => useStore.getState().detach());

  it('counts as ready the moment it is sent, not when the server agrees', () => {
    const { conn, submitted } = silentConnection();
    st().attach(conn, 'p1');
    expect(st().deckSubmitted).toEqual([]);

    st().sendDeck(DECK, 'p1');

    expect(st().deckSubmitted).toEqual(['p1']);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].seat).toBe('p1');
  });

  it('does not send twice for the same seat', () => {
    const { conn } = silentConnection();
    st().attach(conn, 'p1');
    st().sendDeck(DECK, 'p1');
    st().sendDeck(DECK, 'p1');
    // The list is a set: the button reads off it and must not double-count.
    expect(st().deckSubmitted).toEqual(['p1']);
  });

  it('only marks the seat that actually submitted', () => {
    const { conn } = silentConnection();
    st().attach(conn, 'p1');
    st().sendDeck(DECK, 'p2');
    expect(st().deckSubmitted).toEqual(['p2']);
  });

  it('forgets it once the session is no longer building', () => {
    // The next game of a series opens the builder again, and that is a fresh
    // decision — a seat still marked from last game would open locked.
    const { conn } = silentConnection('game');
    st().attach(conn, 'p1');
    st().sendDeck(DECK, 'p1');
    expect(st().deckSubmitted).toEqual(['p1']);

    st().refresh();
    expect(st().deckSubmitted).toEqual([]);
  });

  it('keeps it while the session is still building', () => {
    const { conn } = silentConnection('build');
    st().attach(conn, 'p1');
    st().sendDeck(DECK, 'p1');
    st().refresh();
    expect(st().deckSubmitted).toEqual(['p1']);
  });
});
