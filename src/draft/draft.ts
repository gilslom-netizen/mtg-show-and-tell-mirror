import { seedRng, shuffleArray, nextInt } from '../engine/rng.js';
import { frontFace } from '../engine/oracle.js';
import {
  COINS_PER_PLAYER,
  PICKS_PER_PILE,
  PILE_SIZE,
  draftPoolOracleIds,
  pileCount,
} from '../engine/draft-pool.js';
import type { PlayerId } from '../engine/types.js';
import type { Auction, DraftAction, DraftCard, DraftState, Pile } from './types.js';

/**
 * The draft state machine.
 *
 * Every transition is a pure function of the state and one action, and all
 * randomness comes from the seeded generator inside the state — so a draft is
 * fully determined by (seed, action log), exactly like a game. That is what
 * lets the serverless path rebuild a draft by replaying the log on each request.
 */

function other(p: PlayerId): PlayerId {
  return p === 'p1' ? 'p2' : 'p1';
}

function freshAuction(opener: PlayerId): Auction {
  return { highest: 0, highestBy: null, toAct: opener, withdrawn: [] };
}

function log(s: DraftState, text: string, player?: PlayerId): void {
  s.log.push({ seq: s.nextLogSeq++, pile: s.pileNumber, text, ...(player ? { player } : {}) });
}

export interface CreateDraftOptions {
  draftId: string;
  seed: number;
  /** Oracle ids to draft, overriding the real pool. Tests use it to run short drafts. */
  poolOracleIds?: string[];
  coins?: number;
}

export function createDraft(opts: CreateDraftOptions): DraftState {
  const rng = seedRng(opts.seed);
  const oracleIds = opts.poolOracleIds ?? draftPoolOracleIds();

  const cards: Record<number, DraftCard> = {};
  const ids: number[] = [];
  oracleIds.forEach((oracleId, i) => {
    const iid = i + 1;
    cards[iid] = { iid, oracleId };
    ids.push(iid);
  });
  shuffleArray(rng, ids);

  const total = pileCount(ids.length);
  /*
   * Which cards sit out is decided by the shuffle above, and that is the point.
   *
   * The format deals fourteen piles however big the pool is, so a sixty-three
   * card cube leaves seven cards out of every draft — a different seven each
   * time. Dealing every pile the pool allowed instead would put all but the
   * remainder into every draft, and two drafts of the same cube would differ only
   * in what order the same cards arrived in.
   */
  const dealable = total * PILE_SIZE;
  const setAside = ids.slice(dealable);
  const undealt = ids.slice(0, dealable);

  const opener: PlayerId = nextInt(rng, 2) === 0 ? 'p1' : 'p2';
  const coins = opts.coins ?? COINS_PER_PLAYER;

  const state: DraftState = {
    draftId: opts.draftId,
    rng,
    cards,
    undealt,
    setAside,
    pile: null,
    phase: 'bidding',
    auction: freshAuction(opener),
    coins: { p1: coins, p2: coins },
    won: { p1: [], p2: [] },
    discarded: { p1: [], p2: [] },
    unclaimed: [],
    opener,
    pickingBy: null,
    pilesTotal: total,
    pileNumber: 0,
    log: [],
    nextLogSeq: 1,
  };

  dealNextPile(state);
  return state;
}

function dealNextPile(s: DraftState): void {
  if (s.undealt.length < PILE_SIZE) {
    s.pile = null;
    s.phase = 'done';
    s.auction = { highest: 0, highestBy: null, toAct: null, withdrawn: [] };
    log(s, 'The draft is over.');
    return;
  }
  const four = s.undealt.splice(0, PILE_SIZE);
  s.pileNumber++;
  s.pile = {
    number: s.pileNumber,
    // Two face up to both; then one face up to each player alone. The pool is
    // already shuffled, so taking them in order is as fair as any other split.
    publicCards: [four[0], four[1]],
    privateTo: { p1: four[2], p2: four[3] },
  };
  s.phase = 'bidding';
  s.auction = freshAuction(s.opener);
}

/** Every card in the pile, in a stable order. */
export function pileCards(pile: Pile): number[] {
  return [...pile.publicCards, pile.privateTo.p1, pile.privateTo.p2];
}

/**
 * The lowest bid this player could make that would actually buy the pile.
 *
 * Zero is always available on top of this and means withdrawing.
 */
export function minimumBid(s: DraftState): number {
  return s.auction.highest + 1;
}

export function canBid(s: DraftState, player: PlayerId, amount: number): string | null {
  if (s.phase !== 'bidding') return 'Not bidding right now';
  if (s.auction.toAct !== player) return 'Not your turn to bid';
  if (!Number.isInteger(amount) || amount < 0) return 'A bid must be a whole number';
  if (amount === 0) return null; // withdrawing is always allowed
  if (amount > s.coins[player]) return `You only have ${s.coins[player]} coins`;
  if (amount <= s.auction.highest) return `You must beat ${s.auction.highest}`;
  return null;
}

function awardPile(s: DraftState, winner: PlayerId, price: number): void {
  s.coins[winner] -= price;
  s.phase = 'picking';
  s.pickingBy = winner;
  s.auction.toAct = null;
  log(s, `wins pile ${s.pileNumber} for ${price}`, winner);
}

function noOneWins(s: DraftState): void {
  const pile = s.pile;
  if (pile) s.unclaimed.push(...pileCards(pile));
  log(s, `nobody bought pile ${s.pileNumber}; ${PILE_SIZE} cards are gone`);
  finishPile(s);
}

function finishPile(s: DraftState): void {
  s.pickingBy = null;
  s.pile = null;
  // The opener alternates every pile, so the disadvantage of bidding first is
  // shared evenly.
  s.opener = other(s.opener);
  dealNextPile(s);
}

export function applyBid(s: DraftState, player: PlayerId, amount: number): void {
  const problem = canBid(s, player, amount);
  if (problem) throw new Error(problem);

  const opponent = other(player);

  if (amount === 0) {
    s.auction.withdrawn = [...s.auction.withdrawn, player];
    log(s, 'withdraws', player);
    if (s.auction.highestBy === opponent && s.auction.highest >= 1) {
      // The opponent has a standing bid and nobody is left to beat it.
      awardPile(s, opponent, s.auction.highest);
    } else if (s.auction.withdrawn.includes(opponent)) {
      noOneWins(s);
    } else {
      // The opponent has not spoken yet: they may still claim the pile.
      s.auction.toAct = opponent;
    }
    return;
  }

  s.auction.highest = amount;
  s.auction.highestBy = player;
  log(s, `bids ${amount}`, player);
  if (s.auction.withdrawn.includes(opponent)) {
    // The opponent is already out, so this bid stands unopposed.
    awardPile(s, player, amount);
  } else {
    s.auction.toAct = opponent;
  }
}

export function picksRequired(s: DraftState): number {
  const pile = s.pile;
  if (!pile) return 0;
  return Math.min(PICKS_PER_PILE, pileCards(pile).length);
}

export function canKeep(s: DraftState, player: PlayerId, iids: number[]): string | null {
  if (s.phase !== 'picking') return 'Nothing to pick right now';
  if (s.pickingBy !== player) return 'This pile is not yours';
  const pile = s.pile;
  if (!pile) return 'No pile on the table';
  const inPile = new Set(pileCards(pile));
  const need = picksRequired(s);
  if (iids.length !== need) return `Keep exactly ${need} card${need === 1 ? '' : 's'}`;
  if (new Set(iids).size !== iids.length) return 'The same card twice';
  for (const iid of iids) if (!inPile.has(iid)) return 'That card is not in this pile';
  return null;
}

export function applyKeep(s: DraftState, player: PlayerId, iids: number[]): void {
  const problem = canKeep(s, player, iids);
  if (problem) throw new Error(problem);
  const pile = s.pile!;
  const kept = new Set(iids);
  const rest = pileCards(pile).filter((iid) => !kept.has(iid));

  s.won[player] = [...s.won[player], ...iids];
  s.discarded[player] = [...s.discarded[player], ...rest];
  log(
    s,
    `keeps ${iids.map((i) => frontFace(s.cards[i].oracleId).name).join(' and ')}`,
    player,
  );
  finishPile(s);
}

export function applyDraftAction(s: DraftState, player: PlayerId, action: DraftAction): void {
  switch (action.t) {
    case 'bid':
      applyBid(s, player, action.amount);
      return;
    case 'keep':
      applyKeep(s, player, action.iids);
      return;
  }
}

/** Cards still to be fought over, including the pile on the table. */
export function cardsRemaining(s: DraftState): number {
  return s.undealt.length + (s.pile ? PILE_SIZE : 0);
}

export function pilesRemaining(s: DraftState): number {
  return pileCount(cardsRemaining(s));
}

/**
 * What an average remaining pile is worth, in coins.
 *
 * Both players' money divided by the piles left to buy. It is the number that
 * tells you whether a bid is expensive: spend well above it and you are betting
 * that this pile is worth more than the ones you are giving up later.
 */
export function averagePileValue(s: DraftState): number | null {
  const piles = pilesRemaining(s);
  if (piles === 0) return null;
  return (s.coins.p1 + s.coins.p2) / piles;
}
