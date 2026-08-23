import { describe, expect, it } from 'vitest';
import { frontFace, oracleByName } from '@engine/oracle';
import type { OracleId } from '@engine/types';
import { groupOf, sortRows, type SortMode } from '../DeckBuilder';

/**
 * Sorting the builder. Each mode answers a different question, so each one is
 * checked against the question rather than against a fixed list of names.
 */

const row = (name: string) => ({
  oracleId: oracleByName(name).oracleId,
  inDeck: 1,
  owned: 1,
});

const POOL = [
  'Omniscience', // 10, Enchantment
  'Island', // Land
  'Brainstorm', // 1, Instant
  'Atraxa, Grand Unifier', // 7, Creature
  'Show and Tell', // 3, Sorcery
  'Mana Drain', // 2, Instant
  'Watery Grave', // Land
].map(row);

const names = (mode: SortMode) =>
  sortRows(POOL, mode).map((r) => frontFace(r.oracleId).name);

describe('sorting the deck', () => {
  it('by cost puts the curve in order and the lands at the end', () => {
    const sorted = sortRows(POOL, 'cost');
    const spells = sorted.filter((r) => !frontFace(r.oracleId).types.includes('Land'));
    const lands = sorted.filter((r) => frontFace(r.oracleId).types.includes('Land'));
    // Lands are a block at the bottom, not scattered among the free spells.
    expect(sorted.slice(sorted.length - lands.length)).toEqual(lands);
    const costs = spells.map((r) => frontFace(r.oracleId).mv);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
  });

  it('by type follows the order a decklist is written in', () => {
    const sorted = names('type');
    expect(sorted.indexOf('Atraxa, Grand Unifier')).toBeLessThan(sorted.indexOf('Brainstorm'));
    expect(sorted.indexOf('Brainstorm')).toBeLessThan(sorted.indexOf('Show and Tell'));
    expect(sorted.indexOf('Show and Tell')).toBeLessThan(sorted.indexOf('Omniscience'));
    // Lands still last.
    expect(sorted[sorted.length - 1]).toMatch(/Island|Watery Grave/);
  });

  it('by type keeps the curve inside each group', () => {
    const sorted = names('type');
    expect(sorted.indexOf('Brainstorm')).toBeLessThan(sorted.indexOf('Mana Drain'));
  });

  it('by name is plain alphabetical, lands included', () => {
    const sorted = names('name');
    expect(sorted).toEqual([...sorted].sort((a, b) => a.localeCompare(b)));
    // Nothing is special-cased out of the ordering.
    expect(sorted).toHaveLength(POOL.length);
  });

  it('does not lose or duplicate a card in any mode', () => {
    for (const mode of ['cost', 'type', 'name'] as SortMode[]) {
      expect(sortRows(POOL, mode).map((r) => r.oracleId).sort()).toEqual(
        POOL.map((r) => r.oracleId).sort(),
      );
    }
  });
});

describe('the headings a sorted list breaks into', () => {
  const id = (name: string): OracleId => oracleByName(name).oracleId;

  it('groups by mana value under cost, with lands of their own', () => {
    expect(groupOf(id('Brainstorm'), 'cost')).toBe('1 mana');
    expect(groupOf(id('Omniscience'), 'cost')).toBe('10 mana');
    expect(groupOf(id('Island'), 'cost')).toBe('Lands');
  });

  it('files a card under its first decklist type', () => {
    expect(groupOf(id('Atraxa, Grand Unifier'), 'type')).toBe('Creature');
    expect(groupOf(id('Mana Drain'), 'type')).toBe('Instant');
    expect(groupOf(id('Watery Grave'), 'type')).toBe('Land');
  });

  it('has no headings when sorting by name — the alphabet is the structure', () => {
    expect(groupOf(id('Brainstorm'), 'name')).toBeNull();
  });
});
