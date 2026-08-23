import { beforeEach, describe, expect, it } from 'vitest';
import { oracleByName } from '@engine/oracle';
import type { ScenarioSpec } from '@engine/scenario';
import { LocalConnection, type Connection } from '../connection';
import { detectPattern } from '../repeat';
import { useStore } from '../store';

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
