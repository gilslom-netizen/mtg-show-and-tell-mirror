import type { ChoiceView, PlayerView } from '../engine/redact.js';
import type { RngState } from '../engine/rng.js';
import { otherPlayer } from '../engine/state.js';
import type { ChoiceResponse, IID, OracleId } from '../engine/types.js';
import { sampleOpponentHand } from './determinize.js';
import { solveMatrix, sampleStrategy } from './matrix.js';
import { isLandSource } from './view.js';

/**
 * The Show and Tell choice, solved as the matrix game it is.
 *
 * DESIGN-AI.md 13.1 calls this the cheapest win in the project and it is right: this
 * is the single most important decision in the format, it is at most five options
 * against five, and unlike everything else in the game it has an exact answer that
 * can be computed rather than approximated.
 *
 * What makes it different from every other decision is that both players commit in
 * secret and the picks are revealed together. That is a simultaneous game, and in a
 * simultaneous game "play the best option" is not a conservative default — it is a
 * mistake with a name. A player who always shows Omniscience is a player whose
 * opponent knows exactly what is about to hit the battlefield and picks accordingly.
 * The unexploitable answer is a probability distribution, and no amount of scoring
 * produces one, because taking the maximum of a list is by construction deterministic.
 *
 * So: build the payoff matrix, solve it for a Nash equilibrium, and roll.
 */

/** A card to put onto the battlefield, or null for showing nothing. */
type ShowPick = OracleId | null;

const SAMPLES = 24;

/**
 * How good it is to have put this permanent onto the battlefield.
 *
 * This is the stand-in for §10's value head, which is what will price these cells
 * once there is a network. Written out rather than fitted, because the shape of the
 * answer is not in doubt in this format, and because the contribution of §13.1 is the
 * *mixing* rather than the precision of the numbers underneath it.
 *
 * `live` is how many castable cards are left in hand afterwards, and `active` is
 * whether this player gets priority before the other — Show and Tell is a sorcery, so
 * whoever cast it untaps into their own Omniscience first, and that is most of the
 * difference between the two seats.
 */
function permanentValue(pick: ShowPick, live: number, active: boolean): number {
  switch (pick) {
    case 'omniscience':
      /*
       * Free spells, and nothing to spend them on is the entire risk. An Omniscience
       * over an empty hand is a ten-mana enchantment that reads "do nothing", which
       * is why the heuristic and this agree about not showing it there.
       */
      if (live <= 0) return 15;
      return (active ? 95 : 70) + 4 * Math.min(live, 6);
    case 'atraxa_grand_unifier':
      // Seven power of flying lifelink, and it brings its own hand — which is worth
      // most precisely when there is nothing left to lose.
      return 72 + (live <= 1 ? 10 : 0);
    case 'hullbreaker_horror':
      // A seven-power body that cannot be countered and bounces something every time
      // its controller casts anything — so it is worth what the hand behind it is.
      return 50 + 4 * Math.min(live, 5);
    case null:
      return 0;
    default:
      // A land: a free land drop, off the top of the curve. Better than nothing and
      // not by much.
      return isLandSource(pick) ? 12 : 5;
  }
}

/**
 * The payoff to me of (my pick, their pick).
 *
 * Zero-sum, so it is my value minus theirs — but not quite, and the "not quite" is
 * the only interesting thing in this function. If I resolve an Omniscience with a
 * live hand on my own turn, the game is very likely over before their permanent does
 * anything at all; what they showed is close to irrelevant. Subtracting their full
 * value there would have the matrix believe a race it is not going to have.
 */
function payoff(
  mine: ShowPick,
  theirs: ShowPick,
  myLive: number,
  theirLive: number,
  iAmActive: boolean,
): number {
  const my = permanentValue(mine, myLive, iAmActive);
  const their = permanentValue(theirs, theirLive, !iAmActive);

  const iWinFirst = mine === 'omniscience' && myLive >= 2 && iAmActive;
  const theyWinFirst = theirs === 'omniscience' && theirLive >= 2 && !iAmActive;
  const theirWeight = iWinFirst ? 0.35 : 1;
  const myWeight = theyWinFirst ? 0.35 : 1;

  return (my * myWeight - their * theirWeight) / 100;
}

/**
 * Choose what to put onto the battlefield.
 *
 * The columns of the matrix are what the opponent could show, which is a question
 * about their hand — and their hand, by §2.1, is a uniform draw from the cards
 * neither of us can see. Sampling it a couple of dozen times and taking the union
 * gives the options they might have; assuming they hold their best one is the right
 * conservatism for a strategy that is trying not to be exploitable.
 */
export function showAndTellStrategy(
  view: PlayerView,
  choice: Extract<ChoiceView, { kind: 'simultaneousSecret' }>,
  rng: RngState,
): ChoiceResponse {
  const selectable = choice.myOptions.filter((o) => !o.disabledReason);
  if (selectable.length === 0) return { kind: 'secret', iid: null };

  // One iid per distinct card: two Omnisciences in hand are one option, not two.
  const byCard = new Map<OracleId, IID>();
  for (const option of selectable) {
    const oracleId = view.cards[option.iid]?.oracleId;
    if (oracleId && !byCard.has(oracleId)) byCard.set(oracleId, option.iid);
  }
  const myPicks: ShowPick[] = [...byCard.keys(), null];
  const theirPicks = sampleTheirOptions(view, rng);

  const opp = otherPlayer(view.viewer);
  // Cards still castable once the pick has left my hand. Lands do not count: an
  // Omniscience does not make a land into a spell.
  const myLive = view.hand.filter((iid) => {
    const id = view.cards[iid]?.oracleId;
    return id !== undefined && !isLandSource(id);
  }).length;
  const theirLive = Math.max(0, view.players[opp].handCount - 1);
  const iAmActive = view.activePlayer === view.viewer;

  const matrix = myPicks.map((mine) =>
    theirPicks.map((theirs) =>
      payoff(
        mine,
        theirs,
        // The pick itself is about to leave my hand, so it is not one of the cards
        // waiting behind the Omniscience it might be.
        mine === null ? myLive : Math.max(0, myLive - (isLandSource(mine) ? 0 : 1)),
        theirLive,
        iAmActive,
      ),
    ),
  );

  const { rowStrategy } = solveMatrix(matrix);
  const chosen = myPicks[sampleStrategy(rowStrategy, rng)];
  return { kind: 'secret', iid: chosen === null ? null : (byCard.get(chosen) ?? null) };
}

/** What the opponent might be able to show, drawn from the cards neither of us sees. */
function sampleTheirOptions(view: PlayerView, rng: RngState): ShowPick[] {
  const seen = new Set<OracleId>();
  for (let i = 0; i < SAMPLES; i++) {
    const hand = sampleOpponentHand(view, rng);
    if (!hand) break;
    for (const oracleId of hand) {
      if (legalShowAndTellPick(oracleId)) seen.add(oracleId);
    }
  }
  // Declining is always available to them, and sometimes it is what they do.
  return [...seen, null];
}

/**
 * Show and Tell puts an artifact, creature, enchantment or land onto the battlefield.
 *
 * A modal double-faced card in hand is only its front face (CR 712.8a), so
 * Waterlogged Teachings is an instant here and never a land — the trap this whole
 * format is built on, and one an agent has to get right on both sides of the table.
 */
function legalShowAndTellPick(oracleId: OracleId): boolean {
  if (oracleId === 'waterlogged_teachings') return false;
  return (
    oracleId === 'omniscience' ||
    oracleId === 'atraxa_grand_unifier' ||
    oracleId === 'hullbreaker_horror' ||
    isLandSource(oracleId)
  );
}
