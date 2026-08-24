import type { Agent } from './agent.js';
import { HeuristicAgent } from './heuristic.js';
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
    default:
      throw new Error(`Unknown agent "${spec}". Known: ${AGENT_SPECS.join(', ')}`);
  }
}
