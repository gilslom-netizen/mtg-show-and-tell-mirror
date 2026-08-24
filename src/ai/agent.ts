import type { Intent } from '../engine/game.js';
import type { MatchState } from '../engine/match.js';
import type { ChoiceView, PlayerView } from '../engine/redact.js';
import type { DeckEntry } from '../engine/state.js';
import type { ChoiceResponse, PlayerId } from '../engine/types.js';

/**
 * One interface for every agent — heuristic, search, network, and the human client.
 * That is what makes it possible to run any two of them against each other, and it
 * is what the arena and the Elo ladder are built on. See DESIGN-AI.md 5.1.
 *
 * Three things about this shape are deliberate:
 *
 *  - **There is no `state`, only `view`.** This is principle ע1 and it is enforced
 *    here by the type rather than by agreement. An agent consumes exactly
 *    `redact(state, seat)` — the same object the client gets over the wire — so an
 *    agent physically cannot learn a policy that leans on the opponent's hand or on
 *    library order, and the same code can therefore be deployed in the player's own
 *    browser. `src/ai/__tests__/contract.test.ts` checks the views actually handed
 *    out during a game as well, so a future driver cannot quietly widen this.
 *
 *  - **`budgetMs`, not a simulation count.** A time budget is what exists during a
 *    real game, so it is what a search agent should be tuned against: expand until
 *    the budget is gone (anytime), rather than against a number that means something
 *    different on every machine. A heuristic ignores it.
 *
 *  - **`respond` is separate from `act`.** The engine already separates holding
 *    priority from answering a question, and the two action spaces have almost
 *    nothing in common (DESIGN-AI.md 8).
 */
export interface Agent {
  readonly name: string;

  /** Choose an action while holding priority. */
  act(view: PlayerView, budgetMs: number): Intent;

  /**
   * Answer a pending question. `choice` is `view.choice` — passed separately so the
   * caller can narrow it and so an implementation cannot forget to check it.
   */
  respond(view: PlayerView, choice: ChoiceView, budgetMs: number): ChoiceResponse;

  /**
   * Play or draw, asked of the loser of the previous game in a series.
   * Returns which seat should be on the play.
   */
  chooseFirst?(match: MatchState, me: PlayerId): PlayerId;

  /**
   * Sideboard between games of a series.
   *
   * Declared because the drafted path will need it — a drafted series rebuilds
   * between games, which is the sideboarding this format never had. The mirror does
   * not use it: the six sideboard cards are outside the implemented card pool, so
   * there is nothing for it to return yet.
   */
  sideboard?(pool: DeckEntry[], match: MatchState): DeckEntry[];
}

/** How long a decision may take when nothing else says otherwise. */
export const DEFAULT_BUDGET_MS = 50;

/**
 * A deliberate hole in principle ע1, for measurement and never for play.
 *
 * §14 says exploitability is the only number that means anything in an
 * imperfect-information game, and that beating the agent you trained against is
 * close to meaningless without it — which bites here, because PIMC uses the
 * heuristic as its own rollout policy and so is partly beating itself.
 *
 * A true best response needs a learner. What is tractable now is the question
 * underneath it: **how much is the hidden information actually costing?** An agent
 * that implements this is handed the real state instead of having to guess at it, so
 * the gap between it and the same agent guessing is the value of perfect information
 * — which is exactly the headroom that better belief and search (stages 3, 5 and 12)
 * could recover, and exactly what tells us whether they are worth building.
 *
 * The driver only offers this to an agent that asks for it, and nothing registered
 * for real play may ask.
 */
export interface SeesTruth {
  observeTruth(state: unknown): void;
}

export function seesTruth(agent: Agent): agent is Agent & SeesTruth {
  return typeof (agent as Partial<SeesTruth>).observeTruth === 'function';
}
