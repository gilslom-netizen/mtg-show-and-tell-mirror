import type { GameState, PlayerId } from '../engine/types.js';
import { extractFeatures, newFeatureBuffer, FEATURE_COUNT } from './features.js';

/**
 * How likely is this seat to win from here?
 *
 * The point of §9.3, and the highest-return work left in the project: a rollout to
 * the end of the game costs about 100ms, and this costs about a microsecond. That is
 * the difference between a search that can afford ten playouts and one that can
 * afford ten thousand.
 *
 * ---
 *
 * **Why the weights are fitted and not written.**
 *
 * Principle ע2 says the reward is winning and nothing else — no credit for damage
 * dealt or cards drawn — because in a combo deck those are not the goal and a policy
 * rewarded for them learns the wrong game. An evaluation function is exactly the
 * shape of thing that violates it: it is a set of opinions about what a good position
 * looks like, applied at a point where the game has not been decided.
 *
 * The way out is not to be careful about which opinions to encode. It is to encode
 * none. These weights are fitted by logistic regression against **whether the player
 * actually went on to win**, from positions sampled out of real games. So the
 * function is not "damage is good, cards are good"; it is "in games that reached
 * positions like this one, this is how often this seat won". That is an estimate of
 * the true reward rather than a substitute for it, which is the distinction ע2 turns
 * on — and it is the same thing §10's value head will be, fitted with a hundredth of
 * the machinery.
 *
 * `npm run ai:fit-eval` regenerates them and prints what it found.
 */

/**
 * Fitted on 88,341 positions from 2,000 heuristic games, 17,669 of them held out.
 * Log loss 0.509 against 0.693 for a coin flip; 76.1% accuracy on the held-out fifth.
 *
 * Worth reading as a description of the format, because nobody chose them:
 *
 *  - **`libraryDiff` dominates everything, at 6.91.** Whoever has more cards left is
 *    winning, by a margin nothing else comes close to. That is the same fact that
 *    turned up in the game logs — nearly half of all games between competent agents
 *    end with an empty library rather than an empty life total — arriving here
 *    independently, from outcomes rather than from counting endings.
 *  - **`lifeDiff` is 1.12**, below hand size. A hand-written evaluation would almost
 *    certainly have led with life total, and would have been wrong. This is exactly
 *    the distortion ע2 warns about, avoided by not having an opinion in the first
 *    place.
 *  - **The Omniscience terms are nearly equal and opposite** (+1.21 / −1.26), which
 *    is what a symmetrical mirror should produce and is a small sign the fit is not
 *    picking up seat-specific noise.
 *  - **`myComboReady` is ~0.11, i.e. nothing.** Holding both halves of the combo with
 *    the mana to cast it barely moves the estimate — because in a mirror the
 *    opponent is holding answers, and because a hand is only worth what survives
 *    contact. This one is genuinely counter-intuitive, and it is the clearest case
 *    for fitting: it is a feature I added precisely because I was sure it mattered.
 */
export const EVAL_WEIGHTS: number[] = [
  0.2763, // bias
  1.1246, // lifeDiff
  0.0476, // myLibrary
  6.9112, // libraryDiff
  1.2079, // omniMine
  -1.261, // omniTheirs
  0.2816, // powerDiff
  -0.2009, // myHand
  1.7233, // handDiff
  -0.0325, // myTurn
  -0.1622, // landDiff
  0.1108, // myComboReady
  -0.1141, // theirComboReady
];

export function sigmoid(z: number): number {
  // Split at zero so neither branch can overflow exp() on a large magnitude.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export function scoreFeatures(features: ArrayLike<number>, weights: number[]): number {
  let z = 0;
  for (let i = 0; i < FEATURE_COUNT; i++) z += features[i] * weights[i];
  return sigmoid(z);
}

/** One buffer, reused: this is called inside the innermost loop of a search. */
const scratch = newFeatureBuffer();

/**
 * The estimate, in the same units as a rollout result: 1 for a win, 0 for a loss.
 *
 * A finished game is not estimated — it is read. An evaluation that guessed at a
 * position with a winner in it would be throwing away the only label there is.
 */
export function winProbability(
  state: GameState,
  me: PlayerId,
  weights: number[] = EVAL_WEIGHTS,
): number {
  if (state.winner !== null) {
    if (state.winner === 'draw') return 0.5;
    return state.winner === me ? 1 : 0;
  }
  extractFeatures(state, me, scratch);
  return scoreFeatures(scratch, weights);
}
