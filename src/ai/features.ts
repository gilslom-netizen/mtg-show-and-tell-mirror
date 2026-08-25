import { battlefield, cardsIn, getPower, isType } from '../engine/state.js';
import type { GameState, OracleId, PlayerId } from '../engine/types.js';
import { otherPlayer } from '../engine/state.js';

/**
 * The handful of numbers a position is judged by.
 *
 * Deliberately small, and deliberately not a list of everything that matters. This
 * is the input to a *fitted* evaluation (see `evaluate.ts`), and the whole point of
 * fitting rather than hand-tuning is that the weights come from what actually
 * happened in games rather than from an opinion about what ought to matter. A wide
 * feature set with a few thousand samples behind it would just be an opinion with
 * more decimal places.
 *
 * Everything is from one seat's point of view and roughly unit-scaled, because a
 * logistic fit on raw counts spends its first thousand steps discovering that a life
 * total is bigger than a land count.
 *
 * **Where §7 differs.** The full encoding is 340 numbers plus two token sequences,
 * for a network with a few hundred thousand parameters to learn from millions of
 * games. This is thirteen numbers for a linear model fitted on tens of thousands.
 * They are aimed at the same job from opposite ends of the budget, and the honest
 * expectation is that this one is much worse — the question being measured is whether
 * it is *good enough to be worth what it saves*.
 */

export const FEATURE_NAMES = [
  'bias',
  'lifeDiff',
  'myLibrary',
  'libraryDiff',
  'omniMine',
  'omniTheirs',
  'powerDiff',
  'myHand',
  'handDiff',
  'myTurn',
  'landDiff',
  'myComboReady',
  'theirComboReady',
] as const;

export const FEATURE_COUNT = FEATURE_NAMES.length;

const COMBO_PERMANENTS: OracleId[] = [
  'omniscience',
  'atraxa_grand_unifier',
  'hullbreaker_horror',
];

/** Does this seat hold both halves of the combo and the mana to cast it? */
function comboReady(state: GameState, p: PlayerId): number {
  const hand = cardsIn(state, p, 'hand');
  const hasShowAndTell = hand.some((c) => c.oracleId === 'show_and_tell');
  if (!hasShowAndTell) return 0;
  const hasThreat = hand.some((c) => COMBO_PERMANENTS.includes(c.oracleId));
  if (!hasThreat) return 0;
  const lands = battlefield(state, p).filter((c) => isType(c, 'Land')).length;
  return lands >= 3 ? 1 : 0;
}

function boardPower(state: GameState, p: PlayerId): number {
  return battlefield(state, p)
    .filter((c) => isType(c, 'Creature'))
    .reduce((n, c) => n + getPower(c), 0);
}

/** Writes the features for `me` into `out`, which the caller reuses across calls. */
export function extractFeatures(state: GameState, me: PlayerId, out: Float64Array): void {
  const opp = otherPlayer(me);
  const mine = state.players[me];
  const theirs = state.players[opp];

  const myLib = state.zones[me].library.length;
  const theirLib = state.zones[opp].library.length;
  const myHand = state.zones[me].hand.length;
  const theirHand = state.zones[opp].hand.length;

  const omni = (p: PlayerId) =>
    battlefield(state, p).some((c) => c.oracleId === 'omniscience') ? 1 : 0;
  const lands = (p: PlayerId) => battlefield(state, p).filter((c) => isType(c, 'Land')).length;

  out[0] = 1;
  out[1] = (mine.life - theirs.life) / 20;
  // Its own feature as well as a difference: nearly half of all games end when a
  // library does, so how close *mine* is to empty is not the same question as who
  // has more left.
  out[2] = myLib / 40;
  out[3] = (myLib - theirLib) / 40;
  out[4] = omni(me);
  out[5] = omni(opp);
  out[6] = (boardPower(state, me) - boardPower(state, opp)) / 7;
  out[7] = myHand / 7;
  out[8] = (myHand - theirHand) / 7;
  out[9] = state.activePlayer === me ? 1 : 0;
  out[10] = (lands(me) - lands(opp)) / 6;
  out[11] = comboReady(state, me);
  out[12] = comboReady(state, opp);
}

export function newFeatureBuffer(): Float64Array {
  return new Float64Array(FEATURE_COUNT);
}
