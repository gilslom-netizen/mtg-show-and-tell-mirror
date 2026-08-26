import { describe, expect, it } from 'vitest';
import type { PlayerView } from '@engine/redact';
import type { ScenarioSpec } from '@engine/scenario';
import { SCENARIOS } from '@engine/scenario';
import { HeuristicAgent } from '../../ai/heuristic';
import { LocalConnection } from '../connection';
import { seatHasSomethingToDo } from '../hooks';

/**
 * The lobby's best of 1 / 3 / 5 choice, on the solo path.
 *
 * The choice used to reach only the online rooms: a local game built its own
 * tracker with the default length, so picking best of five and pressing Lab or
 * Goldfish quietly gave you a best of three. These tests pin the length to the
 * thing that actually runs a series.
 */

function local(bestOf?: number, scenario?: ScenarioSpec) {
  return new LocalConnection({
    seed: 11,
    startingPlayer: 'p1',
    seats: ['p1', 'p2'],
    bestOf,
    scenario,
  });
}

/** Concede as `loser`, then take the play-or-draw decision if one is offered. */
function loseGame(conn: LocalConnection, loser: 'p1' | 'p2'): void {
  conn.submitIntent(loser, { t: 'concede' });
  const m = conn.match();
  if (m?.awaitingFirstChoiceFrom) conn.chooseFirst(m.awaitingFirstChoiceFrom, 'p1');
}

describe('the series length a solo game runs at', () => {
  it.each([1, 3, 5])('carries best of %i through to the match state', (n) => {
    expect(local(n).match()?.bestOf).toBe(n);
  });

  it('falls back to a best of three when nothing was chosen', () => {
    expect(local().match()?.bestOf).toBe(3);
    expect(local(4).match()?.bestOf).toBe(3);
  });

  it('ends a best of one after a single game', () => {
    const conn = local(1);
    loseGame(conn, 'p2');

    const m = conn.match()!;
    expect(m.matchWinner).toBe('p1');
    expect(m.gameNumber).toBe(1);
    // Nobody is asked to choose play or draw, because there is no game two.
    expect(m.awaitingFirstChoiceFrom).toBeNull();
  });

  it('runs a best of five out to three wins, dealing a fresh game each time', () => {
    const conn = local(5);
    const seen = new Set<string>();

    for (const loser of ['p2', 'p1', 'p2', 'p1', 'p2'] as const) {
      seen.add(conn.game.state.gameId);
      loseGame(conn, loser);
    }

    const m = conn.match()!;
    expect(m.wins).toEqual({ p1: 3, p2: 2 });
    expect(m.matchWinner).toBe('p1');
    expect(m.history).toHaveLength(5);
    // Every game in the series is its own deal, not the same one replayed.
    expect(seen.size).toBe(5);
  });

  it('stops dealing games once a best of three is decided', () => {
    const conn = local(3);
    loseGame(conn, 'p2');
    loseGame(conn, 'p2');

    const m = conn.match()!;
    expect(m.matchWinner).toBe('p1');
    expect(m.gameNumber).toBe(2);
    // A finished series has no next game to hand out.
    conn.chooseFirst('p2', 'p2');
    expect(conn.match()!.gameNumber).toBe(2);
  });

  it('leaves a drill alone — one staged position is not a series', () => {
    const conn = local(5, SCENARIOS.bowmastersLoop);
    expect(conn.match()).toBeNull();
  });
});

/**
 * Between games the loser picks play or draw. Solo, the loser can be the seat you
 * are not looking at — so this client has to be able to answer for it, or a best
 * of three against a goldfish stops after game one waiting for nobody.
 */
describe('the play-or-draw decision, solo', () => {
  it('lets this client answer for whichever seat lost', () => {
    const conn = local(3);
    conn.submitIntent('p1', { t: 'concede' });

    const awaiting = conn.match()!.awaitingFirstChoiceFrom;
    expect(awaiting).toBe('p1');
    // Both seats belong to this client, so the choice is always answerable here.
    expect(conn.seats()).toEqual(['p1', 'p2']);
    expect(conn.seats()).toContain(awaiting!);

    conn.chooseFirst(awaiting!, 'p2');
    expect(conn.match()!.gameNumber).toBe(2);
    expect(conn.match()!.onPlay).toBe('p2');
    expect(conn.match()!.awaitingFirstChoiceFrom).toBeNull();
  });
});

/**
 * Against the computer you hold one seat, so the play-or-draw decision after a game
 * the computer lost is not yours to make and no screen will ever offer it. The
 * opponent has to answer it itself, or a best of three stops after game one.
 */
describe('a series against the computer', () => {
  const ai = (bestOf: number) =>
    new LocalConnection({
      seed: 11,
      startingPlayer: 'p1',
      seats: ['p1'],
      opponent: new HeuristicAgent(),
      bestOf,
    });

  it('runs at the length the lobby chose', () => {
    expect(ai(5).match()?.bestOf).toBe(5);
    expect(ai(1).match()?.bestOf).toBe(1);
  });

  it('answers play or draw for itself when it is the one who lost', async () => {
    const conn = ai(3);
    // The computer's seat concedes, so the decision belongs to a seat with no screen.
    conn.submitIntent('p2', { t: 'concede' });
    expect(conn.match()!.awaitingFirstChoiceFrom).toBe('p2');

    // It waits a beat before answering, on purpose, so this waits with it.
    const deadline = Date.now() + 5000;
    while (conn.match()!.awaitingFirstChoiceFrom !== null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const m = conn.match()!;
    expect(m.awaitingFirstChoiceFrom).toBeNull();
    expect(m.gameNumber).toBe(2);
    expect(m.wins).toEqual({ p1: 1, p2: 0 });
    conn.dispose();
  }, 10_000);
});

/**
 * Lab mode follows whichever seat has to act. The opening hand is the case that
 * used to trap it: one shared question, held by both seats, which stays in the
 * view of a seat that has already answered.
 */
describe('following the seat that still has to act', () => {
  const view = (choice: unknown): PlayerView =>
    ({ choice, priorityPlayer: null, legalActions: [], winner: null }) as unknown as PlayerView;

  it('reads a kept hand as nothing left to do', () => {
    expect(seatHasSomethingToDo(view({ kind: 'mulligan', iHaveDecided: false }), 'p1')).toBe(true);
    expect(seatHasSomethingToDo(view({ kind: 'mulligan', iHaveDecided: true }), 'p1')).toBe(false);
  });

  it('reads a locked-in secret the same way', () => {
    const secret = (iHaveLockedIn: boolean) => ({ kind: 'simultaneousSecret', iHaveLockedIn });
    expect(seatHasSomethingToDo(view(secret(false)), 'p1')).toBe(true);
    expect(seatHasSomethingToDo(view(secret(true)), 'p1')).toBe(false);
  });

  it('still counts any other open question as something to do', () => {
    expect(seatHasSomethingToDo(view({ kind: 'chooseCards' }), 'p1')).toBe(true);
    expect(seatHasSomethingToDo(view(undefined), 'p1')).toBe(false);
  });
});
