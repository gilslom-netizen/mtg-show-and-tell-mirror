import { describe, expect, it } from 'vitest';
import {
  MAX_DECK_CARDS,
  decklistFilename,
  deckSize,
  formatDecklist,
  parseDecklist,
} from '../decklist.js';
import { MAINDECK } from '../deck.js';
import { oracleByName } from '../oracle.js';
import type { DeckEntry } from '../state.js';

/**
 * A decklist has to survive leaving this app and coming back.
 *
 * The point of writing it as text rather than as our own JSON is that it can be
 * read by a person, by Moxfield, and by whoever is about to play against you —
 * so the tests are mostly about the shapes of list other tools actually emit.
 */

function idOf(name: string) {
  return oracleByName(name).oracleId;
}

function countOf(entries: { oracleId: string; count: number }[], name: string) {
  return entries.find((e) => e.oracleId === idOf(name))?.count ?? 0;
}

describe('writing a decklist', () => {
  it('round-trips the mirror deck exactly', () => {
    const text = formatDecklist(MAINDECK, { name: 'Show and Tell' });
    const back = parseDecklist(text);
    expect(back.problems).toEqual([]);
    // The list leaves as ids, is written as names, and has to come back as the
    // same ids — that hop is the whole risk in a human-readable format.
    const asMap = (entries: DeckEntry[]) =>
      Object.fromEntries([...entries].sort((a, b) => a.oracleId.localeCompare(b.oracleId)).map((e) => [e.oracleId, e.count]));
    expect(asMap(back.entries)).toEqual(asMap(MAINDECK));
    expect(deckSize(back.entries)).toBe(60);
  });

  it('carries the name it was given', () => {
    const text = formatDecklist(MAINDECK, { name: 'Yaakov — game two' });
    expect(parseDecklist(text).name).toBe('Yaakov — game two');
  });

  it('warns in the file itself about the house changes it contains', () => {
    const witness = [{ oracleId: idOf('Eternal Witness'), count: 1 }];
    const text = formatDecklist(witness);
    expect(text).toMatch(/House changes/);
    expect(text).toMatch(/Eternal Witness/);
    // And the comment does not become a card when it is read back.
    const back = parseDecklist(text);
    expect(back.entries).toHaveLength(1);
    expect(countOf(back.entries, 'Eternal Witness')).toBe(1);
  });

  it('writes lands last, as a list is normally written', () => {
    const lines = formatDecklist([
      { oracleId: idOf('Island'), count: 4 },
      { oracleId: idOf('Show and Tell'), count: 4 },
    ])
      .split('\n')
      .filter((l) => l && !l.startsWith('//'));
    expect(lines[0]).toBe('4 Show and Tell');
    expect(lines[1]).toBe('4 Island');
  });

  it('names the file after the deck and the day', () => {
    expect(decklistFilename('Yaakov — game two', new Date('2026-09-04T10:00:00Z'))).toBe(
      'yaakov-game-two-2026-09-04.txt',
    );
    expect(decklistFilename('', new Date('2026-09-04T10:00:00Z'))).toBe('deck-2026-09-04.txt');
  });
});

describe('reading a decklist', () => {
  it('reads a plain list', () => {
    const d = parseDecklist('4 Show and Tell\n4 Brainstorm\n');
    expect(d.problems).toEqual([]);
    expect(countOf(d.entries, 'Show and Tell')).toBe(4);
    expect(countOf(d.entries, 'Brainstorm')).toBe(4);
  });

  it.each([
    ['Arena, with the printing', '4 Show and Tell (LEA) 233'],
    ['a site that writes 4x', '4x Show and Tell'],
    ['brackets round the set', '4 Show and Tell [MMQ]'],
    ['Windows line endings', '4 Show and Tell\r\n'],
    ['padding either side', '   4   Show and Tell   '],
    ['a case nobody typed carefully', '4 sHoW aNd TeLl'],
  ])('reads %s', (_label, text) => {
    const d = parseDecklist(text);
    expect(d.problems).toEqual([]);
    expect(countOf(d.entries, 'Show and Tell')).toBe(4);
  });

  it('treats a bare name as a single copy', () => {
    expect(countOf(parseDecklist('Show and Tell').entries, 'Show and Tell')).toBe(1);
  });

  it('adds the same card up when it is written twice', () => {
    const d = parseDecklist('2 Brainstorm\n2 Brainstorm\n');
    expect(d.entries).toHaveLength(1);
    expect(countOf(d.entries, 'Brainstorm')).toBe(4);
  });

  it('skips comments, blank lines and section headings', () => {
    const d = parseDecklist(
      ['// a comment', '# another', '', 'Deck', '4 Brainstorm', '   ', ''].join('\n'),
    );
    expect(d.problems).toEqual([]);
    expect(d.entries).toHaveLength(1);
  });

  it('leaves a sideboard out of the deck but says it saw one', () => {
    const d = parseDecklist(['4 Brainstorm', '', 'Sideboard', '2 Show and Tell'].join('\n'));
    expect(countOf(d.entries, 'Show and Tell')).toBe(0);
    expect(d.ignoredSideboard).toBe(2);
  });

  it('leaves MTGO’s per-line sideboard marks out too', () => {
    const d = parseDecklist('4 Brainstorm\nSB: 2 Show and Tell\n');
    expect(countOf(d.entries, 'Show and Tell')).toBe(0);
    expect(d.ignoredSideboard).toBe(2);
  });

  it('reports the line a bad name is on and keeps the rest of the deck', () => {
    const d = parseDecklist('4 Brainstorm\n4 Black Lotus\n4 Show and Tell\n');
    expect(d.problems).toHaveLength(1);
    expect(d.problems[0].line).toBe(2);
    expect(d.problems[0].reason).toMatch(/Black Lotus/);
    // The two lines that did read are still a deck.
    expect(deckSize(d.entries)).toBe(8);
  });

  it('refuses a count that would deal for ever', () => {
    const d = parseDecklist('999999999 Island\n4 Brainstorm\n');
    expect(d.problems).toHaveLength(1);
    expect(countOf(d.entries, 'Island')).toBe(0);
    expect(countOf(d.entries, 'Brainstorm')).toBe(4);
  });

  it('stops adding cards at the cap rather than growing without bound', () => {
    const text = Array.from({ length: 40 }, () => '20 Island').join('\n');
    const d = parseDecklist(text);
    expect(deckSize(d.entries)).toBeLessThanOrEqual(MAX_DECK_CARDS);
    expect(d.problems.length).toBeGreaterThan(0);
  });

  it('reads an empty file as an empty deck rather than throwing', () => {
    expect(parseDecklist('').entries).toEqual([]);
    expect(parseDecklist('   \n\n').entries).toEqual([]);
  });

  it('does not read a whole novel', () => {
    const d = parseDecklist(Array.from({ length: 3000 }, () => '// nothing').join('\n'));
    expect(d.problems.some((p) => /first 2000 lines/.test(p.reason))).toBe(true);
  });
});
