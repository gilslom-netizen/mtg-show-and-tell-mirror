import { Game, type Intent } from '../engine/game.js';
import type { MatchState } from '../engine/match.js';
import type { ChoiceView, PlayerView } from '../engine/redact.js';
import { seedRng, type RngState } from '../engine/rng.js';
import type { ChoiceResponse, GameState, PlayerId } from '../engine/types.js';
import type { Agent } from './agent.js';
import { runToEnd } from './arena.js';
import { determinizedGame } from './determinize.js';
import { HeuristicAgent, type RankedAction } from './heuristic.js';
import { showAndTellStrategy } from './showandtell.js';

/**
 * Stage 2: Perfect Information Monte Carlo.
 *
 * The whole idea in three lines (DESIGN-AI.md 9.1). Deal the hidden cards out at
 * random in a way consistent with everything visible. Play the resulting
 * *perfect-information* game forward for each action available. Take the action with
 * the best average result.
 *
 * What makes it work here rather than merely being cheap is §2.1: both players run
 * the same known sixty cards, so a determinization is a uniform sample from the set
 * the opponent's hand provably belongs to — not a guess about what deck they are on.
 * PIMC was the state of the art in bridge and skat for years on much weaker
 * foundations than that.
 *
 * **Its three weaknesses are real and are not bugs.** Strategy fusion: inside each
 * determinization the agent "knows" the hidden cards, so it never learns to hold an
 * answer for a card it cannot see. Non-locality: it assumes the opponent would have
 * played the same way whatever their hand held. And it neither bluffs nor reads one,
 * ever. Fixing those is what stages 3 and 5 are for; pretending they are fixed here
 * would be worse than living with them.
 *
 * Two things stop it being unaffordable:
 *
 *  - **Common random numbers.** Every action inside one determinization is played out
 *    from the same board, with the same shuffle and the same rollout policy — the
 *    engine's randomness lives in the state, so cloning the state clones the dice.
 *    The comparison between actions is therefore paired, which is the same trick the
 *    arena uses on the play/draw split and buys the same large reduction in noise.
 *  - **Not searching most nodes.** The measured median branching factor is two, and
 *    most of those are "pass, or tap a land". §9.4 calls uneven budget allocation a
 *    first-order optimisation in this game rather than a tuning detail, and it is:
 *    spending nothing on the nodes where the heuristic is certain is what leaves
 *    enough for the nodes where it is not.
 */

export interface PimcOptions {
  /** How many hands to deal the opponent per decision. */
  determinizations?: number;
  /** Actions to spend playouts on, at most. */
  maxCandidates?: number;
  seed?: number;
}

const DEFAULT_DETERMINIZATIONS = 8;
const DEFAULT_MAX_CANDIDATES = 3;

/**
 * How far below its favourite an action can score and still be worth a playout.
 *
 * The heuristic's scale is not a probability and this is not a calibrated threshold —
 * it is a way of saying "the heuristic has an opinion but not a strong one". A land
 * drop scores in the nine hundreds and beats everything, so land turns cost nothing;
 * a Show and Tell at 850 against a Brainstorm at 460 is a genuine question and gets
 * asked.
 */
const CONTENDER_RATIO = 0.5;

/** Rollouts are cut off well above the longest real game rather than never. */
const ROLLOUT_MAX_STEPS = 6000;

export class PimcAgent implements Agent {
  readonly name: string;
  /**
   * The heuristic does three jobs here: it ranks the candidates, it plays out every
   * rollout for both seats, and it answers when the position cannot be searched.
   * Typed as the interface so those calls are the ones an arena would make.
   */
  private readonly base: Agent & Pick<HeuristicAgent, 'rank'> = new HeuristicAgent();
  private readonly determinizations: number;
  private readonly maxCandidates: number;
  private rng: RngState;

  /**
   * Counters, for the benchmark rather than for play.
   *
   * `budgetExceeded` is the one worth watching. A wall-clock deadline is the right
   * budget for a game against a person (§5.1) and the wrong one for an experiment:
   * how many determinizations fit in 200ms depends on what else the machine is doing,
   * so a run in which the deadline ever bites is a run that will not reproduce. Size
   * `budgetMs` so this stays at zero when the answer needs to be repeatable.
   */
  readonly stats = { decisions: 0, searched: 0, playouts: 0, unfaithful: 0, budgetExceeded: 0 };

  constructor(opts: PimcOptions = {}) {
    this.determinizations = Math.max(1, opts.determinizations ?? DEFAULT_DETERMINIZATIONS);
    this.maxCandidates = Math.max(2, opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
    this.name = `pimc:${this.determinizations}`;
    this.rng = seedRng(opts.seed ?? 20260824);
  }

  act(view: PlayerView, budgetMs: number): Intent {
    this.stats.decisions++;
    const ranked = this.base.rank(view).filter((a) => !a.isManaAbility);
    const candidates = contenders(ranked, this.maxCandidates);

    // Nothing to weigh up. This is the common case and it is why the rest is affordable.
    if (candidates.length <= 1) return candidates[0]?.intent ?? { t: 'passPriority' };

    const deadline = now() + Math.max(1, budgetMs);
    const totals = new Array<number>(candidates.length).fill(0);
    let sampled = 0;

    for (let d = 0; d < this.determinizations; d++) {
      // Always take one sample: an agent that returns the heuristic's move because
      // the clock was already gone is an agent that never searches on a slow machine.
      if (sampled > 0 && now() >= deadline) {
        this.stats.budgetExceeded++;
        break;
      }

      const dealt = determinizedGame(view, this.rng);
      if (!dealt) {
        // The view could not be rebuilt into a position this player would recognise.
        // Rather than search a board that is not this one, think without one.
        this.stats.unfaithful++;
        return this.base.act(view, budgetMs);
      }
      for (let i = 0; i < candidates.length; i++) {
        totals[i] += this.playout(dealt.state, candidates[i].intent, view.viewer);
        this.stats.playouts++;
      }
      sampled++;
    }

    if (sampled === 0) return this.base.act(view, budgetMs);
    this.stats.searched++;

    // Ties go to whichever the heuristic preferred, because `candidates` is already
    // in its order — so search only ever overrules the heuristic on evidence.
    let best = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (totals[i] > totals[best]) best = i;
    }
    return candidates[best].intent;
  }

  /**
   * One action, played to the end of the game by the heuristic on both sides.
   *
   * The state is cloned rather than undone. A clone costs more than an engine
   * decision (§6.2) and that rules out a tree search that clones at every node — but
   * this is flat: one clone per playout, against a rollout of a hundred-odd
   * decisions. Three percent overhead, for none of the risk of an undo log that has
   * to be right about every mutation in the engine.
   */
  private playout(state: GameState, intent: Intent, me: PlayerId): number {
    const sim = new Game(JSON.parse(JSON.stringify(state)) as GameState);
    sim.undoable = false;
    try {
      sim.submitIntent(me, intent);
    } catch {
      // Only reachable if the candidate list and the engine disagree, which would be
      // a bug worth failing on elsewhere; here it simply scores as badly as possible.
      return 0;
    }
    runToEnd(sim, { p1: this.base, p2: this.base }, { maxSteps: ROLLOUT_MAX_STEPS });

    const winner = sim.state.winner;
    if (winner === me) return 1;
    if (winner === null || winner === 'draw') return 0.5;
    return 0;
  }

  respond(view: PlayerView, choice: ChoiceView, budgetMs: number): ChoiceResponse {
    /*
     * The one question in this game that is not a decision but a matrix game: both
     * players commit in secret and the picks are revealed together. Everything else
     * is answered by the heuristic — a search would help at some of them, but the
     * Show and Tell choice is the node §13.1 singles out as worth solving exactly,
     * and it is the only one where taking the best answer is the wrong algorithm.
     */
    if (choice.kind === 'simultaneousSecret') {
      return showAndTellStrategy(view, choice, this.rng);
    }
    return this.base.respond(view, choice, budgetMs);
  }

  chooseFirst(match: MatchState, me: PlayerId): PlayerId {
    return this.base.chooseFirst?.(match, me) ?? me;
  }
}

/**
 * Which actions are worth playouts.
 *
 * Everything the heuristic rates at least half as well as its favourite, capped, plus
 * passing — which never scores above zero and would otherwise never be considered,
 * even though "cast this or hold it" is one of the five decisions §2.3 says the game
 * actually turns on.
 */
function contenders(ranked: RankedAction[], cap: number): RankedAction[] {
  if (ranked.length === 0) return [];
  const best = ranked[0].score;
  const out = ranked.filter((a) => a.score > 0 && a.score >= best * CONTENDER_RATIO).slice(0, cap);
  if (out.length === 0) return ranked.slice(0, 1);
  const pass = ranked.find((a) => a.intent.t === 'passPriority');
  if (pass && !out.some((a) => a.intent.t === 'passPriority')) out.push(pass);
  return out;
}

function now(): number {
  return performance.now();
}
