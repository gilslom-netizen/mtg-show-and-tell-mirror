import type { PlayerView } from '@engine/redact';
import type { ChoiceResponse, GameEvent, IID, OracleId, PlayerId } from '@engine/types';

/**
 * What the player legitimately knows about the top of their own library.
 *
 * Its own module because it is the one piece of client state that is a claim
 * about the game rather than about the interface, and a wrong claim here is
 * worse than no panel at all: it is the thing a fetchland decision is made on.
 * Pure and separate, it can be run against whole games — see the fuzz test —
 * rather than only against the two hand-written situations it was written for.
 *
 * The server still never sends library order. Everything here is built from
 * events the player was legitimately shown.
 */

export interface KnownTopEntry {
  iid: IID;
  /**
   * The card's identity, remembered at the moment it was seen.
   *
   * This panel is the player's memory, not a live query - and it was written as
   * a live query. The name was looked up in the current view on every render,
   * and the moment redaction stopped including the card (it went back under the
   * top of the library), the lookup returned "a card" and the memory read as
   * two anonymous placeholders. What you learned does not expire because the
   * card is face down again; that is the entire point of having learned it.
   */
  oracleId: OracleId;
  /** How the player came to know about this card. */
  via: 'brainstorm' | 'surveil' | 'sanctuary' | 'other';
}

export function emptyKnownTop(): Record<PlayerId, KnownTopEntry[]> {
  return { p1: [], p2: [] };
}


/**
 * Put cards on top of what is already remembered.
 *
 * The dropping is the whole of it. Putting a card on top of your library is also
 * a statement about where it is *not* any more, and leaving the old entry behind
 * is how the panel came to list the same card twice: a Ponder over three cards
 * you had already seen prepended all three and kept the old copies, so a tracker
 * that knew three cards claimed five, and positions four and five named cards
 * that were really at two and three. A card cannot be in two places in one
 * library, so it cannot be at two places in a memory of one either.
 *
 * `entries[0]` ends up on top, matching the order a card script puts them back.
 */
export function learnOnTop(list: KnownTopEntry[], entries: KnownTopEntry[]): KnownTopEntry[] {
  const added = new Set(entries.map((e) => e.iid));
  return [...entries, ...list.filter((e) => !added.has(e.iid))].slice(0, MAX_KNOWN);
}

/**
 * How deep this will ever claim to see.
 *
 * Not a display limit — the panel shows six — but a limit on the claim itself,
 * because every entry is a promise about a real card and a long tail of them is
 * a long tail of ways to be wrong.
 */
export const MAX_KNOWN = 12;

/**
 * Maintains the "you saw this" tracker. Everything here comes from information the
 * player was legitimately shown; the server still never sends library order.
 */
export function applyEventsToKnownTop(
  current: Record<PlayerId, KnownTopEntry[]>,
  events: GameEvent[],
  /** Identity lookup at the moment of learning — the views forget, this must not. */
  oracleIdOf: (iid: IID) => OracleId | undefined,
): Record<PlayerId, KnownTopEntry[]> {
  let next = current;
  const mutate = (p: PlayerId, fn: (list: KnownTopEntry[]) => KnownTopEntry[]) => {
    next = { ...next, [p]: fn(next[p]) };
  };

  for (const ev of events) {
    switch (ev.t) {
      case 'shuffle':
        // Any shuffle invalidates everything. This is the whole reason a
        // fetchland after a Brainstorm is a real decision.
        mutate(ev.player, () => []);
        break;
      case 'draw':
        mutate(ev.player, (list) => {
          if (list.length === 0) return list;
          /*
           * Your own draw names the card. If it is not the one this said was on
           * top, then this is wrong about more than one card — so forget the lot
           * rather than shuffle it along and keep claiming the rest. A panel
           * that says "nothing known" is merely unhelpful; one that confidently
           * names the wrong card is what a fetchland gets decided on.
           */
          if (ev.iid !== null && ev.iid !== list[0].iid) return [];
          return list.slice(1);
        });
        break;
      case 'zoneChange':
        if (ev.to === 'library' && ev.position === 'top') {
          mutate(ev.owner, (list) =>
            learnOnTop(list, [
              { iid: ev.iid, oracleId: oracleIdOf(ev.iid) ?? '', via: 'other' as const },
            ]),
          );
        } else if (ev.from === 'library' && ev.to !== 'library') {
          mutate(ev.owner, (list) => list.filter((e) => e.iid !== ev.iid));
        }
        break;
      default:
        break;
    }
  }
  return next;
}

/** Surveil: the cards you looked at and did not bin are still sitting on top. */
export function knownTopFromChoice(
  choice: NonNullable<PlayerView['choice']>,
  response: ChoiceResponse,
): KnownTopEntry[] | null {
  if (choice.kind !== 'chooseCards' || choice.from !== 'library') return null;
  if (response.kind !== 'cards') return null;
  // Postponing is not an answer: nothing was looked past, so nothing was learned.
  if (response.deferred) return null;
  const isSurveil = /surveil/i.test(choice.prompt);
  if (!isSurveil) return null;
  const kept = choice.options.map((o) => o.iid).filter((iid) => !response.iids.includes(iid));
  return kept.map((iid) => ({ iid, oracleId: '', via: 'surveil' as const }));
  // Note: the caller merges these with learnOnTop, which is what keeps a surveil
  // over a card you already knew about from listing it twice.
}

