import { frontFace } from '@engine/oracle';
import type { Intent, LegalAction } from '@engine/game';
import type { PlayerView } from '@engine/redact';
import type { IID } from '@engine/types';

/**
 * Doing the same thing again.
 *
 * Some turns in this deck are a rhythm rather than a decision: tap, tap, tap;
 * cast the same cantrip off four different copies; crack the same land ability
 * over and over. The client watches what you actually did, and once a stretch of
 * it is plainly a repeat it offers to run the same stretch again as many times
 * as you say.
 *
 * Two rules keep this honest. It only ever replays *your* actions, resolved
 * against the legal actions the engine is offering right now — nothing is
 * fabricated and nothing illegal is attempted. And it never answers a question:
 * when a prompt appears the run waits for you and picks up afterwards.
 */

/** One action in a pattern: what it was, and how to say it. */
export interface RepeatStep {
  /**
   * What the action *is*, independent of which copy of the card did it. Four
   * Islands tapped for blue are four identical steps, which is exactly what
   * makes the run repeatable at all.
   */
  sig: string;
  label: string;
}

export interface RepeatPattern {
  steps: RepeatStep[];
  /** How many times it has already been done, back to back. */
  times: number;
}

function idOf(view: PlayerView, iid: IID): string {
  const c = view.cards[iid];
  if (!c) return '?';
  return c.isToken ? `token:${c.tokenName ?? 'token'}` : c.oracleId;
}

function nameOf(view: PlayerView, iid: IID): string {
  const c = view.cards[iid];
  if (!c) return 'a card';
  return c.isToken ? (c.tokenName ?? 'Token') : frontFace(c.oracleId).name;
}

/**
 * The signature of an action, or null when it is not the kind of thing worth
 * repeating.
 *
 * Passing priority is excluded on purpose: the auto-pass layer already handles
 * runs of passes, and a "repeat" that quietly passed for you would be a very
 * different and much more dangerous feature.
 */
export function signatureOf(intent: Intent, view: PlayerView): RepeatStep | null {
  const labelFromEngine = view.legalActions.find(
    (a) => a.intent.t === intent.t && sameCard(a.intent, intent),
  )?.label;
  const label = (fallback: string) => labelFromEngine ?? fallback;

  switch (intent.t) {
    case 'castSpell':
      return {
        sig: `cast|${idOf(view, intent.iid)}|${intent.free ? 'free' : 'paid'}`,
        label: label(`Cast ${nameOf(view, intent.iid)}`),
      };
    case 'playLand':
      return {
        sig: `land|${idOf(view, intent.iid)}|${intent.face ?? 'front'}`,
        label: label(`Play ${nameOf(view, intent.iid)}`),
      };
    case 'activateAbility':
      return {
        sig: `ability|${idOf(view, intent.iid)}|${intent.index}`,
        label: label(`${nameOf(view, intent.iid)} ability`),
      };
    case 'tapForMana':
      return {
        sig: `mana|${idOf(view, intent.iid)}|${intent.kind}`,
        label: label(`Tap ${nameOf(view, intent.iid)} for {${intent.kind}}`),
      };
    default:
      return null;
  }
}

function sameCard(a: Intent, b: Intent): boolean {
  const ai = 'iid' in a ? a.iid : null;
  const bi = 'iid' in b ? b.iid : null;
  return ai === bi;
}

/** The most recent run of repeated actions, shortest pattern first. */
export function detectPattern(
  history: RepeatStep[],
  { maxPeriod = 4 }: { maxPeriod?: number } = {},
): RepeatPattern | null {
  for (let period = 1; period <= maxPeriod; period++) {
    // A single action has to happen three times before it reads as a rhythm;
    // a longer sequence repeating twice is already unmistakable.
    const need = period === 1 ? 3 : 2;
    if (history.length < period * need) continue;

    const tail = history.slice(history.length - period);
    let times = 0;
    for (let rep = 0; ; rep++) {
      const start = history.length - (rep + 1) * period;
      if (start < 0) break;
      let same = true;
      for (let i = 0; i < period; i++) {
        if (history[start + i].sig !== tail[i].sig) {
          same = false;
          break;
        }
      }
      if (!same) break;
      times = rep + 1;
    }
    if (times >= need) return { steps: tail, times };
  }
  return null;
}

/** The legal action that would perform this step right now, if there is one. */
export function matchAction(view: PlayerView, step: RepeatStep): LegalAction | null {
  for (const action of view.legalActions) {
    const sig = signatureOf(action.intent, view)?.sig;
    if (sig === step.sig) return action;
  }
  return null;
}

/** A short name for the whole pattern, for the button. */
export function describePattern(steps: RepeatStep[]): string {
  if (steps.length === 1) return steps[0].label;
  if (steps.length === 2) return `${steps[0].label}, then ${steps[1].label}`;
  return `${steps[0].label} + ${steps.length - 1} more`;
}

/** Nothing may run away: a repeat is a convenience, not a script. */
export const MAX_REPEATS = 50;
