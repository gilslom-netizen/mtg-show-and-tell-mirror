import type { Intent } from '../engine/game.js';
import type { ChoiceView, PlayerView } from '../engine/redact.js';
import { nextInt, seedRng, type RngState } from '../engine/rng.js';
import type { ChoiceResponse, IID } from '../engine/types.js';
import type { Agent } from './agent.js';

/**
 * Legal moves, chosen at random.
 *
 * The floor of the ladder and the thing every other agent has to beat by a
 * significant margin before it has proved anything. It exists twice over: as the
 * baseline for the Elo arena, and as a fuzzer that drives the engine through
 * positions a sane agent would never reach.
 *
 * Randomness comes from the engine's own seeded PRNG, so an arena run is exactly
 * reproducible from its seeds — which is what makes a regression in another agent
 * distinguishable from a different roll of the dice.
 *
 * This is not the same code as the `RandomBot` in the engine's test harness: that one
 * reads `game.state` directly, which is fine for a fuzzer but is precisely what an
 * agent may not do. This one goes through a redacted view like every other agent.
 */
export class RandomAgent implements Agent {
  readonly name: string;
  private rng: RngState;

  constructor(seed = 1) {
    this.name = `random:${seed}`;
    this.rng = seedRng(seed);
  }

  private int(n: number): number {
    return nextInt(this.rng, n);
  }

  private pick<T>(arr: T[]): T {
    return arr[this.int(arr.length)];
  }

  private shuffled<T>(arr: readonly T[]): T[] {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  act(view: PlayerView): Intent {
    // Tapping lands back and forth is legal and infinite, so it is never chosen
    // deliberately; the engine's auto-tapper pays for spells anyway.
    const meaningful = view.legalActions.filter((a) => !a.isManaAbility);
    if (meaningful.length === 0 || this.int(3) === 0) return { t: 'passPriority' };
    return this.pick(meaningful).intent;
  }

  respond(_view: PlayerView, choice: ChoiceView): ChoiceResponse {
    switch (choice.kind) {
      case 'mulligan':
        // Keep most hands, so games are actually played rather than shuffled.
        return { kind: 'yesNo', value: this.int(5) > 0 };

      case 'simultaneousSecret': {
        const selectable = choice.myOptions.filter((o) => !o.disabledReason);
        const show = selectable.length > 0 && this.int(3) > 0;
        return { kind: 'secret', iid: show ? this.pick(selectable).iid : null };
      }

      case 'chooseCards': {
        const selectable = choice.options.filter((o) => !o.disabledReason).map((o) => o.iid);
        const n = Math.min(
          choice.min + this.int(Math.max(1, choice.max - choice.min + 1)),
          selectable.length,
        );
        return { kind: 'cards', iids: this.shuffled(selectable).slice(0, n) };
      }

      case 'chooseTargets':
        return {
          kind: 'targets',
          targets:
            choice.optional && this.int(2) === 0
              ? []
              : this.shuffled(choice.candidates).slice(0, choice.count),
        };

      case 'chooseMode': {
        const enabled = choice.modes.filter((m) => m.enabled).map((m) => m.index);
        const n = Math.min(
          choice.min + this.int(Math.max(1, choice.max - choice.min + 1)),
          enabled.length,
        );
        return { kind: 'modes', modes: this.shuffled(enabled).slice(0, n) };
      }

      case 'yesNo':
        return { kind: 'yesNo', value: this.int(2) === 0 };

      case 'orderTriggers':
        return { kind: 'order', ids: this.shuffled(choice.triggers.map((t) => t.id)) };

      case 'declareAttackers':
        return { kind: 'attackers', iids: choice.candidates.filter(() => this.int(2) === 0) };

      case 'declareBlockers': {
        const blocks: { blocker: IID; attacker: IID }[] = [];
        for (const b of choice.blockers) {
          if (this.int(2) === 0) continue;
          blocks.push({ blocker: b, attacker: this.pick(choice.attackers) });
        }
        return { kind: 'blockers', blocks };
      }

      case 'distributeDamage':
        return { kind: 'damage', assignment: { [choice.blockers[0]]: choice.total } };
    }
  }
}
