import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECKLIST } from '../generated/decklist.gen.js';
import { ERRATA_DATA } from '../generated/errata.gen.js';
import { ORACLE_DATA } from '../generated/oracle-cards.gen.js';

/**
 * The engine imports generated TypeScript rather than the JSON, because Vercel
 * transpiles each file on its own and runs it as Node ESM — where a JSON import
 * needs a type attribute that the transpiler then drops, so the function crashed
 * on load in production while working everywhere else.
 *
 * data/*.json stays the source of truth. This is what stops the copy drifting:
 * change the JSON without running `npm run gen:data` and the suite fails here.
 */
function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(process.cwd(), 'data', name), 'utf8'));
}

describe('generated card data', () => {
  it('matches data/decklist.json exactly', () => {
    expect(DECKLIST).toEqual(readJson('decklist.json'));
  });

  it('matches data/oracle-cards.json exactly', () => {
    expect(ORACLE_DATA).toEqual(readJson('oracle-cards.json'));
  });

  it('matches data/errata.json exactly', () => {
    expect(ERRATA_DATA).toEqual(readJson('errata.json'));
  });

  /**
   * The snapshot is what Wizards printed and nothing else.
   *
   * House changes live in errata.json and are applied on top when the oracle index
   * is built. Written into the snapshot instead, `npm run sync:cards` would report
   * them as upstream drift for ever — or, worse, quietly overwrite them the next
   * time somebody ran it with --write.
   */
  it('keeps the house changes out of the Scryfall snapshot', () => {
    const snapshot = readJson('oracle-cards.json') as { cards: { name: string }[] };
    const printed = new Map(snapshot.cards.map((c) => [c.name, c as Record<string, unknown>]));
    for (const e of (ERRATA_DATA as { cards: Record<string, unknown>[] }).cards) {
      const card = printed.get(e.name as string);
      expect(card, `${e.name} is not in the snapshot`).toBeDefined();
      for (const field of ['mana_cost', 'oracle_text', 'type_line', 'power', 'toughness']) {
        if (e[field] === undefined) continue;
        expect(card![field], `${e.name}: ${field} was written into the snapshot`).not.toBe(
          e[field],
        );
      }
    }
  });
});
