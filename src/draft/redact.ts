import { averagePileValue, cardsRemaining, minimumBid, picksRequired, pilesRemaining } from './draft.js';
import type { OracleId, PlayerId } from '../engine/types.js';
import type { DraftLogEntry, DraftPhase, DraftState } from './types.js';

/**
 * What one seat is allowed to know about the draft.
 *
 * Built field by field from scratch, never by copying the state and deleting the
 * secrets — the same discipline the game's own redact() follows, and for the
 * same reason: a forgotten delete is exactly how the opponent's private card
 * ends up in the payload.
 *
 * The secrets here are: the opponent's private card in the current pile, and
 * everything either player has kept or thrown away. Coin totals are public —
 * the whole auction is played against the other player's remaining money.
 */

export interface DraftCardView {
  iid: number;
  oracleId: OracleId;
}

export interface DraftPileView {
  number: number;
  /** Face up to both players. */
  publicCards: number[];
  /** This viewer's own private card. */
  myPrivateCard: number;
  /**
   * The opponent has a private card too. Its identity is not here — only the
   * fact that it exists, so the layout can show a face-down card in its place.
   */
  opponentHasPrivateCard: boolean;
}

export interface DraftView {
  draftId: string;
  viewer: PlayerId;
  phase: DraftPhase;

  pile: DraftPileView | null;
  /** Card data for everything this viewer may look at. */
  cards: Record<number, DraftCardView>;

  coins: Record<PlayerId, number>;
  /** Your own picks and discards. The opponent's are counts only. */
  myPicks: number[];
  myDiscards: number[];
  opponentPickCount: number;

  /** Bidding state. */
  toAct: PlayerId | null;
  highestBid: number;
  highestBidder: PlayerId | null;
  withdrawn: PlayerId[];
  /** The smallest bid that would actually buy the pile. Zero always withdraws. */
  minimumBid: number;
  /** Nobody may bid past their own purse. */
  myCoins: number;

  /** Set while someone is choosing which cards to keep. */
  pickingBy: PlayerId | null;
  picksRequired: number;

  cardsRemaining: number;
  pilesRemaining: number;
  pilesTotal: number;
  averagePileValue: number | null;
  /** Cards that could not make a whole pile and sat the draft out. */
  setAsideCount: number;

  log: DraftLogEntry[];
  done: boolean;
}

/** Card data for a set of instance ids, and nothing else. */
function cardsFor(state: DraftState, iids: number[]): Record<number, DraftCardView> {
  const out: Record<number, DraftCardView> = {};
  for (const iid of iids) {
    const c = state.cards[iid];
    if (c) out[iid] = { iid: c.iid, oracleId: c.oracleId };
  }
  return out;
}

export function redactDraft(state: DraftState, viewer: PlayerId): DraftView {
  const opponent: PlayerId = viewer === 'p1' ? 'p2' : 'p1';
  const pile = state.pile;

  // The viewer may see: the pile's public cards, their own private card, and
  // everything already in their own two piles. Once they have won a pile they
  // may also see all four of its cards while choosing — that is the only moment
  // the opponent's private card becomes visible, and only to the buyer.
  const visible: number[] = [...state.won[viewer], ...state.discarded[viewer]];
  let pileView: DraftPileView | null = null;
  if (pile) {
    visible.push(...pile.publicCards, pile.privateTo[viewer]);
    if (state.phase === 'picking' && state.pickingBy === viewer) {
      visible.push(pile.privateTo[opponent]);
    }
    pileView = {
      number: pile.number,
      publicCards: [...pile.publicCards],
      myPrivateCard: pile.privateTo[viewer],
      opponentHasPrivateCard: true,
    };
  }

  return {
    draftId: state.draftId,
    viewer,
    phase: state.phase,
    pile: pileView,
    cards: cardsFor(state, visible),
    coins: { p1: state.coins.p1, p2: state.coins.p2 },
    myPicks: [...state.won[viewer]],
    myDiscards: [...state.discarded[viewer]],
    opponentPickCount: state.won[opponent].length,
    toAct: state.auction.toAct,
    highestBid: state.auction.highest,
    highestBidder: state.auction.highestBy,
    withdrawn: [...state.auction.withdrawn],
    minimumBid: minimumBid(state),
    myCoins: state.coins[viewer],
    pickingBy: state.pickingBy,
    picksRequired: picksRequired(state),
    cardsRemaining: cardsRemaining(state),
    pilesRemaining: pilesRemaining(state),
    pilesTotal: state.pilesTotal,
    averagePileValue: averagePileValue(state),
    setAsideCount: state.setAside.length,
    // The log never names a card the viewer has not seen: entries that mention
    // card names are only ever written about the player who kept them.
    log: state.log.filter((e) => !e.player || e.player === viewer || !/^keeps /.test(e.text)),
    done: state.phase === 'done',
  };
}
