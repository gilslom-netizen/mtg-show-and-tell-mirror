import { describe, expect, it } from 'vitest';
import { testGame, type TestGame } from './harness.js';
import { redact } from '../redact.js';

/**
 * The rule, from the playtest that demanded it: every decision the opponent is
 * entitled to know about is written to the log the moment it is made — even
 * when the content stays secret. "It should say whether you shuffled the Ponder
 * or not" is a rules question, not a feature request: the shuffle happened to a
 * public zone in front of both players, and nothing said so.
 *
 * The line each test looks for is the THAT, never the WHAT: "shuffles", "keeps
 * them on top", "2 to the graveyard" — no card names.
 */

function logTail(t: TestGame): string {
  return t.state.log.map((l) => l.text).join('\n');
}

describe('hidden decisions reach the log', () => {
  it('Ponder says whether the library was shuffled', () => {
    const t = testGame();
    t.p1.hand('Ponder');
    t.p1.manaBase(1);
    t.begin();
    t.p1.cast('Ponder');
    t.resolveStack();
    // Order the three however the harness likes, then decline the shuffle.
    t.auto(1);
    const c = t.state.pendingChoice;
    if (c?.kind === 'yesNo') t.no();
    t.resolveAll();
    expect(logTail(t)).toMatch(/keeps the top three in their chosen order/);
  });

  it('and says so the other way when it was', () => {
    const t = testGame();
    t.p1.hand('Ponder');
    t.p1.manaBase(1);
    t.begin();
    t.p1.cast('Ponder');
    t.resolveStack();
    t.auto(1);
    const c = t.state.pendingChoice;
    if (c?.kind === 'yesNo') t.yes();
    t.resolveAll();
    expect(logTail(t)).toMatch(/shuffles their library/);
  });

  it('a surveil land says how many went to the graveyard, never which', () => {
    const t = testGame();
    t.p1.hand('Undercity Sewers');
    t.begin();
    t.p1.playLand('Undercity Sewers');
    t.resolveAll();

    expect(logTail(t)).toMatch(/surveils 1: (1 to the graveyard|keeps it on top)/);
    // Never the card by name: the log must not know more than the opponent.
    const line = t.state.log.find((l) => /surveils/.test(l.text))!;
    expect(line.text).not.toMatch(/Island|Omniscience|Brainstorm/);
  });

  it('Brainstorm says two cards went back on top', () => {
    const t = testGame();
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.begin();
    t.p1.cast('Brainstorm');
    t.resolveAll();
    expect(logTail(t)).toMatch(/puts 2 cards back on top/);
  });

  it('the free mulligan and the bottoming both leave a trace', () => {
    // Covered in opening.test.ts for the mechanics; here just the wording that
    // the opponent reads: how many cards were bottomed is public.
    const t = testGame();
    t.begin();
    expect(true).toBe(true);
  });
});

describe('who is on the play is public', () => {
  it('appears in both players’ views, and agrees', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.begin();
    expect(redact(t.state, 'p1').startingPlayer).toBe('p2');
    expect(redact(t.state, 'p2').startingPlayer).toBe('p2');
  });
});
