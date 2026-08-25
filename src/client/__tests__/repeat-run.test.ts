import { beforeEach, describe, expect, it } from 'vitest';
import { oracleByName } from '@engine/oracle';
import type { ScenarioSpec } from '@engine/scenario';
import { LocalConnection, type Connection } from '../connection';
import { DEFAULT_SETTINGS, type Settings } from '../settings';
import { MAX_REPEATS, detectPattern, repeatNeedsPriority } from '../repeat';
import { bowmastersTarget, shouldStop } from '../hooks';
import { canAct, useStore } from '../store';

/**
 * The repeat runner against a real game.
 *
 * Four Brainstorms under an Omniscience is the cleanest possible rhythm: every
 * cast is free, priority comes straight back (CR 117.3c), and nothing asks a
 * question until the stack resolves — so the run can be watched one action at a
 * time with nothing else in the way.
 */

const FOUR_BRAINSTORMS: ScenarioSpec = {
  name: 'test',
  description: 'test',
  startingPlayer: 'p1',
  p1: {
    hand: ['Brainstorm', 'Brainstorm', 'Brainstorm', 'Brainstorm'],
    battlefield: ['Omniscience'],
  },
};

function attachScenario(spec: ScenarioSpec) {
  const conn = new LocalConnection({
    seed: 7,
    startingPlayer: 'p1',
    seats: ['p1', 'p2'],
    scenario: spec,
  });
  useStore.getState().attach(conn as Connection, 'p1');
  return conn;
}

/** Cast the first castable copy of a card from hand, as a click would. */
function castFromHand(name: string): void {
  const st = useStore.getState();
  const view = st.views.p1!;
  const oracleId = oracleByName(name).oracleId;
  const action = view.legalActions.find(
    (a) => a.intent.t === 'castSpell' && view.cards[a.intent.iid]?.oracleId === oracleId,
  );
  if (!action) throw new Error(`No legal cast of ${name}`);
  st.send(action.intent, 'p1');
}

const stackSize = () => useStore.getState().views.p1!.stack.length;

/** Answer whatever prompt is open, the way a player clicking through would. */
function answerAnyPrompt(): void {
  const st = useStore.getState();
  for (const seat of ['p1', 'p2'] as const) {
    const choice = st.views[seat]?.choice;
    if (!choice) continue;
    if (choice.kind === 'chooseCards') {
      const pickable = choice.options.filter((o) => !o.disabledReason).map((o) => o.iid);
      st.respond({ kind: 'cards', iids: pickable.slice(0, choice.min) }, seat);
    } else if (choice.kind === 'yesNo') {
      st.respond({ kind: 'yesNo', value: false }, seat);
    }
  }
}
const history = () => useStore.getState().actionHistory;

/**
 * The trigger policy, as the client runs it.
 *
 * It answers the same questions a run does and often gets there first, which is
 * the interesting part: the run has to notice that its question has already been
 * answered rather than waiting out its patience for a prompt that is not coming.
 */
function policyTick(): void {
  const st = useStore.getState();
  for (const seat of ['p1', 'p2'] as const) {
    const view = st.views[seat];
    const choice = view?.choice;
    if (!view || !choice) continue;
    if (choice.kind === 'orderTriggers') {
      st.respond({ kind: 'order', ids: choice.triggers.map((t) => t.id) }, seat, 'policy');
      continue;
    }
    if (choice.kind !== 'chooseTargets') continue;
    if (choice.source?.oracleId !== 'orcish_bowmasters') continue;
    const target = bowmastersTarget(
      DEFAULT_SETTINGS.triggers.bowmasters,
      choice.candidates,
      view,
      seat,
    );
    if (target) st.respond({ kind: 'targets', targets: [target] }, seat, 'policy');
  }
}

/**
 * Stands in for the comfort layer's auto-pass, using its real rule.
 *
 * A repeat run does not pass priority for you — most of a loop is the stack
 * draining between one iteration and the next, and that is the auto-pass layer's
 * job. Driving both together here is the only way to prove they do not deadlock
 * each other, which is precisely what they did on the first attempt.
 */
function autoPassTick(settings: Settings = DEFAULT_SETTINGS): boolean {
  const st = useStore.getState();
  for (const seat of ['p1', 'p2'] as const) {
    const view = st.views[seat];
    if (!view || view.winner !== null) continue;
    if (!canAct(view, seat)) continue;
    const run = st.repeat;
    if (run && run.seat === seat && repeatNeedsPriority(run.steps, run.index, view)) continue;
    // A running repeat overrides the stop settings, exactly as F6 does. Without
    // this the two layers deadlock: the run waits for a stack that only drains
    // because this passes, and this will not pass while the run is going.
    if (run?.seat !== seat && shouldStop(view, settings, 'off')) continue;
    st.send({ t: 'passPriority' }, seat, 'auto');
    return true;
  }
  return false;
}

/**
 * The loop this whole feature exists for.
 *
 * Omniscience and a Hullbreaker Horror on the battlefield, two Orcish Bowmasters
 * to pass back and forth: cast one for nothing, let the Horror bounce the one
 * already down back to your hand, the new one resolves and pings them for 1, and
 * you are exactly where you started with one less life on their clock. Four
 * steps, only one of which is an action — the rest are answers, which is why a
 * runner that only replayed actions could never drive it.
 */
const BOWMASTER_LOOP: ScenarioSpec = {
  name: 'test',
  description: 'test',
  startingPlayer: 'p1',
  p1: {
    hand: ['Orcish Bowmasters'],
    battlefield: ['Omniscience', 'Hullbreaker Horror', 'Orcish Bowmasters'],
  },
  p2: { life: 20 },
};

/** Everything a human clicks through in one turn of the loop, once. */
function playOneLoop(): void {
  const st = () => useStore.getState();
  castFromHand('Orcish Bowmasters');
  for (let guard = 0; guard < 60; guard++) {
    const view = st().views.p1!;
    const choice = view.choice;
    if (choice?.kind === 'chooseMode') {
      // The Horror's second mode: return target nonland permanent.
      st().respond({ kind: 'modes', modes: [1] }, 'p1');
      continue;
    }
    if (choice?.kind === 'chooseTargets') {
      const bowmasters = choice.candidates.find(
        (c) =>
          c.kind === 'permanent' &&
          view.cards[c.iid]?.oracleId === oracleByName('Orcish Bowmasters').oracleId &&
          view.cards[c.iid]?.controller === 'p1',
      );
      const face = choice.candidates.find((c) => c.kind === 'player' && c.id === 'p2');
      // The Horror bounces my own Bowmasters; the Bowmasters points at them.
      const pick = choice.source?.oracleId === 'hullbreaker_horror' ? bowmasters : face;
      if (!pick) throw new Error('the loop lost its target');
      st().respond({ kind: 'targets', targets: [pick] }, 'p1');
      continue;
    }
    if (choice) throw new Error(`unexpected prompt: ${choice.kind}`);
    if (view.stack.length === 0) return;
    // Let the stack resolve; both seats are ours in a local game.
    const prio = view.priorityPlayer;
    if (prio) st().send({ t: 'passPriority' }, prio);
    else return;
  }
  throw new Error('the loop did not come back round');
}

describe('the Bowmasters loop', () => {
  beforeEach(() => {
    useStore.getState().detach();
  });

  it('is recognised as a process after two turns of it', () => {
    attachScenario(BOWMASTER_LOOP);
    playOneLoop();
    playOneLoop();
    const found = detectPattern(useStore.getState().actionHistory)!;
    expect(found).not.toBeNull();
    expect(found.times).toBe(2);
    // One cast and three answers — the answers are most of the loop.
    expect(found.steps.filter((s) => s.what === 'act')).toHaveLength(1);
    expect(found.steps.filter((s) => s.what === 'answer').length).toBeGreaterThanOrEqual(2);
  });

  it('runs itself, and every round takes another point off their life', () => {
    attachScenario(BOWMASTER_LOOP);
    playOneLoop();
    playOneLoop();
    const before = useStore.getState().views.p1!.players.p2.life;
    const pattern = detectPattern(useStore.getState().actionHistory)!;

    useStore.getState().startRepeat(pattern.steps, 5, 'p1');
    for (let tick = 0; tick < 600 && useStore.getState().repeat; tick++) {
      useStore.getState().advanceRepeat();
      autoPassTick();
    }
    expect(useStore.getState().repeat).toBeNull();
    expect(useStore.getState().repeatNote).toBeNull();

    // The run goes as fast as the rules allow, which means it recasts as soon as
    // the bounce resolves and leaves the pings queued behind it. They still all
    // land — the stack just has to finish.
    for (let tick = 0; tick < 200 && useStore.getState().views.p1!.stack.length > 0; tick++) {
      if (!autoPassTick()) break;
    }
    expect(useStore.getState().views.p1!.stack).toHaveLength(0);
    expect(before - useStore.getState().views.p1!.players.p2.life).toBe(5);
  });

  it('as many as possible actually kills them', () => {
    attachScenario(BOWMASTER_LOOP);
    playOneLoop();
    playOneLoop();
    const pattern = detectPattern(useStore.getState().actionHistory)!;

    useStore.getState().startRepeat(pattern.steps, MAX_REPEATS, 'p1');
    for (let tick = 0; tick < 3000; tick++) {
      const st = useStore.getState();
      if (!st.repeat && st.views.p1!.stack.length === 0) break;
      st.advanceRepeat();
      if (!autoPassTick() && !useStore.getState().repeat) break;
    }
    // Twenty life, one ping a round: the loop is lethal and the run gets there.
    expect(useStore.getState().views.p1!.winner).toBe('p1');
  });

  /**
   * The run and the policy bar answer the same questions, and the policy usually
   * wins the race. The run then has a step whose prompt is already gone — which is
   * indistinguishable from "not asked yet" unless the policy says so.
   *
   * It used to wait out its full patience there, every round: four hundred
   * milliseconds of a progress bar sitting still on a loop that is otherwise
   * instant. This runs with no clock at all, so a run that waits cannot finish.
   */
  it('does not wait for a question the policy has already answered', () => {
    attachScenario(BOWMASTER_LOOP);
    playOneLoop();
    playOneLoop();
    const pattern = detectPattern(useStore.getState().actionHistory)!;
    const before = useStore.getState().views.p1!.players.p2.life;

    useStore.getState().startRepeat(pattern.steps, 4, 'p1');
    let ticks = 0;
    for (; ticks < 120 && useStore.getState().repeat; ticks++) {
      policyTick();
      useStore.getState().advanceRepeat();
      autoPassTick();
    }
    expect(useStore.getState().repeat).toBeNull();
    expect(useStore.getState().repeatNote).toBeNull();
    for (let tick = 0; tick < 200 && useStore.getState().views.p1!.stack.length > 0; tick++) {
      policyTick();
      if (!autoPassTick()) break;
    }
    expect(before - useStore.getState().views.p1!.players.p2.life).toBe(4);
  });

  /**
   * The standoff that killed the feature in a real game.
   *
   * A round of the loop only comes back round when the stack drains; the stack
   * only drains because the auto-pass layer passes; and that layer would not pass,
   * because there was a spell of theirs on the stack and something castable in
   * hand. So the run waited for a board that was waiting for the run, and ten
   * seconds later it stopped and blamed the loop — "Cast Orcish Bowmasters is not
   * available any more" — about a card sitting right there in hand.
   *
   * Asking for twenty rounds is a decision. It outranks a comfort stop, the same
   * way "pass to end of turn" already does.
   */
  it('keeps going when a spell of theirs would have stopped the client', () => {
    attachScenario({
      ...BOWMASTER_LOOP,
      p2: { hand: ['Brainstorm'], battlefield: ['Omniscience'], life: 20 },
    });
    playOneLoop();
    playOneLoop();
    const pattern = detectPattern(useStore.getState().actionHistory)!;

    // Their spell goes on the stack and stays there: nothing can resolve until
    // somebody passes, and the stop rule is what decides whether anybody will.
    const st = () => useStore.getState();
    // Hand them the window. The stack is empty and it stays p1's main phase: the
    // step only moves on when both pass in succession.
    st().send({ t: 'passPriority' }, 'p1');
    const p2view = st().views.p2!;
    const brainstorm = p2view.legalActions.find(
      (a) => a.intent.t === 'castSpell' && p2view.cards[a.intent.iid]?.oracleId === 'brainstorm',
    )!;
    st().send(brainstorm.intent, 'p2');
    st().send({ t: 'passPriority' }, 'p2');
    expect(st().views.p1!.stack).toHaveLength(1);
    expect(shouldStop(st().views.p1!, DEFAULT_SETTINGS, 'off')).toBe(true);

    const before = st().views.p1!.players.p2.life;
    st().startRepeat(pattern.steps, 4, 'p1');
    for (let tick = 0; tick < 900 && st().repeat; tick++) {
      policyTick();
      answerAnyPrompt();
      st().advanceRepeat();
      autoPassTick();
    }
    // It finished, rather than running out of ticks or stopping with a complaint.
    expect(st().repeat).toBeNull();
    expect(st().repeatNote).toBeNull();
    for (let tick = 0; tick < 300 && st().views.p1!.stack.length > 0; tick++) {
      policyTick();
      answerAnyPrompt();
      if (!autoPassTick()) break;
    }
    // Four rounds, four pings — plus whatever their own Brainstorm cost them.
    expect(before - st().views.p1!.players.p2.life).toBeGreaterThanOrEqual(4);
  });

  it('stops rather than guessing when the loop breaks', () => {
    attachScenario(BOWMASTER_LOOP);
    playOneLoop();
    playOneLoop();
    const pattern = detectPattern(useStore.getState().actionHistory)!;

    // Take the Horror away: the bounce it depends on is no longer on offer.
    const view = useStore.getState().views.p1!;
    const horror = view.battlefield.p1.find(
      (iid) => view.cards[iid]?.oracleId === oracleByName('Hullbreaker Horror').oracleId,
    )!;
    const conn = useStore.getState().connection as unknown as { game: { state: never } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (conn as any).game.state;
    state.zones.p1.battlefield = state.zones.p1.battlefield.filter((i: number) => i !== horror);
    state.cards[horror].zone = 'exile';
    state.zones.p1.exile.push(horror);
    useStore.getState().refresh();

    const life = useStore.getState().views.p1!.players.p2.life;
    useStore.getState().startRepeat(pattern.steps, 5, 'p1');
    for (let tick = 0; tick < 600 && useStore.getState().repeat; tick++) {
      useStore.getState().advanceRepeat();
      autoPassTick();
    }
    expect(useStore.getState().repeat).toBeNull();
    expect(useStore.getState().repeatNote).toBeTruthy();
    // It got at most one more ping in before noticing, never five.
    expect(life - useStore.getState().views.p1!.players.p2.life).toBeLessThan(5);
  });
});

describe('running a repeat', () => {
  beforeEach(() => {
    useStore.getState().detach();
  });

  it('offers nothing until the same action has really been repeated', () => {
    attachScenario(FOUR_BRAINSTORMS);
    castFromHand('Brainstorm');
    expect(detectPattern(history())).toBeNull();
    castFromHand('Brainstorm');
    expect(detectPattern(history())).toBeNull();
    castFromHand('Brainstorm');
    expect(detectPattern(history())?.times).toBe(3);
    expect(stackSize()).toBe(3);
  });

  it('does the pattern again the number of times asked', () => {
    attachScenario(FOUR_BRAINSTORMS);
    for (let i = 0; i < 3; i++) castFromHand('Brainstorm');
    const pattern = detectPattern(history())!;

    useStore.getState().startRepeat(pattern.steps, 1, 'p1');
    useStore.getState().advanceRepeat();

    expect(stackSize()).toBe(4);
    // One round asked for, one round done: the run is over on its own.
    expect(useStore.getState().repeat).toBeNull();
  });

  it('stops, with a reason, when the action runs out', () => {
    attachScenario(FOUR_BRAINSTORMS);
    for (let i = 0; i < 3; i++) castFromHand('Brainstorm');
    const pattern = detectPattern(history())!;

    // Ask for five more when only one Brainstorm is left.
    useStore.getState().startRepeat(pattern.steps, 5, 'p1');
    // The fourth cast goes through; after that the spells resolve and each one
    // asks which cards to put back, which the run waits on — so the player has
    // to keep answering for it to get anywhere.
    for (let i = 0; i < 40 && useStore.getState().repeat; i++) {
      answerAnyPrompt();
      useStore.getState().advanceRepeat();
    }

    expect(useStore.getState().repeat).toBeNull();
    expect(useStore.getState().repeatNote).toMatch(/not available/i);
    // Four casts and no more: it never invented a fifth from somewhere.
    expect(useStore.getState().views.p1!.graveyard.p1.length).toBe(4);
  });

  it('waits rather than answering a question', () => {
    attachScenario(FOUR_BRAINSTORMS);
    for (let i = 0; i < 3; i++) castFromHand('Brainstorm');
    const pattern = detectPattern(history())!;
    // Let the top Brainstorm resolve; it asks which two cards to put back.
    const st = useStore.getState();
    st.send({ t: 'passPriority' }, 'p1');
    st.send({ t: 'passPriority' }, 'p2');
    expect(useStore.getState().views.p1!.choice).not.toBeNull();

    useStore.getState().startRepeat(pattern.steps, 3, 'p1');
    const before = stackSize();
    for (let i = 0; i < 5; i++) useStore.getState().advanceRepeat();
    // Nothing was sent and nothing was answered — the prompt is still there.
    expect(useStore.getState().views.p1!.choice).not.toBeNull();
    expect(stackSize()).toBe(before);
    expect(useStore.getState().repeat).not.toBeNull();
  });

  it('is cancelled by the player doing something themselves', () => {
    attachScenario(FOUR_BRAINSTORMS);
    for (let i = 0; i < 3; i++) castFromHand('Brainstorm');
    const pattern = detectPattern(history())!;
    useStore.getState().startRepeat(pattern.steps, 5, 'p1');
    expect(useStore.getState().repeat).not.toBeNull();
    // A click of your own is the cancel gesture people actually reach for.
    useStore.getState().send({ t: 'passPriority' }, 'p1');
    expect(useStore.getState().repeat).toBeNull();
  });

  it('never runs for a seat this client does not hold', () => {
    const conn = new LocalConnection({
      seed: 7,
      startingPlayer: 'p1',
      seats: ['p1'],
      scenario: FOUR_BRAINSTORMS,
    });
    useStore.getState().attach(conn as Connection, 'p1');
    for (let i = 0; i < 3; i++) castFromHand('Brainstorm');
    const pattern = detectPattern(history())!;
    const before = stackSize();
    useStore.getState().startRepeat(pattern.steps, 2, 'p2');
    for (let i = 0; i < 4; i++) useStore.getState().advanceRepeat();
    expect(stackSize()).toBe(before);
  });
});
