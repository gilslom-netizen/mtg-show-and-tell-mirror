import type { OracleId } from '../engine/types.js';
import { isLandSource, type Read } from './view.js';

/**
 * What the heuristic knows about the twenty-five cards.
 *
 * This is the whole of stage 1's domain knowledge, kept in one file on purpose:
 * stage 4 replaces exactly this — a learned value head and a learned policy scorer
 * take over from these tables — and nothing else about the agent has to move. The
 * numbers are opinions about a specific 60-card mirror, not general card evaluation,
 * and they are only ever compared against each other.
 *
 * Scales:
 *  - `BASE_VALUE`: how much a card is worth to be holding, 0–100.
 *  - `THREAT`: how much it is worth spending an answer on the opponent's copy, 0–100.
 */

/** The three cards Show and Tell is cast to put onto the battlefield. */
export const COMBO_PERMANENTS: OracleId[] = [
  'omniscience',
  'atraxa_grand_unifier',
  'hullbreaker_horror',
];

/** Cards that find another card. Holding one is nearly as good as holding the card. */
export const SELECTION: OracleId[] = [
  'demonic_tutor',
  'assemble_the_team',
  'waterlogged_teachings',
  'dig_through_time',
  'rakshasas_bargain',
  'brainstorm',
  'planar_genesis',
];

const BASE_VALUE: Record<OracleId, number> = {
  // The two halves of the combo. Omniscience is unplayable at ten mana and is still
  // the best card in the deck, because Show and Tell is what casts it.
  omniscience: 95,
  show_and_tell: 92,

  atraxa_grand_unifier: 80,
  demonic_tutor: 78,
  dig_through_time: 72,
  rakshasas_bargain: 68,
  assemble_the_team: 66,
  mana_drain: 64,
  hullbreaker_horror: 60,
  brainstorm: 55,
  waterlogged_teachings: 52,
  planar_genesis: 50,
  orcish_bowmasters: 42,
  borne_upon_a_wind: 35,
  veil_of_summer: 30,
};

/** A land's base worth. Context moves this a long way in both directions. */
const LAND_VALUE = 40;

/**
 * The second copy of a card is worth less than the first, and for some cards a lot
 * less: one Omniscience wins the game and the second does nothing at all, whereas a
 * fourth Brainstorm is still a Brainstorm. This is the difference between a hand
 * evaluation that keeps a sensible seven and one that hoards.
 */
const DUPLICATE_KEEP: Record<OracleId, number> = {
  omniscience: 0.15,
  atraxa_grand_unifier: 0.3,
  hullbreaker_horror: 0.25,
  show_and_tell: 0.7,
  demonic_tutor: 0.4,
  borne_upon_a_wind: 0.2,
  veil_of_summer: 0.4,
};

const DEFAULT_DUPLICATE_KEEP = 0.6;

export const THREAT: Record<OracleId, number> = {
  omniscience: 100,
  atraxa_grand_unifier: 85,
  hullbreaker_horror: 75,
  dig_through_time: 60,
  rakshasas_bargain: 55,
  demonic_tutor: 55,
  mana_drain: 50,
  assemble_the_team: 50,
  veil_of_summer: 45,
  waterlogged_teachings: 45,
  orcish_bowmasters: 40,
  planar_genesis: 35,
  brainstorm: 25,
  borne_upon_a_wind: 25,
  // show_and_tell is deliberately absent: see threatOf.
};

/**
 * How badly the opponent's spell needs answering.
 *
 * Show and Tell is the one card whose threat is not a property of the card. It is a
 * symmetrical effect — resolving it also lets *me* put a permanent onto the
 * battlefield — so whether to counter it depends entirely on whether I would be
 * happy to be shown. With Omniscience and a live hand, their Show and Tell is doing
 * my work for me; with nothing to put in, it is the card that beats me.
 */
export function threatOf(oracleId: OracleId, r: Read): number {
  if (oracleId === 'show_and_tell') {
    const pick = bestShowAndTellPick(r);
    if (pick === 'omniscience' && liveCardsAfterCombo(r) >= 2) return 20;
    if (pick !== null) return 55;
    return 95;
  }
  return THREAT[oracleId] ?? 15;
}

/** Non-land cards I would still be able to use once a permanent has left my hand. */
export function liveCardsAfterCombo(r: Read): number {
  return r.hand.filter(
    (c) => !isLandSource(c.oracleId) && !COMBO_PERMANENTS.includes(c.oracleId),
  ).length;
}

/**
 * How badly I want to put this card onto the battlefield with Show and Tell.
 * Anything at or below zero is not worth showing.
 *
 * Omniscience first, but only with a hand to spend it on — an Omniscience with
 * nothing behind it is an enchantment that does nothing, and Atraxa at least draws
 * most of a new hand. Both of those beat Hullbreaker Horror, which beats a land,
 * which still beats declining: an extra land is an extra land drop.
 *
 * The same function decides the pick and prices the opponent's Show and Tell, so
 * the two answers cannot disagree about what a good board looks like.
 */
export function showAndTellRank(oracleId: OracleId, r: Read): number {
  if (oracleId === 'omniscience') return liveCardsAfterCombo(r) >= 1 ? 100 : 60;
  if (oracleId === 'atraxa_grand_unifier') return 85;
  if (oracleId === 'hullbreaker_horror') return 70;
  // A modal DFC in hand is only its front face, so it is not a legal pick at all.
  if (oracleId === 'waterlogged_teachings') return -1;
  if (isLandSource(oracleId)) return 15;
  return -1;
}

/** The best Show and Tell pick in hand, or null when nothing is worth showing. */
export function bestShowAndTellPick(r: Read): OracleId | null {
  let best: OracleId | null = null;
  let bestRank = 0;
  for (const c of r.hand) {
    const rank = showAndTellRank(c.oracleId, r);
    if (rank > bestRank) {
      bestRank = rank;
      best = c.oracleId;
    }
  }
  return best;
}

/**
 * How good a land is to have on the battlefield in this deck, ignoring whether it
 * enters tapped — that is tempo and belongs to the caller, which knows whether the
 * mana is needed this turn.
 *
 * The shape of this list is the deck's colour requirements: everything wants blue,
 * Assemble the Team and Demonic Tutor want black, Veil of Summer and Planar Genesis
 * want green, and white appears only on an Atraxa that is never hard-cast. So the
 * blue-black and blue-green duals are the best lands in the deck and Hallowed
 * Fountain is close to a basic Island.
 */
export function landQuality(oracleId: OracleId): number {
  switch (oracleId) {
    case 'breeding_pool':
    case 'watery_grave':
      return 90;
    case 'hedge_maze':
    case 'undercity_sewers':
      return 80;
    case 'island':
      return 70;
    case 'flooded_strand':
    case 'polluted_delta':
      return 65;
    case 'mystic_sanctuary':
      return 60;
    case 'hallowed_fountain':
      return 55;
    case 'mistrise_village':
      return 45;
    // Blue duals the draft hands out; the mirror never sees them.
    case 'meticulous_archive':
    case 'thundering_falls':
    case 'steam_vents':
      return 70;
    default:
      return 30;
  }
}

export interface ValueContext {
  /** Land sources I can already see — hand plus battlefield. */
  landSources: number;
  /** How many of this card I already have accounted for. */
  copiesAlready: (oracleId: OracleId) => number;
  haveShowAndTell: boolean;
  haveComboPermanent: boolean;
  /** True once Omniscience is on the battlefield: everything in hand is castable. */
  omniOut: boolean;
}

/**
 * A set of cards under consideration, and what the next one would be worth given
 * everything already in it.
 *
 * "Pick the best two of these seven" is not "score all seven and take the top two":
 * the second Omniscience is worth nothing and the fifth land is worth less than the
 * second. So every multi-card choice picks greedily, re-pricing what is left after
 * each pick, and this is the thing that gets updated in between.
 */
export class Basket {
  private constructor(
    private landSources: number,
    private counts: Map<OracleId, number>,
    private readonly omniOut: boolean,
  ) {}

  /**
   * Only what is on the battlefield. Used to judge a hand on its own merits — for a
   * mulligan the cards in hand are the thing being priced, not context for it.
   */
  static fromBoard(r: Read): Basket {
    return new Basket(r.myLands.length, new Map(), r.omniMine);
  }

  /** Battlefield and hand. Used for "should I add this card to what I have". */
  static fromHand(r: Read): Basket {
    return new Basket(r.myLands.length + r.landsInHand, new Map(r.handCounts), r.omniMine);
  }

  ctx(): ValueContext {
    return {
      landSources: this.landSources,
      copiesAlready: (id) => this.counts.get(id) ?? 0,
      haveShowAndTell: (this.counts.get('show_and_tell') ?? 0) > 0,
      haveComboPermanent: COMBO_PERMANENTS.some((id) => (this.counts.get(id) ?? 0) > 0),
      omniOut: this.omniOut,
    };
  }

  valueOf(oracleId: OracleId): number {
    return valueOf(oracleId, this.ctx());
  }

  add(oracleId: OracleId): void {
    this.counts.set(oracleId, (this.counts.get(oracleId) ?? 0) + 1);
    if (isLandSource(oracleId)) this.landSources++;
  }
}

/**
 * How much I want this card, here, now.
 *
 * Used for every "which of these do I take" question in the deck — Brainstorm's two
 * cards back, Dig Through Time's two of seven, Atraxa's one of each type, all three
 * tutors and every surveil. One function so those answers cannot disagree with each
 * other, which is how an agent ends up tutoring for a card it then bins.
 */
export function valueOf(oracleId: OracleId, ctx: ValueContext): number {
  let v: number;

  if (isLandSource(oracleId) && oracleId !== 'waterlogged_teachings') {
    /*
     * A land is the most valuable card in the deck at one land and nearly worthless
     * at six. The curve tops out at three, which is Show and Tell.
     */
    const short = Math.max(0, 3 - ctx.landSources);
    v = LAND_VALUE + short * 22 - Math.max(0, ctx.landSources - 4) * 12;
  } else {
    v = BASE_VALUE[oracleId] ?? 20;
    if (oracleId === 'waterlogged_teachings' && ctx.landSources < 2) v += 25;
  }

  // Half a combo is not half as good. Whichever half is missing is worth more.
  if (oracleId === 'show_and_tell' && !ctx.haveShowAndTell && ctx.haveComboPermanent) v += 20;
  if (COMBO_PERMANENTS.includes(oracleId) && ctx.haveShowAndTell && !ctx.haveComboPermanent) {
    v += 20;
  }
  // Omniscience is only ever cast by Show and Tell, so without one it is a brick.
  if (oracleId === 'omniscience' && !ctx.haveShowAndTell && !ctx.omniOut) v -= 25;
  // A second Omniscience does nothing once the first is down; a second answer does.
  if (ctx.omniOut && oracleId === 'omniscience') v = 2;

  const already = ctx.copiesAlready(oracleId);
  if (already > 0) {
    const keep = DUPLICATE_KEEP[oracleId] ?? DEFAULT_DUPLICATE_KEEP;
    v *= keep ** already;
  }
  return v;
}
