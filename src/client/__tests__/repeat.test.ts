import { describe, expect, it } from 'vitest';
import { redact } from '@engine/redact';
import { testGame } from '@engine/__tests__/harness';
import {
  describePattern,
  detectPattern,
  matchAction,
  stepForIntent,
  type RepeatStep,
} from '../repeat';

/**
 * The repeat detector only ever offers to redo what the player has plainly
 * already been doing, so the interesting cases are the ones where it must stay
 * quiet.
 */

const step = (sig: string): RepeatStep => ({ what: 'act', sig, label: sig, atStack: 0 });
const steps = (...sigs: string[]) => sigs.map(step);

describe('spotting a repeated process', () => {
  it('says nothing until an action has happened three times', () => {
    expect(detectPattern(steps('a'))).toBeNull();
    expect(detectPattern(steps('a', 'a'))).toBeNull();
    expect(detectPattern(steps('a', 'a', 'a'))).toMatchObject({ times: 3 });
  });

  it('counts only the run at the end, not every occurrence', () => {
    // The 'a' at the front is history, not part of the current rhythm.
    const found = detectPattern(steps('a', 'b', 'c', 'c', 'c'));
    expect(found?.steps.map((s) => s.sig)).toEqual(['c']);
    expect(found?.times).toBe(3);
  });

  it('finds a two-step process after two rounds', () => {
    const found = detectPattern(steps('tap', 'cast', 'tap', 'cast'));
    expect(found?.steps.map((s) => s.sig)).toEqual(['tap', 'cast']);
    expect(found?.times).toBe(2);
  });

  it('prefers the shortest pattern that explains the run', () => {
    // 'a a a a' is one action four times, not a two-action loop twice.
    const found = detectPattern(steps('a', 'a', 'a', 'a'));
    expect(found?.steps).toHaveLength(1);
    expect(found?.times).toBe(4);
  });

  it('stays quiet on a sequence that is not repeating', () => {
    expect(detectPattern(steps('a', 'b', 'c', 'd'))).toBeNull();
    expect(detectPattern(steps('a', 'b', 'a', 'c'))).toBeNull();
  });

  it('ignores a run that has already been broken', () => {
    expect(detectPattern(steps('a', 'a', 'a', 'b'))).toBeNull();
  });

  it('finds a loop long enough to hold a whole combo iteration', () => {
    // Cast, choose the mode, choose what to bounce, choose what to ping: the
    // shape this feature exists for, and it must be seen after two rounds.
    const loop = ['cast', 'mode', 'bounce', 'ping'];
    const found = detectPattern(steps(...loop, ...loop));
    expect(found?.steps.map((s) => s.sig)).toEqual(loop);
    expect(found?.times).toBe(2);
  });

  it('gives up on a stretch longer than it will search', () => {
    const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    expect(detectPattern(steps(...nine, ...nine))).toBeNull();
  });

  it('names the pattern in a way a player can check', () => {
    expect(describePattern([step('x')].map((s) => ({ ...s, label: 'Tap Island for {U}' })))).toBe(
      'Tap Island for {U}',
    );
    expect(
      describePattern([
        { ...step('x'), label: 'Tap Island' },
        { ...step('y'), label: 'Cast Brainstorm' },
      ]),
    ).toBe('Tap Island, then Cast Brainstorm');
  });
});

describe('signatures', () => {
  it('treats two copies of the same land as the same action', () => {
    const t = testGame();
    const lands = t.p1.battlefield('Watery Grave', 'Watery Grave');
    t.begin();
    const view = redact(t.state, 'p1');
    const a = stepForIntent({ t: 'tapForMana', iid: lands[0], kind: 'U' }, view);
    const b = stepForIntent({ t: 'tapForMana', iid: lands[1], kind: 'U' }, view);
    expect(a?.sig).toBe(b?.sig);
    // Different cards are different actions, and so are different mana.
    const island = t.p1.battlefield('Island')[0];
    const v2 = redact(t.state, 'p1');
    expect(stepForIntent({ t: 'tapForMana', iid: island, kind: 'U' }, v2)?.sig).not.toBe(a?.sig);
    expect(stepForIntent({ t: 'tapForMana', iid: lands[0], kind: 'B' }, v2)?.sig).not.toBe(a?.sig);
  });

  it('never offers to repeat passing priority', () => {
    const t = testGame();
    t.p1.battlefield('Island');
    t.begin();
    const view = redact(t.state, 'p1');
    expect(stepForIntent({ t: 'passPriority' }, view)).toBeNull();
    expect(stepForIntent({ t: 'concede' }, view)).toBeNull();
  });

  it('resolves a step against whichever copy is still untapped', () => {
    const t = testGame();
    const lands = t.p1.battlefield('Watery Grave', 'Watery Grave');
    t.begin();
    const sig = stepForIntent({ t: 'tapForMana', iid: lands[0], kind: 'U' }, redact(t.state, 'p1'))!;
    t.game.submitIntent('p1', { t: 'tapForMana', iid: lands[0], kind: 'U' });
    const view = redact(t.state, 'p1');
    // The first one is tapped now, so the step has to land on the second.
    expect(matchAction(view, sig)?.intent).toMatchObject({ t: 'tapForMana', iid: lands[1] });
  });

  it('reports that a step is impossible once nothing can do it', () => {
    const t = testGame();
    const land = t.p1.battlefield('Island')[0];
    t.begin();
    const sig = stepForIntent({ t: 'tapForMana', iid: land, kind: 'U' }, redact(t.state, 'p1'))!;
    t.game.submitIntent('p1', { t: 'tapForMana', iid: land, kind: 'U' });
    expect(matchAction(redact(t.state, 'p1'), sig)).toBeNull();
  });
});
