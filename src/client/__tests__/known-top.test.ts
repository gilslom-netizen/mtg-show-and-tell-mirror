import { beforeEach, describe, expect, it } from 'vitest';
import { frontFace, oracleByName } from '@engine/oracle';
import type { ScenarioSpec } from '@engine/scenario';
import { LocalConnection, type Connection } from '../connection';
import { useStore } from '../store';
import type { IID } from '@engine/types';

/**
 * The panel that remembers the top of your library.
 *
 * It is a memory, not a query: what you learned does not expire because the card
 * is face down again. It was written as a memory and then fed from the view
 * *after* the card had moved, which is exactly the view that no longer contains
 * it — so everything it learned this way was recorded nameless and displayed as
 * "a card". A playtester sent a screenshot of it saying so.
 *
 * These check it against the library itself, which is the only thing worth
 * checking: the panel is right when it says what is actually there.
 */

const SPEC: ScenarioSpec = {
  name: 'test',
  description: 'test',
  startingPlayer: 'p1',
  /*
   * The second card matters: with nothing left to do the engine hands priority
   * to nobody and races through several turns, drawing the cards back off the
   * top before anything can be asserted about them. A card still worth casting
   * is what makes the game stop and wait, which is also what a real turn looks
   * like.
   */
  p1: {
    hand: ['Brainstorm', 'Ponder'],
    battlefield: ['Island', 'Watery Grave', 'Breeding Pool'],
  },
};

function attach() {
  const conn = new LocalConnection({
    seed: 5,
    startingPlayer: 'p1',
    seats: ['p1', 'p2'],
    scenario: SPEC,
  });
  useStore.getState().attach(conn as Connection, 'p1');
  return conn;
}

const st = () => useStore.getState();

/** What the panel claims, top first. */
const panelNames = () =>
  st().knownTop.p1.map((e) => (e.oracleId ? frontFace(e.oracleId).name : '(a card)'));

/** What is really there, top first. */
function libraryNames(conn: LocalConnection, n: number): string[] {
  return conn.game.state.zones.p1.library
    .slice(0, n)
    .map((iid) => frontFace(conn.game.state.cards[iid].oracleId).name);
}

function castBrainstorm(): void {
  const view = st().views.p1!;
  const action = view.legalActions.find(
    (a) =>
      a.intent.t === 'castSpell' &&
      view.cards[a.intent.iid]?.oracleId === oracleByName('Brainstorm').oracleId,
  );
  if (!action) throw new Error('Brainstorm is not castable');
  st().send(action.intent, 'p1');
  for (let i = 0; i < 20 && !st().views.p1!.choice; i++) {
    const p = st().views.p1!.priorityPlayer;
    if (!p) break;
    st().send({ t: 'passPriority' }, p);
  }
}

describe('the top-of-library panel', () => {
  beforeEach(() => {
    useStore.getState().detach();
  });

  it('remembers the names of the cards a Brainstorm put back', () => {
    attach();
    castBrainstorm();

    const choice = st().views.p1!.choice;
    if (choice?.kind !== 'chooseCards') throw new Error(`expected chooseCards, got ${choice?.kind}`);
    // Two of the three just drawn, in the order they will sit in.
    const picked: IID[] = choice.options.slice(0, 2).map((o) => o.iid);
    st().respond({ kind: 'cards', iids: picked }, 'p1');

    /*
     * Every entry has a name. That is the whole fix: they were all recorded
     * nameless, so the panel read as a list of "a card" no matter what you had
     * just looked at. How many survive is up to the draw step that follows.
     */
    expect(st().knownTop.p1.length).toBeGreaterThan(0);
    expect(panelNames()).not.toContain('(a card)');
    expect(st().knownTop.p1.every((e) => e.oracleId !== '')).toBe(true);
  });

  it('says the same thing the library does, top card first', () => {
    const conn = attach();
    castBrainstorm();
    const choice = st().views.p1!.choice;
    if (choice?.kind !== 'chooseCards') throw new Error('expected chooseCards');
    st().respond({ kind: 'cards', iids: choice.options.slice(0, 2).map((o) => o.iid) }, 'p1');

    const known = st().knownTop.p1.length;
    expect(known).toBeGreaterThan(0);
    expect(panelNames()).toEqual(libraryNames(conn, known));
  });

});
