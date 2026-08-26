import { DECKLIST as decklist } from './generated/decklist.gen.js';
import { oracleByName } from './oracle.js';
import type { DeckEntry } from './state.js';

/**
 * The one decklist both players use. Loaded from data/decklist.json so the list
 * lives in data, not in code.
 */

export interface DeckLine {
  count: number;
  name: string;
}

function toEntries(lines: DeckLine[]): DeckEntry[] {
  return lines.map((l) => ({ count: l.count, oracleId: oracleByName(l.name).oracleId }));
}

export const DECK_NAME: string = decklist.name;
export const MAINDECK: DeckEntry[] = toEntries(decklist.maindeck as DeckLine[]);

export const MAINDECK_SIZE = MAINDECK.reduce((n, e) => n + e.count, 0);

if (MAINDECK_SIZE !== 60) {
  throw new Error(`Maindeck must be 60 cards, got ${MAINDECK_SIZE}`);
}
