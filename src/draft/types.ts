import type { OracleId, PlayerId, RngState } from '../engine/types.js';

/**
 * The draft: a two player, pile-by-pile auction for a shared card pool.
 *
 * Each pile is four cards. Two are face up to both players; of the other two,
 * each player privately sees exactly one. So both players know three of the
 * four cards, but not the same three — the bidding is over a pile you can only
 * partly see, and over what your opponent's face tells you about the card you
 * cannot.
 *
 * Like the game engine, this is a pure state machine driven by an action log:
 * (seed, actions) determines everything, which is what lets the online path
 * rebuild a draft from Redis on every request without keeping a process alive.
 */

/** One physical card in the draft. */
export interface DraftCard {
  iid: number;
  oracleId: OracleId;
}

export interface Pile {
  /** 1-based, for display. */
  number: number;
  /** Face up to both players. */
  publicCards: number[];
  /** Face up to exactly one player each. */
  privateTo: Record<PlayerId, number>;
}

export type DraftPhase = 'bidding' | 'picking' | 'done';

export interface Auction {
  /** Highest bid so far, and who made it. */
  highest: number;
  highestBy: PlayerId | null;
  /** Whose turn it is to answer. Null once the auction has resolved. */
  toAct: PlayerId | null;
  /** Players who have withdrawn from this pile. */
  withdrawn: PlayerId[];
}

export interface DraftLogEntry {
  seq: number;
  pile: number;
  text: string;
  player?: PlayerId;
}

export interface DraftState {
  draftId: string;
  rng: RngState;
  /** Every card in the draft, by instance id. */
  cards: Record<number, DraftCard>;

  /** Undealt cards, in shuffled order. The next pile comes off the front. */
  undealt: number[];
  /**
   * Cards that cannot form a complete pile. A pile is always four cards, so a
   * pool that is not a multiple of four leaves a remainder that could not be
   * dealt evenly; those sit out and the screen says so.
   */
  setAside: number[];

  pile: Pile | null;
  phase: DraftPhase;
  auction: Auction;

  coins: Record<PlayerId, number>;
  /** Cards each player kept. */
  won: Record<PlayerId, number[]>;
  /** Cards each player was given and threw away. Private to them. */
  discarded: Record<PlayerId, number[]>;
  /** Cards from piles neither player bought. */
  unclaimed: number[];

  /** Who opens the bidding on the current pile. Alternates every pile. */
  opener: PlayerId;
  /** Set while a player chooses which cards to keep. */
  pickingBy: PlayerId | null;

  /** Total piles the pool makes, and which one is on the table. */
  pilesTotal: number;
  pileNumber: number;

  log: DraftLogEntry[];
  nextLogSeq: number;
}

export type DraftAction =
  /** A bid of 0 is a withdrawal. */
  | { t: 'bid'; amount: number }
  | { t: 'keep'; iids: number[] };
