import type { Agent } from './agent.js';
import { ExploiterAgent } from './exploiter.js';
import { HeuristicAgent } from './heuristic.js';
import { OracleAgent } from './oracle-agent.js';
import { PimcAgent } from './pimc.js';
import { RandomAgent } from './random.js';

/**
 * Agents by name.
 *
 * Naming them as strings is not decoration: it is what lets the arena hand a
 * matchup to a worker thread, and what lets a run be reproduced from its command
 * line alone. Anything an agent needs in order to be rebuilt has to fit in its spec.
 */

export const AGENT_SPECS = [
  'random',
  'random:<seed>',
  'heuristic',
  'exploiter (a hand-built best response — measures how easily a person finds a hole)',
  'pimc',
  'pimc:<determinizations>',
  'pimc-eval:<determinizations>/<horizon turns>',
  'oracle (cheats — for measurement only)',
  'oracle-hands:<determinizations> (cheats — for measurement only)',
] as const;

export function makeAgent(spec: string): Agent {
  const [kind, arg] = spec.split(':');
  switch (kind) {
    case 'random': {
      const seed = arg === undefined ? 1 : Number(arg);
      if (!Number.isFinite(seed)) throw new Error(`random needs an integer seed, got "${arg}"`);
      return new RandomAgent(seed);
    }
    case 'heuristic':
      return new HeuristicAgent();
    /*
     * Not a rung on the ladder: a hand-built best response, used to ask how much of
     * an agent's rating survives an opponent who is looking for its blind spot
     * rather than playing its own game (§14). Perfectly legal — it reads only the
     * public board — which is what makes the answer uncomfortable.
     */
    case 'exploiter':
      return new ExploiterAgent();
    case 'pimc': {
      if (arg === undefined) return new PimcAgent();
      const determinizations = Number(arg);
      if (!Number.isFinite(determinizations) || determinizations < 1) {
        throw new Error(`pimc needs a positive number of determinizations, got "${arg}"`);
      }
      return new PimcAgent({ determinizations });
    }
    /*
     * §9.3: the same search, but each playout stops after a few turns and asks the
     * fitted evaluation instead of grinding the game out. `pimc-eval:8/3` is eight
     * determinizations with a three-turn horizon.
     */
    case 'pimc-eval': {
      const [dets, horizon] = (arg ?? '8/3').split('/').map(Number);
      if (!Number.isFinite(dets) || dets < 1 || !Number.isFinite(horizon) || horizon < 0) {
        throw new Error(`pimc-eval wants <determinizations>/<turns>, got "${arg}"`);
      }
      return new PimcAgent({ determinizations: dets, horizonTurns: horizon });
    }
    /*
     * A measuring instrument rather than an opponent: it is shown the opponent's
     * actual hand. Never deploy it, and never read a result against it as strength —
     * the number it produces is the value of perfect information, which is what
     * decides whether the work left is about belief or about evaluation (§14).
     */
    case 'oracle':
      return new OracleAgent({ knows: 'everything' });
    /*
     * The half of the gap that is actually recoverable: it knows the hands, which is
     * what PIMC is guessing at, and reshuffles the libraries, which nobody could ever
     * deduce. Same playout count as `pimc:<n>`, so the only difference is knowing.
     */
    case 'oracle-hands': {
      const determinizations = arg === undefined ? 8 : Number(arg);
      if (!Number.isFinite(determinizations) || determinizations < 1) {
        throw new Error(`oracle-hands needs a positive count, got "${arg}"`);
      }
      return new OracleAgent({ knows: 'hands', determinizations });
    }
    default:
      throw new Error(`Unknown agent "${spec}". Known: ${AGENT_SPECS.join(', ')}`);
  }
}
