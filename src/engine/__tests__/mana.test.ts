import { describe, expect, it } from 'vitest';
import { canPay, emptyPool, parseCost, reduceGeneric, solvePayment, type ManaSource } from '../mana.js';
import { manaValueOf } from '../oracle.js';

/** DESIGN.md 9 — cost parsing and the payment solver. */

const src = (iid: number, ...produces: ('W' | 'U' | 'B' | 'R' | 'G' | 'C')[]): ManaSource => ({
  iid,
  produces,
});

describe('cost parsing', () => {
  it('parses every symbol shape in the deck', () => {
    expect(parseCost('{2}{U}')).toEqual([
      { t: 'generic', n: 2 },
      { t: 'colored', c: 'U' },
    ]);
    expect(parseCost('{3}{U/B}')).toEqual([
      { t: 'generic', n: 3 },
      { t: 'hybridColor', a: 'U', b: 'B' },
    ]);
    expect(parseCost('{2/B}{2/G}{2/U}')).toEqual([
      { t: 'hybridGeneric', n: 2, c: 'B' },
      { t: 'hybridGeneric', n: 2, c: 'G' },
      { t: 'hybridGeneric', n: 2, c: 'U' },
    ]);
  });

  it('computes mana value with the generic half of hybrids', () => {
    expect(manaValueOf('{2/B}{2/G}{2/U}')).toBe(6);
    expect(manaValueOf('{3}{U/B}')).toBe(4);
    expect(manaValueOf('{7}{U}{U}{U}')).toBe(10);
  });

  it('reduces only the generic portion', () => {
    expect(reduceGeneric(parseCost('{6}{U}{U}'), 6)).toEqual([
      { t: 'colored', c: 'U' },
      { t: 'colored', c: 'U' },
    ]);
    // Delve can never eat the coloured pips.
    expect(reduceGeneric(parseCost('{6}{U}{U}'), 99)).toEqual([
      { t: 'colored', c: 'U' },
      { t: 'colored', c: 'U' },
    ]);
  });
});

describe('payment solver', () => {
  it('112. finds {B}{G} through duals that also make blue, where greedy tapping fails', () => {
    // This is Assemble the Team's real problem: every green source in the deck is
    // a blue dual and so is every black source.
    const sources = [
      src(1, 'G', 'U'), // Breeding Pool
      src(2, 'G', 'U'), // Hedge Maze
      src(3, 'B', 'U'), // Watery Grave
    ];
    const plan = solvePayment(parseCost('{B}{G}'), emptyPool(), sources);
    expect(plan).not.toBeNull();
    const produced = plan!.taps.map((t) => t.produce).sort();
    expect(produced).toEqual(['B', 'G']);
  });

  it('reports failure when a colour is simply unavailable', () => {
    expect(canPay(parseCost('{W}'), emptyPool(), [src(1, 'U'), src(2, 'B')])).toBe(false);
  });

  it('pays Atraxa off a five-colour manabase', () => {
    const sources = [
      src(1, 'G', 'U'),
      src(2, 'W', 'U'),
      src(3, 'B', 'U'),
      src(4, 'U'),
      src(5, 'U'),
      src(6, 'U'),
      src(7, 'U'),
    ];
    const plan = solvePayment(parseCost('{3}{G}{W}{U}{B}'), emptyPool(), sources);
    expect(plan).not.toBeNull();
    expect(plan!.taps).toHaveLength(7);
  });

  it('spends floating mana before tapping anything', () => {
    const pool = { ...emptyPool(), C: 6 };
    const plan = solvePayment(parseCost('{7}{U}{U}{U}'), pool, [
      src(1, 'U'),
      src(2, 'U'),
      src(3, 'U'),
      src(4, 'U'),
    ]);
    expect(plan).not.toBeNull();
    // Six of the ten come from the Mana Drain pool, so only four lands tap.
    expect(plan!.fromPool.C).toBe(6);
    expect(plan!.taps).toHaveLength(4);
  });

  it('prefers the cheaper coloured half of a hybrid', () => {
    const plan = solvePayment(parseCost('{2/B}{2/G}{2/U}'), emptyPool(), [
      src(1, 'B'),
      src(2, 'G'),
      src(3, 'U'),
    ]);
    expect(plan).not.toBeNull();
    expect(plan!.taps).toHaveLength(3);
  });

  it('falls back to paying a hybrid generically', () => {
    const sources = Array.from({ length: 6 }, (_, i) => src(i + 1, 'U'));
    const plan = solvePayment(parseCost('{2/B}{2/G}{2/U}'), emptyPool(), sources);
    // {2}{2}{U} — the blue half is payable, the other two cost 2 generic each.
    expect(plan).not.toBeNull();
    expect(plan!.taps).toHaveLength(5);
  });

  it('avoids a reserved source unless it is the only way', () => {
    const sources: ManaSource[] = [src(1, 'U'), { ...src(2, 'U'), reserved: true }];
    const one = solvePayment(parseCost('{U}'), emptyPool(), sources);
    expect(one!.taps[0].iid).toBe(1);
    const two = solvePayment(parseCost('{1}{U}'), emptyPool(), sources);
    expect(two!.taps.map((t) => t.iid).sort()).toEqual([1, 2]);
  });

  it('solves a ten mana cost off ten duals quickly', () => {
    const sources = Array.from({ length: 10 }, (_, i) => src(i + 1, 'U', 'B'));
    const start = Date.now();
    const plan = solvePayment(parseCost('{7}{U}{U}{U}'), emptyPool(), sources);
    expect(plan).not.toBeNull();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('fails fast on an unpayable ten mana cost', () => {
    const sources = Array.from({ length: 9 }, (_, i) => src(i + 1, 'U', 'B'));
    const start = Date.now();
    expect(solvePayment(parseCost('{7}{U}{U}{U}'), emptyPool(), sources)).toBeNull();
    expect(Date.now() - start).toBeLessThan(50);
  });
});
