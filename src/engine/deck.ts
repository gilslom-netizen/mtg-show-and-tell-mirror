import decklist from '../../data/decklist.json';
import { oracleByName } from './oracle';
import type { DeckEntry } from './state';

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

/**
 * The sideboard is intentionally not wired into the engine yet — those six cards
 * are outside the implemented card pool. The Bo3 flow tracks it as data only.
 */
export const SIDEBOARD_LINES = decklist.sideboard as DeckLine[];

if (MAINDECK_SIZE !== 60) {
  throw new Error(`Maindeck must be 60 cards, got ${MAINDECK_SIZE}`);
}
