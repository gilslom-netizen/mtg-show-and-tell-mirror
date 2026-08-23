import { DRAFT_DATA } from './generated/draft.gen.js';
import { oracleByName } from './oracle.js';
import type { DeckEntry } from './state.js';
import type { OracleId } from './types.js';

/**
 * The draft pool, and the lands every drafter is handed.
 *
 * Like everything else here, the card list lives in data/ rather than in code —
 * this module only resolves names to oracle ids and fails loudly if the data and
 * the card database ever disagree.
 */

export const COINS_PER_PLAYER: number = DRAFT_DATA.coinsPerPlayer;
export const PILE_SIZE: number = DRAFT_DATA.pileSize;
export const PICKS_PER_PILE: number = DRAFT_DATA.picksPerPile;

export const DRAFT_POOL: readonly string[] = DRAFT_DATA.pool;

/** Pool card names resolved to oracle ids, in the order the data file lists them. */
export function draftPoolOracleIds(): OracleId[] {
  return DRAFT_POOL.map((name) => oracleByName(name).oracleId);
}

/**
 * The lands a drafter starts with: for each colour, that colour paired with
 * blue, two shocklands and two surveil lands. Sixteen in all, so a drafted
 * splash always has a manabase to run on.
 */
export function grantedLands(): DeckEntry[] {
  return DRAFT_DATA.grantedLands.map((l) => ({
    count: l.count,
    oracleId: oracleByName(l.name).oracleId,
  }));
}

export const GRANTED_LAND_COUNT: number = DRAFT_DATA.grantedLands.reduce(
  (n, l) => n + l.count,
  0,
);

/**
 * How many complete piles a pool makes, and how many cards that leaves over.
 *
 * A pile is always exactly four cards — two public and one private to each
 * player — so a pool that is not a multiple of four has a remainder that cannot
 * be dealt fairly. Those cards sit out, and the draft screen says so rather than
 * letting them vanish without explanation.
 */
export function pileCount(poolSize: number, pileSize = PILE_SIZE): number {
  return Math.floor(poolSize / pileSize);
}
