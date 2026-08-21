import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECKLIST } from '../generated/decklist.gen.js';
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
});
