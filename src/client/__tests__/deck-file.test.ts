import { describe, expect, it } from 'vitest';
import { MAINDECK } from '@engine/deck';
import { deckSize, formatDecklist } from '@engine/decklist';
import { oracleByName } from '@engine/oracle';
import type { OracleId } from '@engine/types';
import { LocalConnection } from '../connection';
import { deckReadiness, describeProblems, readDeckFile } from '../deck-file';
import { fitNote, fitToPool } from '../DeckBuilder';

/**
 * A decklist leaving the app, and one arriving.
 *
 * The end of this journey is the only part that really matters: a file somebody
 * picked has to become the deck a game is dealt from. Everything before it is
 * in service of that.
 */

const id = (name: string): OracleId => oracleByName(name).oracleId;

function file(name: string, text: string): File {
  return new File([text], name, { type: 'text/plain' });
}

const hasScript = () => true;
const nameOf = (x: string) => x;

describe('reading a picked file', () => {
  it('reads a list somebody exported from here', async () => {
    const loaded = await readDeckFile(file('mine.txt', formatDecklist(MAINDECK, { name: 'Mine' })));
    expect(loaded.problems).toEqual([]);
    expect(deckSize(loaded.entries)).toBe(60);
    expect(loaded.name).toBe('Mine');
  });

  it('falls back to the filename when the list has no name in it', async () => {
    const loaded = await readDeckFile(file('yaakov-game-two.txt', '60 Island\n'));
    expect(loaded.name).toBe('yaakov-game-two');
  });

  it('refuses something that is not text at all', async () => {
    // A PNG header. Read as text this is control characters, not a decklist.
    const png = String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    await expect(readDeckFile(file('art.png', png))).rejects.toThrow(/does not look like/);
  });

  it('refuses a file far too big to be a decklist', async () => {
    const huge = 'x'.repeat(300 * 1024);
    await expect(readDeckFile(file('huge.txt', huge))).rejects.toThrow(/too big/);
  });

  it('says which line it could not read, rather than refusing the file', async () => {
    const loaded = await readDeckFile(file('typo.txt', '4 Brainstorm\n4 Brainstrom\n'));
    expect(deckSize(loaded.entries)).toBe(4);
    expect(describeProblems(loaded)).toMatch(/Line 2/);
  });

  it('mentions a sideboard it had to leave out', async () => {
    const loaded = await readDeckFile(file('sb.txt', '4 Brainstorm\nSideboard\n2 Veil of Summer\n'));
    expect(describeProblems(loaded)).toMatch(/sideboard/i);
  });
});

describe('judging whether a list can be played', () => {
  it('counts how far short of a legal deck it is', () => {
    expect(deckReadiness(MAINDECK, hasScript, nameOf).short).toBe(0);
    expect(deckReadiness([{ oracleId: id('Island'), count: 40 }], hasScript, nameOf).short).toBe(20);
  });

  it('names the cards the engine cannot cast, without refusing the list', () => {
    const r = deckReadiness(
      [{ oracleId: id('Island'), count: 60 }],
      () => false,
      () => 'Island',
    );
    expect(r.short).toBe(0);
    expect(r.unplayable).toEqual(['Island']);
  });
});

describe('fitting an imported list to a pool', () => {
  const owned = new Map<OracleId, number>([
    [id('Brainstorm'), 4],
    [id('Island'), 1],
  ]);

  it('takes what the player has and reports what it could not take', () => {
    const fit = fitToPool(
      [
        { oracleId: id('Brainstorm'), count: 4 },
        { oracleId: id('Island'), count: 4 },
        { oracleId: id('Omniscience'), count: 4 },
      ],
      owned,
    );
    expect(fit.deck.get(id('Brainstorm'))).toBe(4);
    // Only one Island is owned, so only one goes in.
    expect(fit.deck.get(id('Island'))).toBe(1);
    expect(fit.deck.has(id('Omniscience'))).toBe(false);
    expect(fit.missing).toEqual(['Omniscience']);
    expect(fit.trimmed).toBe(3);
    expect(fitNote(fit)).toMatch(/Omniscience/);
    expect(fitNote(fit)).toMatch(/3 copies/);
  });

  it('says nothing when the whole list fitted', () => {
    const fit = fitToPool([{ oracleId: id('Brainstorm'), count: 4 }], owned);
    expect(fitNote(fit)).toBeNull();
  });
});

describe('playing a loaded decklist', () => {
  /** The cards actually dealt to a seat, by name. */
  function libraryNames(conn: LocalConnection, seat: 'p1' | 'p2'): string[] {
    const s = conn.game.state;
    return [...s.zones[seat].library, ...s.zones[seat].hand].map((iid) => s.cards[iid].oracleId);
  }

  const onlyIslands = [{ oracleId: id('Island'), count: 60 }];

  it('deals the loaded deck instead of the mirror', () => {
    const conn = new LocalConnection({
      seed: 5,
      startingPlayer: 'p1',
      seats: ['p1', 'p2'],
      deck: onlyIslands,
    });
    const p1 = libraryNames(conn, 'p1');
    expect(p1).toHaveLength(60);
    expect(new Set(p1)).toEqual(new Set([id('Island')]));
  });

  it('deals it to both seats, because the format is a mirror', () => {
    const conn = new LocalConnection({
      seed: 5,
      startingPlayer: 'p1',
      seats: ['p1', 'p2'],
      deck: onlyIslands,
    });
    expect(new Set(libraryNames(conn, 'p2'))).toEqual(new Set([id('Island')]));
  });

  it('keeps playing it in game two of the series', () => {
    const conn = new LocalConnection({
      seed: 5,
      startingPlayer: 'p1',
      seats: ['p1', 'p2'],
      bestOf: 3,
      deck: onlyIslands,
    });
    conn.submitIntent('p2', { t: 'concede' });
    const m = conn.match()!;
    expect(m.awaitingFirstChoiceFrom).toBe('p2');
    conn.chooseFirst('p2', 'p2');

    expect(conn.match()!.gameNumber).toBe(2);
    // A fresh shuffle of the same list, not a fall back to the stock sixty.
    expect(new Set(libraryNames(conn, 'p1'))).toEqual(new Set([id('Island')]));
    expect(libraryNames(conn, 'p1')).toHaveLength(60);
  });

  it('still deals the mirror when no list was loaded', () => {
    const conn = new LocalConnection({ seed: 5, startingPlayer: 'p1', seats: ['p1', 'p2'] });
    expect(libraryNames(conn, 'p1')).toHaveLength(deckSize(MAINDECK));
    expect(new Set(libraryNames(conn, 'p1')).size).toBeGreaterThan(1);
  });
});
