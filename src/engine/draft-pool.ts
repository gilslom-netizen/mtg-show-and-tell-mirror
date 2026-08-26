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

/**
 * How many piles a draft deals, whatever the pool holds.
 *
 * A fixed number rather than "as many as the cards make", and the difference is
 * what the cards that do not get dealt are for. Deal every pile the pool allows
 * and a draft sees all but the remainder every time, so the same cards turn up in
 * every draft and only their order changes — and a cube sized to divide evenly,
 * as this one now is, sees literally all of them. Deal a fixed fourteen out of a
 * shuffled sixty-eight and a different dozen sits out each time, which is what
 * makes two drafts of the same cube different drafts rather than the same one
 * reshuffled.
 */
export const PILES: number = DRAFT_DATA.piles;

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
 * How many piles this many cards makes.
 *
 * Two limits, and both of them leave cards out. A pile is always exactly four —
 * two public and one private to each player — so a pool that is not a multiple of
 * four has a remainder that cannot be dealt fairly. On top of that the format
 * deals a fixed number of piles, so a pool larger than it needs leaves the rest
 * out too. Either way those cards sit out and the draft screen says so rather
 * than letting them vanish without explanation.
 *
 * A pool smaller than the format asks for is not an error: a short pool simply
 * makes a short draft, which is what the tests run on.
 */
export function pileCount(poolSize: number, pileSize = PILE_SIZE): number {
  return Math.min(PILES, Math.floor(poolSize / pileSize));
}
