import { applyDraftAction, createDraft } from './draft.js';
import { MAINDECK } from '../engine/deck.js';
import { grantedLands } from '../engine/draft-pool.js';
import type { DeckEntry } from '../engine/state.js';
import type { OracleId, PlayerId } from '../engine/types.js';
import type { DraftAction, DraftState } from './types.js';

/**
 * Rebuilding a draft from its action log.
 *
 * The online path keeps no process alive between requests, so every request
 * replays (seed, actions) to get back to the current position — the same trick
 * the game itself uses.
 */

export interface DraftLoggedAction {
  seat: PlayerId;
  action: DraftAction;
}

export function buildDraft(
  draftId: string,
  seed: number,
  actions: DraftLoggedAction[],
  /** Coins each player opened with. Part of the starting position, like the seed. */
  coins?: number,
): DraftState {
  const state = createDraft({ draftId, seed, coins });
  for (const a of actions) {
    try {
      applyDraftAction(state, a.seat, a.action);
    } catch {
      // A logged action that no longer applies means the log and this code have
      // diverged. Skipping keeps the rest of the draft usable rather than
      // bricking the room, which is what the game's replay does too.
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// From a finished draft to a deck you can build
// ---------------------------------------------------------------------------

/** A card pool, as counted entries rather than instances. */
export function toEntries(oracleIds: OracleId[]): DeckEntry[] {
  const counts = new Map<OracleId, number>();
  for (const id of oracleIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].map(([oracleId, count]) => ({ oracleId, count }));
}

export function mergeEntries(...lists: DeckEntry[][]): DeckEntry[] {
  const counts = new Map<OracleId, number>();
  for (const list of lists) {
    for (const e of list) counts.set(e.oracleId, (counts.get(e.oracleId) ?? 0) + e.count);
  }
  return [...counts].map(([oracleId, count]) => ({ oracleId, count }));
}

/**
 * Everything a player may put in their deck after the draft.
 *
 * The shared main deck they always have, the cards they bought, and the sixteen
 * lands every drafter is handed — that colour plus blue, two shocks and two
 * surveil lands each — so a drafted splash always has a manabase to run on.
 */
export function draftedCardPool(wonOracleIds: OracleId[]): {
  base: DeckEntry[];
  drafted: DeckEntry[];
  lands: DeckEntry[];
  all: DeckEntry[];
} {
  const base = MAINDECK;
  const drafted = toEntries(wonOracleIds);
  const lands = grantedLands();
  return { base, drafted, lands, all: mergeEntries(base, drafted, lands) };
}
