import { frontFace } from '@engine/oracle';
import type { Intent, LegalAction } from '@engine/game';
import type { ChoiceView, PlayerView } from '@engine/redact';
import type { ChoiceResponse, IID, OracleId, PlayerId, TargetRef } from '@engine/types';

/**
 * Doing the same thing again.
 *
 * The case this exists for is the loop. Omniscience out, Hullbreaker Horror out,
 * an Orcish Bowmasters in hand: cast the Bowmasters for nothing, let the Horror
 * bounce the Bowmasters already on the battlefield back to your hand, the new one
 * resolves and pings them for one, and you are exactly where you started with a
 * card in hand and one less life on their clock. That is twenty round trips
 * through the same four clicks, and the same shape shows up all over this deck.
 *
 * So a "process" here is not just a run of actions — it is the whole loop
 * including the questions it answers along the way. A recorded step is either an
 * action you took or an answer you gave, and both are stored by what they *are*
 * rather than which object they touched: "cast an Orcish Bowmasters", "bounce the
 * Orcish Bowmasters I control", "point the ping at the opponent". That is what
 * lets the same recording run against next iteration's different card objects.
 *
 * Two rules keep it honest. Every step is resolved against what the engine is
 * offering at that moment — nothing is fabricated, and a step that cannot be
 * taken ends the run and says which one. And a question the recording has no
 * answer for is never guessed at: the run stops and hands it back to you.
 */

// ---------------------------------------------------------------------------
// What a step is
// ---------------------------------------------------------------------------

/** A card, named by what it is and whose it is — never by instance. */
export interface CardDesc {
  oracleId: OracleId;
  mine: boolean;
}

export type TargetDesc =
  | { t: 'player'; mine: boolean }
  | { t: 'permanent' | 'spell' | 'card'; oracleId: OracleId; mine: boolean };

/** The answer given to a prompt, in a form that can be given again. */
export type RepeatAnswer =
  | { kind: 'targets'; refs: TargetDesc[] }
  | { kind: 'modes'; modes: number[] }
  | { kind: 'cards'; cards: CardDesc[] }
  | { kind: 'yesNo'; value: boolean }
  /** Trigger sources in the order they were stacked. */
  | { kind: 'order'; sources: OracleId[] };

interface StepBase {
  sig: string;
  label: string;
  /**
   * How deep the stack was when this step was taken. Not part of the signature —
   * it is pacing information, not identity. See `startsFromAQuietBoard`.
   */
  atStack: number;
}

export type RepeatStep =
  | (StepBase & {
      /**
       * What the action *is*, independent of which copy of the card did it. Four
       * Islands tapped for blue are four identical steps, which is exactly what
       * makes the run repeatable at all.
       */
      what: 'act';
    })
  | (StepBase & {
      what: 'answer';
      choiceKind: ChoiceView['kind'];
      /** The card that asked, so an answer is never given to the wrong question. */
      source: OracleId | null;
      answer: RepeatAnswer;
    });

/**
 * Whether a round of this pattern has to wait for the board to go quiet.
 *
 * The Bowmasters loop is recorded from an empty stack: cast, bounce, ping, and
 * only once all of that has resolved is there a Bowmasters back on the
 * battlefield for the next round's bounce to point at. A run that fired the next
 * cast the instant the card hit your hand would arrive at the Horror's trigger
 * with nothing to bounce and stop dead — which is exactly what it did.
 *
 * A pattern recorded with something already on the stack is the opposite case:
 * chaining four spells onto the stack under an Omniscience is *meant* to pile
 * up, and waiting there would be wrong. So the gate is simply whether the round
 * began on a clear stack.
 */
export function startsFromAQuietBoard(steps: RepeatStep[]): boolean {
  return steps.length > 0 && steps[0].atStack === 0;
}

/** True while a round is held back waiting for the stack to clear. */
export function waitingForAQuietBoard(
  steps: RepeatStep[],
  index: number,
  stackDepth: number,
): boolean {
  return index === 0 && startsFromAQuietBoard(steps) && stackDepth > 0;
}

/**
 * A short name for whatever is being asked.
 *
 * Shared with the minimised-decision bar, so a run that stops and a decision you
 * put aside describe the same prompt the same way.
 */
export function describePrompt(choice: ChoiceView): string {
  switch (choice.kind) {
    case 'simultaneousSecret':
      return choice.myPrompt;
    case 'mulligan':
      return 'Keep this hand or mulligan';
    case 'orderTriggers':
      return 'Order the triggers';
    case 'declareAttackers':
      return 'Declare attackers';
    case 'declareBlockers':
      return 'Declare blockers';
    default:
      return choice.prompt;
  }
}

/**
 * Prompts that mean the turn has moved on rather than that the loop changed.
 *
 * Combat and the next mulligan are not part of any loop: reaching one means the
 * stack emptied and play carried on without the round coming back — almost
 * always because the opponent answered something.
 */
export function isTurnStructurePrompt(choice: ChoiceView): boolean {
  return (
    choice.kind === 'declareAttackers' ||
    choice.kind === 'declareBlockers' ||
    choice.kind === 'mulligan'
  );
}

/**
 * Whether the run needs this priority for itself.
 *
 * The auto-pass layer asks before passing. Suppressing it whenever a run is
 * going was the first attempt and deadlocked immediately: a loop only comes back
 * round because the stack resolves, and the stack only resolves because both
 * players keep passing. So it is suppressed for exactly one case — the run has
 * an action it can take right now and is not being held back waiting for the
 * board to settle.
 */
export function repeatNeedsPriority(
  steps: RepeatStep[],
  index: number,
  view: PlayerView,
): boolean {
  if (waitingForAQuietBoard(steps, index, view.stack.length)) return false;
  const step = steps[index];
  return step.what === 'act' && matchAction(view, step) !== null;
}

export interface RepeatPattern {
  steps: RepeatStep[];
  /** How many times it has already been done, back to back. */
  times: number;
}

// ---------------------------------------------------------------------------
// Describing what happened
// ---------------------------------------------------------------------------

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

function mineOf(view: PlayerView, iid: IID, seat: PlayerId): boolean {
  return view.cards[iid]?.controller === seat;
}

/**
 * The signature of an action, or null when it is not the kind of thing worth
 * repeating.
 *
 * Passing priority is excluded on purpose: the auto-pass layer already handles
 * runs of passes, and a "repeat" that quietly passed for you would be a very
 * different and much more dangerous feature.
 */
export function stepForIntent(intent: Intent, view: PlayerView): RepeatStep | null {
  const labelFromEngine = view.legalActions.find(
    (a) => a.intent.t === intent.t && sameCard(a.intent, intent),
  )?.label;
  const act = (sig: string, fallback: string): RepeatStep => ({
    what: 'act',
    sig,
    label: labelFromEngine ?? fallback,
    atStack: view.stack.length,
  });

  switch (intent.t) {
    case 'castSpell':
      return act(
        `cast|${idOf(view, intent.iid)}|${intent.free ? 'free' : 'paid'}`,
        `Cast ${nameOf(view, intent.iid)}`,
      );
    case 'playLand':
      return act(
        `land|${idOf(view, intent.iid)}|${intent.face ?? 'front'}`,
        `Play ${nameOf(view, intent.iid)}`,
      );
    case 'activateAbility':
      return act(
        `ability|${idOf(view, intent.iid)}|${intent.index}`,
        `${nameOf(view, intent.iid)} ability`,
      );
    case 'tapForMana':
      return act(
        `mana|${idOf(view, intent.iid)}|${intent.kind}`,
        `Tap ${nameOf(view, intent.iid)} for {${intent.kind}}`,
      );
    default:
      return null;
  }
}

function sameCard(a: Intent, b: Intent): boolean {
  const ai = 'iid' in a ? a.iid : null;
  const bi = 'iid' in b ? b.iid : null;
  return ai === bi;
}

function describeTarget(ref: TargetRef, view: PlayerView, seat: PlayerId): TargetDesc | null {
  if (ref.kind === 'player') return { t: 'player', mine: ref.id === seat };
  const card = view.cards[ref.iid];
  if (!card || card.isToken) return null; // A token has no stable identity to match on.
  return { t: ref.kind, oracleId: card.oracleId, mine: mineOf(view, ref.iid, seat) };
}

function targetWord(d: TargetDesc): string {
  if (d.t === 'player') return d.mine ? 'you' : 'the opponent';
  return `${d.mine ? 'your' : 'their'} ${frontFace(d.oracleId).name}`;
}

/**
 * Turn an answer into a step, or null when it is not worth replaying.
 *
 * Mulligans, Show and Tell and the combat prompts are all one-off decisions
 * about a position that will not come round again, so they are left out — a
 * pattern that included them could never match twice anyway.
 */
export function stepForChoice(
  choice: ChoiceView,
  response: ChoiceResponse,
  view: PlayerView,
  seat: PlayerId,
): RepeatStep | null {
  const source = choice.kind === 'mulligan' || choice.kind === 'simultaneousSecret'
    ? null
    : (choice.source?.oracleId ?? null);
  const from = source ? frontFace(source).name : 'the game';

  let answer: RepeatAnswer | null = null;
  let what = '';

  if (choice.kind === 'chooseTargets' && response.kind === 'targets') {
    const refs: TargetDesc[] = [];
    for (const t of response.targets) {
      const d = describeTarget(t, view, seat);
      if (!d) return null;
      refs.push(d);
    }
    answer = { kind: 'targets', refs };
    what = refs.length === 0 ? 'no target' : refs.map(targetWord).join(' and ');
  } else if (choice.kind === 'chooseMode' && response.kind === 'modes') {
    answer = { kind: 'modes', modes: [...response.modes].sort((a, b) => a - b) };
    what =
      response.modes.length === 0
        ? 'no mode'
        : response.modes
            .map((i) => choice.modes.find((m) => m.index === i)?.text ?? `mode ${i}`)
            .join(' + ');
  } else if (choice.kind === 'chooseCards' && response.kind === 'cards') {
    // A postponement is a "come back to me", not an answer worth replaying.
    if (response.deferred) return null;
    const cards: CardDesc[] = [];
    for (const iid of response.iids) {
      const c = view.cards[iid];
      if (!c || c.isToken) return null;
      cards.push({ oracleId: c.oracleId, mine: mineOf(view, iid, seat) });
    }
    answer = { kind: 'cards', cards };
    what = cards.length === 0 ? 'none' : cards.map((c) => frontFace(c.oracleId).name).join(', ');
  } else if (choice.kind === 'yesNo' && response.kind === 'yesNo') {
    answer = { kind: 'yesNo', value: response.value };
    what = response.value ? 'yes' : 'no';
  } else if (choice.kind === 'orderTriggers' && response.kind === 'order') {
    const sources: OracleId[] = [];
    for (const id of response.ids) {
      const trigger = choice.triggers.find((t) => t.id === id);
      const card = trigger ? view.cards[trigger.sourceIid] : undefined;
      if (!card || card.isToken) return null;
      sources.push(card.oracleId);
    }
    answer = { kind: 'order', sources };
    what = sources.map((o) => frontFace(o).name).join(' then ');
  }

  if (!answer) return null;
  return {
    what: 'answer',
    sig: `answer|${choice.kind}|${source ?? '-'}|${JSON.stringify(answer)}`,
    label: `${from}: ${what}`,
    atStack: view.stack.length,
    choiceKind: choice.kind,
    source,
    answer,
  };
}

// ---------------------------------------------------------------------------
// Spotting the loop
// ---------------------------------------------------------------------------

/**
 * How long a repeated stretch may be.
 *
 * The loop this feature exists for is four steps — cast, choose the mode, choose
 * what to bounce, choose what to ping — and a couple of them disappear when a
 * trigger policy answers them, so the recorded length varies. Eight leaves room
 * for the longer ones without turning the search into a puzzle.
 */
const MAX_PERIOD = 8;

/** The most recent run of repeated steps, shortest pattern first. */
export function detectPattern(
  history: RepeatStep[],
  { maxPeriod = MAX_PERIOD }: { maxPeriod?: number } = {},
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

// ---------------------------------------------------------------------------
// Doing it again
// ---------------------------------------------------------------------------

/** The legal action that would perform this step right now, if there is one. */
export function matchAction(view: PlayerView, step: RepeatStep): LegalAction | null {
  if (step.what !== 'act') return null;
  for (const action of view.legalActions) {
    if (stepForIntent(action.intent, view)?.sig === step.sig) return action;
  }
  return null;
}

/**
 * The answer this step would give to the question now on screen, or null when it
 * does not fit — a different card asked, a different kind of question, or a
 * target that is not on the table this time round. A run never guesses: it stops
 * and hands the question back.
 */
export function responseFor(
  step: RepeatStep,
  choice: ChoiceView,
  view: PlayerView,
  seat: PlayerId,
): ChoiceResponse | null {
  if (step.what !== 'answer') return null;
  if (step.choiceKind !== choice.kind) return null;
  const source =
    choice.kind === 'mulligan' || choice.kind === 'simultaneousSecret'
      ? null
      : (choice.source?.oracleId ?? null);
  if (source !== step.source) return null;

  const answer = step.answer;

  if (answer.kind === 'targets' && choice.kind === 'chooseTargets') {
    const used = new Set<number>();
    const targets: TargetRef[] = [];
    for (const want of answer.refs) {
      const i = choice.candidates.findIndex((c, idx) => {
        if (used.has(idx)) return false;
        const d = describeTarget(c, view, seat);
        return (
          !!d &&
          d.t === want.t &&
          d.mine === want.mine &&
          (want.t === 'player' || (d.t !== 'player' && d.oracleId === want.oracleId))
        );
      });
      if (i === -1) return null;
      used.add(i);
      targets.push(choice.candidates[i]);
    }
    if (targets.length !== choice.count && !(choice.optional && targets.length === 0)) {
      return null;
    }
    return { kind: 'targets', targets };
  }

  if (answer.kind === 'modes' && choice.kind === 'chooseMode') {
    // A mode that is switched off this time round — the Horror with nothing to
    // bounce — means the loop has broken, not that some other mode will do.
    if (!answer.modes.every((i) => choice.modes.find((m) => m.index === i)?.enabled)) return null;
    if (answer.modes.length < choice.min || answer.modes.length > choice.max) return null;
    return { kind: 'modes', modes: answer.modes };
  }

  if (answer.kind === 'cards' && choice.kind === 'chooseCards') {
    const used = new Set<IID>();
    const iids: IID[] = [];
    for (const want of answer.cards) {
      const found = choice.options.find(
        (o) =>
          !used.has(o.iid) &&
          !o.disabledReason &&
          view.cards[o.iid]?.oracleId === want.oracleId &&
          mineOf(view, o.iid, seat) === want.mine,
      );
      if (!found) return null;
      used.add(found.iid);
      iids.push(found.iid);
    }
    if (iids.length < choice.min || iids.length > choice.max) return null;
    return { kind: 'cards', iids };
  }

  if (answer.kind === 'yesNo' && choice.kind === 'yesNo') {
    return { kind: 'yesNo', value: answer.value };
  }

  if (answer.kind === 'order' && choice.kind === 'orderTriggers') {
    const used = new Set<number>();
    const ids: number[] = [];
    for (const want of answer.sources) {
      const t = choice.triggers.find(
        (x) => !used.has(x.id) && view.cards[x.sourceIid]?.oracleId === want,
      );
      if (!t) return null;
      used.add(t.id);
      ids.push(t.id);
    }
    if (ids.length !== choice.triggers.length) return null;
    return { kind: 'order', ids };
  }

  return null;
}

/** A short name for the whole pattern, for the button. */
export function describePattern(steps: RepeatStep[]): string {
  if (steps.length === 1) return steps[0].label;
  if (steps.length === 2) return `${steps[0].label}, then ${steps[1].label}`;
  return `${steps[0].label} + ${steps.length - 1} more`;
}

/**
 * Nothing may run away: a repeat is a convenience, not a script. Fifty rounds is
 * more than enough to take an opponent from twenty to nothing one ping at a time.
 */
export const MAX_REPEATS = 50;
