import { Game, type Intent } from '../engine/game.js';
import type { MatchState } from '../engine/match.js';
import type { ChoiceView, PlayerView } from '../engine/redact.js';
import type { ChoiceResponse, GameState, PlayerId } from '../engine/types.js';
import type { Agent, SeesTruth } from './agent.js';
import { runToEnd } from './arena.js';
import { HeuristicAgent } from './heuristic.js';
import { contenders } from './pimc.js';

/**
 * PIMC that does not have to guess. A measuring instrument, not a player.
 *
 * Everything about it is identical to `PimcAgent` except one line: where PIMC deals
 * the opponent a hand consistent with what it can see, this one is handed the hand
 * they actually hold. The gap between the two is therefore the value of perfect
 * information in this format, and that is the number that decides what to build next
 * (DESIGN-AI.md 14).
 *
 * **Why that number and not exploitability itself.** §14 wants a best response
 * trained against the frozen agent, which needs a learner there is not one of yet.
 * This is the tractable question underneath it, and it splits the remaining headroom
 * in the right place:
 *
 *  - If perfect information wins by a lot, then what PIMC is losing is *information* —
 *    strategy fusion, no belief model, no bluff-reading. That is what IS-MCTS (§9.2),
 *    the particle filter (§12) and subgame CFR (§13.3) are for, and stage 3 is the
 *    next thing to build.
 *  - If it wins by little, then knowing the hidden cards is not what is missing, and
 *    more search over the same rollouts will not find it either. The headroom is in
 *    *evaluation* — §9.3's value head — and stage 3 would be a week spent on the
 *    wrong axis.
 *
 * One honest confound: with the real state there is nothing to average over, so every
 * determinization would be identical and this agent takes exactly one. It therefore
 * plays with perfect information and *fewer* playouts than the PIMC it is measured
 * against. That biases the comparison against it — so a win here is a floor on the
 * value of information, not a ceiling.
 */
export class OracleAgent implements Agent, SeesTruth {
  readonly name = 'oracle';
  /** Typed as the interface, so the calls made here are the ones an arena makes. */
  private readonly base: Agent & Pick<HeuristicAgent, 'rank'> = new HeuristicAgent();
  private readonly maxCandidates: number;
  private truth: GameState | null = null;

  readonly stats = { decisions: 0, searched: 0, playouts: 0, blind: 0 };

  constructor(opts: { maxCandidates?: number } = {}) {
    this.maxCandidates = Math.max(2, opts.maxCandidates ?? 3);
  }

  /** Called by the driver immediately before each decision. Never in real play. */
  observeTruth(state: unknown): void {
    this.truth = state as GameState;
  }

  act(view: PlayerView, budgetMs: number): Intent {
    this.stats.decisions++;
    const ranked = this.base.rank(view).filter((a) => !a.isManaAbility);
    const candidates = contenders(ranked, this.maxCandidates);
    if (candidates.length <= 1) return candidates[0]?.intent ?? { t: 'passPriority' };

    if (!this.truth) {
      // Nobody wired the hole up, so there is nothing to be an oracle about.
      this.stats.blind++;
      return this.base.act(view, budgetMs);
    }

    const totals = new Array<number>(candidates.length).fill(0);
    for (let i = 0; i < candidates.length; i++) {
      totals[i] = this.playout(this.truth, candidates[i].intent, view.viewer);
      this.stats.playouts++;
    }
    this.stats.searched++;

    let best = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (totals[i] > totals[best]) best = i;
    }
    return candidates[best].intent;
  }

  private playout(state: GameState, intent: Intent, me: PlayerId): number {
    const sim = new Game(JSON.parse(JSON.stringify(state)) as GameState);
    sim.undoable = false;
    // The rollout still plays both seats with the heuristic, exactly as PIMC's does,
    // so the only difference between the two agents is the board they start from.
    try {
      sim.submitIntent(me, intent);
    } catch {
      return 0;
    }
    runToEnd(sim, { p1: this.base, p2: this.base }, { maxSteps: 6000 });
    const winner = sim.state.winner;
    if (winner === me) return 1;
    if (winner === null || winner === 'draw') return 0.5;
    return 0;
  }

  respond(view: PlayerView, choice: ChoiceView, budgetMs: number): ChoiceResponse {
    return this.base.respond(view, choice, budgetMs);
  }

  chooseFirst(match: MatchState, me: PlayerId): PlayerId {
    return this.base.chooseFirst?.(match, me) ?? me;
  }
}
