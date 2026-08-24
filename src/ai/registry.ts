import type { Agent } from './agent.js';
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
  'pimc',
  'pimc:<determinizations>',
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
    case 'pimc': {
      if (arg === undefined) return new PimcAgent();
      const determinizations = Number(arg);
      if (!Number.isFinite(determinizations) || determinizations < 1) {
        throw new Error(`pimc needs a positive number of determinizations, got "${arg}"`);
      }
      return new PimcAgent({ determinizations });
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
