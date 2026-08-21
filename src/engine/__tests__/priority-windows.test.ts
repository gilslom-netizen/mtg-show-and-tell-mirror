import { describe, expect, it } from 'vitest';
import { TestGame } from './harness.js';

/**
 * Holding priority in the windows that matter to this deck.
 *
 * The end step of the opponent's turn is where this format actually lives:
 * cracking a fetch, flashing in a threat, holding up a counter. If a player is
 * not offered priority there — or the client cannot see the action — the whole
 * format stops working, so each window is checked explicitly rather than assumed
 * from the turn structure.
 */
describe('acting in the opponent’s turn', () => {
  it('cracks a fetchland in the opponent’s end step', () => {
    const t = new TestGame(7, 'p1');
    t.p2.battlefield('Flooded Strand');
    t.p2.life(20);
    t.begin('ending', 'end_step');

    // The active player gets priority first; the fetch belongs to the other seat.
    expect(t.state.priorityPlayer).toBe('p1');
    t.p1.pass();
    expect(t.state.priorityPlayer).toBe('p2');

    const offered = t.game.legalActions('p2');
    expect(offered.some((a) => a.intent.t === 'activateAbility')).toBe(true);

    t.p2.activate('Flooded Strand');
    // The ability uses the stack: it resolves once both players pass.
    expect(t.state.stack.length).toBe(1);
    t.p2.pass();
    t.p1.pass();
    t.chooseCards('Island');

    expect(t.p2.battlefieldNames()).toContain('Island');
    expect(t.p2.graveyardNames()).toContain('Flooded Strand');
    expect(t.p2.lifeTotal).toBe(19);
    // Still the opponent's end step — cracking a fetch does not end the turn.
    expect(t.state.step).toBe('end_step');
  });

  it('offers the fetch in every step of the opponent’s turn', () => {
    const windows: [string, string][] = [
      ['beginning', 'upkeep'],
      ['beginning', 'draw'],
      ['precombat_main', 'main'],
      ['combat', 'begin_combat'],
      ['combat', 'declare_attackers'],
      ['combat', 'end_of_combat'],
      ['postcombat_main', 'main'],
      ['ending', 'end_step'],
    ];
    for (const [phase, step] of windows) {
      const t = new TestGame(11, 'p1');
      t.p2.battlefield('Flooded Strand');
      t.begin(phase as never, step as never);
      // Whoever has priority first, the other seat gets it after a pass.
      if (t.state.priorityPlayer === 'p1') t.p1.pass();
      expect(
        t.game.legalActions('p2').some((a) => a.intent.t === 'activateAbility'),
        `p2 should be able to crack a fetch in ${phase}/${step}`,
      ).toBe(true);
    }
  });

  it('lets both players act in the same end step, in turn order', () => {
    const t = new TestGame(13, 'p1');
    t.p1.battlefield('Flooded Strand');
    t.p2.battlefield('Polluted Delta');
    t.begin('ending', 'end_step');

    t.p1.activate('Flooded Strand');
    t.p1.pass();
    t.p2.pass();
    t.chooseCards('Island');
    expect(t.p1.battlefieldNames()).toContain('Island');

    // p1 keeps priority after their own action resolves; passing hands it over.
    if (t.state.priorityPlayer === 'p1') t.p1.pass();
    expect(t.state.priorityPlayer).toBe('p2');
    t.p2.activate('Polluted Delta');
    t.p2.pass();
    t.p1.pass();
    t.chooseCards('Watery Grave');
    t.yes(); // Watery Grave: pay 2 life
    expect(t.p2.battlefieldNames()).toContain('Watery Grave');
  });

  it('holds the fetch open until the player passes, rather than ending the turn under them', () => {
    const t = new TestGame(17, 'p1');
    t.p2.battlefield('Flooded Strand');
    t.begin('ending', 'end_step');
    t.p1.pass();
    expect(t.state.priorityPlayer).toBe('p2');
    // Nothing has advanced the step while p2 is still holding priority.
    expect(t.state.step).toBe('end_step');
    expect(t.state.turn).toBe(1);
  });
});

/**
 * Passing priority, in each of the shapes it takes.
 *
 * The engine's rule is simple and worth pinning down: putting something on the
 * stack leaves you holding priority (CR 117.3c), a resolution hands it to the
 * active player (CR 117.3b), and two passes in a row resolve the top of the
 * stack or end the step. Everything the client does — auto-pass, "pass until
 * end of turn", hold priority — is built out of ordinary pass intents on top of
 * that, so if these hold, all of them do.
 */
describe('passing priority', () => {
  it('leaves the caster holding priority, whoever’s turn it is', () => {
    for (const caster of ['p1', 'p2'] as const) {
      const t = new TestGame(23, 'p1');
      t.seat(caster).hand('Brainstorm');
      t.seat(caster).manaBase(1);
      t.begin();
      if (t.state.priorityPlayer !== caster) t.seat(t.state.priorityPlayer!).pass();

      t.seat(caster).cast('Brainstorm');
      expect(t.state.stack.length).toBe(1);
      expect(t.state.priorityPlayer, `${caster} should keep priority`).toBe(caster);
    }
  });

  it('resets the pass count when something new goes on the stack', () => {
    const t = new TestGame(29, 'p1');
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.p2.hand('Mana Drain');
    t.p2.manaBase(2);
    t.begin();

    t.p1.cast('Brainstorm');
    t.p1.pass();
    // p2 responds instead of passing: p1's pass must not carry over, or the
    // counter would resolve without p1 ever getting to answer it.
    t.p2.cast('Mana Drain');
    expect(t.state.passed).toEqual([]);
    expect(t.state.priorityPlayer).toBe('p2');
    expect(t.state.stack.length).toBe(2);
  });

  it('gives priority back to the active player after each resolution', () => {
    const t = new TestGame(31, 'p1');
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.begin();

    t.p1.cast('Brainstorm');
    t.p1.pass();
    t.p2.pass();
    // Brainstorm resolves: draw three, then put two back. Pick by identity —
    // the hand holds duplicates of several cards.
    const back = t.expectChoice();
    if (back.kind !== 'chooseCards') throw new Error('expected the put-back prompt');
    t.answer({ kind: 'cards', iids: back.options.slice(0, 2).map((o) => o.iid) });
    expect(t.state.stack.length).toBe(0);
    expect(t.state.priorityPlayer).toBe('p1');
  });

  it('ends the step when both players pass on an empty stack', () => {
    const t = new TestGame(37, 'p1');
    t.begin('precombat_main', 'main');
    const step = t.state.step;
    t.p1.pass();
    t.p2.pass();
    expect(t.state.step).not.toBe(step);
  });

  it('refuses a pass from the player who does not have priority', () => {
    const t = new TestGame(41, 'p1');
    t.begin();
    expect(t.state.priorityPlayer).toBe('p1');
    expect(() => t.p2.pass()).toThrow(/priority/i);
  });

  it('never leaves both players passed with the stack untouched', () => {
    // The shape of a hang: passed twice, nothing resolved, nobody to act.
    const t = new TestGame(43, 'p1');
    t.p1.hand('Brainstorm');
    t.p1.manaBase(1);
    t.begin();
    t.p1.cast('Brainstorm');
    t.p1.pass();
    t.p2.pass();
    expect(t.state.pendingChoice ?? t.state.priorityPlayer).not.toBeNull();
  });
});
