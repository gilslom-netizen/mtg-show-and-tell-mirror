import { Game, type Intent } from '../engine/game.js';
import type { MatchState } from '../engine/match.js';
import type { ChoiceView, PlayerView } from '../engine/redact.js';
import { seedRng, shuffleArray, type RngState } from '../engine/rng.js';
import type { ChoiceResponse, GameState, PlayerId } from '../engine/types.js';
import type { Agent, SeesTruth } from './agent.js';
import { runToEnd } from './arena.js';
import { HeuristicAgent } from './heuristic.js';
import { contenders } from './pimc.js';

/**
 * PIMC that does not have to guess. A measuring instrument, not a player.
 *
 * Everything about it is identical to `PimcAgent` except where the hidden cards come
 * from: PIMC deals itself a hand consistent with what it can see, and this one is
 * handed what is actually there. The gap between them is the value of the hidden
 * information, and that is the number that decides what to build next
 * (DESIGN-AI.md 14).
 *
 * **Why this and not exploitability itself.** §14 wants a best response trained
 * against the frozen agent, which needs a learner there is not one of yet. This is
 * the tractable question underneath, and it bites harder here than §14 anticipated:
 * PIMC uses the heuristic as its own rollout policy, so "+85 Elo against the
 * heuristic" is partly PIMC beating itself.
 *
 * ---
 *
 * **Two modes, because there are two kinds of hidden information and only one of them
 * is worth building for.**
 *
 * `everything` is handed the true state entire — the opponent's hand *and* the order
 * of both libraries. That is an upper bound, and a misleading one on its own: library
 * order is not something anybody could ever deduce. It is chance, not information,
 * and no belief model in any stage of this plan would recover a card's worth of it.
 *
 * `hands` is handed the true hands and then reshuffles both libraries. So it knows
 * exactly what PIMC is trying to guess and nothing else, which makes the difference
 * between it and PIMC the part of the gap that is actually **recoverable** — by
 * IS-MCTS (§9.2), by the particle filter (§12), by subgame CFR (§13.3).
 *
 * Read together they split the headroom where the decision needs it split:
 *
 * ```
 *   pimc:8  →  hands   =  what better belief could win        →  is stage 3 worth it
 *   hands   →  everything = what is simply luck               →  nobody can have this
 * ```
 *
 * A large first gap justifies stage 3. A small first gap under a large second one
 * says the format is chancier than it looks and that more belief modelling is a week
 * spent on the wrong axis.
 */
export type OracleKnowledge = 'everything' | 'hands';

export class OracleAgent implements Agent, SeesTruth {
  readonly name: string;
  /** Typed as the interface, so the calls made here are the ones an arena makes. */
  private readonly base: Agent & Pick<HeuristicAgent, 'rank'> = new HeuristicAgent();
  private readonly maxCandidates: number;
  private readonly knows: OracleKnowledge;
  private readonly determinizations: number;
  private rng: RngState;
  private truth: GameState | null = null;

  readonly stats = { decisions: 0, searched: 0, playouts: 0, blind: 0 };

  constructor(
    opts: {
      knows?: OracleKnowledge;
      /** Only meaningful for `hands`: with the whole truth there is nothing to average. */
      determinizations?: number;
      maxCandidates?: number;
      seed?: number;
    } = {},
  ) {
    this.knows = opts.knows ?? 'everything';
    this.maxCandidates = Math.max(2, opts.maxCandidates ?? 3);
    // With the entire state there is only one board to play, and a second sample of
    // it would be the same board with the same dice and the same answer.
    this.determinizations =
      this.knows === 'everything' ? 1 : Math.max(1, opts.determinizations ?? 8);
    this.name = this.knows === 'everything' ? 'oracle' : `oracle-hands:${this.determinizations}`;
    this.rng = seedRng(opts.seed ?? 20260824);
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
    for (let d = 0; d < this.determinizations; d++) {
      const board = this.board(this.truth);
      for (let i = 0; i < candidates.length; i++) {
        totals[i] += this.playout(board, candidates[i].intent, view.viewer);
        this.stats.playouts++;
      }
    }
    this.stats.searched++;

    let best = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (totals[i] > totals[best]) best = i;
    }
    return candidates[best].intent;
  }

  /**
   * The board to play forward from: the real one, or the real one with the libraries
   * shuffled so that only the hands are known.
   */
  private board(truth: GameState): GameState {
    if (this.knows === 'everything') return truth;
    const state = JSON.parse(JSON.stringify(truth)) as GameState;
    for (const p of ['p1', 'p2'] as PlayerId[]) shuffleArray(this.rng, state.zones[p].library);
    return state;
  }

  private playout(state: GameState, intent: Intent, me: PlayerId): number {
    const sim = new Game(JSON.parse(JSON.stringify(state)) as GameState);
    sim.undoable = false;
    // The rollout still plays both seats with the heuristic, exactly as PIMC's does,
    // so the only difference between the agents is the board they start from.
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
