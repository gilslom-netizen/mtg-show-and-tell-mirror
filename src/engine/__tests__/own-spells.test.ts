import { describe, expect, it } from 'vitest';
import { testGame, type TestGame } from './harness.js';
import { redact } from '../redact.js';
import { frontFace } from '../oracle.js';
import { getScript } from '../cards/index.js';
import { HeuristicAgent } from '../../ai/heuristic.js';
import type { TargetRef } from '../types.js';

/**
 * Countering your own spell.
 *
 * "Counter target spell" means target spell. Only one card in this pool says
 * "you don't control" — Hullbreaker Horror, which prints it — and every other
 * counter had the restriction anyway, written into the candidate list rather
 * than onto the card. So Mana Drain on your own seven-drop for the mana, Memory
 * Lapse putting your own card back on top, Reprieve saving something from a
 * worse fate than a bounce: none of it could be chosen at all.
 *
 * The one spell left out is the one doing the targeting. See the Pyroblast test
 * below for why that is not fussiness.
 */

/** My own spell on the stack, and priority still mine to answer it with. */
function myOwnSpellUp(counter: string): TestGame {
  const t = testGame({ startingPlayer: 'p1' });
  t.p1.hand('Show and Tell');
  t.p1.conjure(counter);
  t.p1.manaBase(5);
  t.begin();
  t.p1.cast('Show and Tell', { hold: true });
  return t;
}

const spellNames = (t: TestGame, cands: TargetRef[]) =>
  cands.map((c) => (c.kind === 'spell' ? t.state.cards[c.iid].oracleId : c.kind));

describe('a counterspell can be pointed at your own spell', () => {
  it.each([
    ['Mana Drain', 'mana_drain'],
    ['Memory Lapse', 'memory_lapse'],
    ['Mystical Dispute', 'mystical_dispute'],
    ['Reprieve', 'reprieve'],
    ['Pact of Negation', 'pact_of_negation'],
  ])('%s reaches it', (name) => {
    const t = myOwnSpellUp(name);
    expect(t.p1.canCast(name)).toBe(true);
    t.p1.cast(name);

    // One other spell on the stack, so it is taken without asking — and the
    // thing it took is mine.
    const target = t.state.cards[t.state.stack[t.state.stack.length - 1]].targets?.[0];
    expect(target?.kind).toBe('spell');
    if (target?.kind !== 'spell') return;
    expect(t.state.cards[target.iid].oracleId).toBe('show_and_tell');
    expect(t.state.cards[target.iid].controller).toBe('p1');
  });

  /**
   * Hullbreaker Horror is the one card here that actually prints the
   * restriction, so it keeps it.
   */
  it('but Hullbreaker Horror still cannot, because it says so', () => {
    const t = testGame({ startingPlayer: 'p1' });
    t.p1.hand('Brainstorm');
    t.p1.conjureOntoBattlefield('Hullbreaker Horror', 'Omniscience');
    t.begin();
    t.p1.cast('Brainstorm', { free: true, hold: true });

    // The Horror triggers on my cast; its spell mode has nothing to point at,
    // because the only spell up is mine.
    const choice = t.game.state.pendingChoice;
    if (choice?.kind === 'chooseMode') {
      const spellMode = choice.modes.find((m) => m.text.toLowerCase().includes('spell'));
      expect(spellMode?.enabled).toBe(false);
    }
  });
});

describe('a spell is not a target for itself', () => {
  /**
   * Legal in paper and worth nothing, and it costs a great deal to offer: with
   * itself in the list every single-target counter has two candidates instead of
   * one, so the game stops to ask a question it used to answer for you.
   */
  it('so one other spell on the stack is still taken without asking', () => {
    const t = myOwnSpellUp('Mana Drain');
    t.p1.cast('Mana Drain');
    expect(t.game.state.pendingChoice).toBeNull();
  });

  it('and two of them are a real question, listing both but not the Drain', () => {
    const t = testGame({ startingPlayer: 'p1' });
    // Two one-mana instants: cheap enough to leave mana for the Drain, and
    // castable with something already on the stack.
    t.p1.hand('Brainstorm', 'Brainstorm');
    t.p1.conjure('Mana Drain');
    t.p1.manaBase(5);
    t.begin();
    t.p1.cast('Brainstorm', { hold: true });
    t.p1.cast('Brainstorm', { hold: true });
    t.p1.cast('Mana Drain');

    const choice = t.expectChoice();
    if (choice.kind !== 'chooseTargets') throw new Error('expected a target choice');
    expect(spellNames(t, choice.candidates)).toEqual(['brainstorm', 'brainstorm']);
  });

  /**
   * The reason this matters beyond a stray prompt. Pyroblast is castable when
   * either mode works; with itself in its own candidate list the counter mode
   * always worked, so it was offered off an empty stack, pointed at itself, and
   * the cast rewound — the loop fixed once already.
   */
  it('so Pyroblast does not reach for the counter half off an empty stack', () => {
    const t = testGame({ startingPlayer: 'p1' });
    t.p1.conjure('Pyroblast');
    t.p1.conjureOntoBattlefield('Steam Vents');
    t.p2.conjureOntoBattlefield('Snapcaster Mage');
    t.begin();

    // Castable, because destroying a permanent is a real mode with a real
    // target. Countering is not: the stack is empty, and it is not on it itself.
    expect(t.p1.canCast('Pyroblast')).toBe(true);
    t.p1.cast('Pyroblast');
    const spell = t.state.cards[t.state.stack[t.state.stack.length - 1]];
    expect(spell.oracleId).toBe('pyroblast');
    expect(spell.chosenModes).toEqual([1]);
  });
});

describe('the computer never counters its own spell', () => {
  /**
   * The legality is for the person playing. Whoever resolves first wins this
   * matchup, so an agent that answers itself is not making a bad play, it is
   * losing on purpose — and its own spells are in the candidate list for the
   * first time.
   */
  it('passes rather than answering itself', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Show and Tell');
    t.p2.conjure('Mana Drain');
    t.p2.manaBase(5);
    t.begin();
    t.p2.cast('Show and Tell', { hold: true });

    const view = redact(t.state, 'p2');
    expect(view.legalActions.some((a) => a.label.includes('Mana Drain'))).toBe(true);
    expect(new HeuristicAgent().act(view).t).toBe('passPriority');
  });

  it('and picks theirs when forced to choose between mine and theirs', () => {
    const t = testGame({ startingPlayer: 'p1' });
    t.p1.hand('Show and Tell');
    t.p1.manaBase(3);
    t.p2.hand('Brainstorm');
    t.p2.conjure('Mana Drain');
    t.p2.manaBase(5);
    t.begin();
    t.p1.cast('Show and Tell');
    t.p1.pass();
    t.p2.cast('Brainstorm', { hold: true });
    t.p2.cast('Mana Drain');

    const choice = t.expectChoice();
    if (choice.kind !== 'chooseTargets') throw new Error('expected a target choice');
    // Both are on offer; the agent has to say no to its own.
    expect(spellNames(t, choice.candidates).sort()).toEqual(['brainstorm', 'show_and_tell']);

    const view = redact(t.state, 'p2');
    const response = new HeuristicAgent().respond(view, view.choice!);
    if (response.kind !== 'targets') throw new Error('expected targets');
    const picked = response.targets[0];
    expect(picked.kind).toBe('spell');
    if (picked.kind !== 'spell') return;
    expect(t.state.cards[picked.iid].controller).toBe('p1');
  });
});

describe('what the card says is what it asks for', () => {
  /**
   * Miscast asked its opponent to pay {1}. The card next to the prompt reads
   * {3}, and a playtester noticed the difference — a Spell Pierce tax on a card
   * chosen for being much harder to pay through.
   *
   * The tax is written on the card, so the card is where the number comes from.
   * This reads it back out of the oracle text and checks the prompt against it,
   * which is the only version of this test that cannot drift the same way.
   */
  it.each([
    ['Spell Pierce', 'spell_pierce'],
    ['Miscast', 'miscast'],
    ['Mystical Dispute', 'mystical_dispute'],
    ['Flusterstorm', 'flusterstorm'],
  ])('%s taxes the amount printed on it', (_name, oracleId) => {
    const printed = frontFace(oracleId).oracleText.match(/pays \{(\d+)\}/);
    if (!printed) throw new Error(`${oracleId} does not print a tax`);
    const script = getScript(oracleId);
    if (!script?.targets) throw new Error(`${oracleId} has no targets`);
    const prompt = script.targets[0].prompt;
    const asked = prompt.match(/pays \{(\d+)\}/);
    expect(asked?.[1]).toBe(printed[1]);
  });
});

describe("Narset's Reversal", () => {
  /**
   * "There is a rule that no card on the stack can target itself" — and the
   * reason it matters here: copy it, hand the original back to your hand, cast
   * it again, for ever. The counterspells in this file already refuse; this was
   * the one card with its own candidate list, and it did not.
   */
  it('cannot copy itself', () => {
    const t = testGame({ startingPlayer: 'p1' });
    t.p1.hand('Brainstorm');
    t.p1.conjure("Narset's Reversal");
    t.p1.manaBase(5);
    t.begin();
    t.p1.cast('Brainstorm', { hold: true });
    t.p1.cast("Narset's Reversal");

    const onStack = t.state.stack.map((iid) => t.state.cards[iid].oracleId);
    expect(onStack).toContain('narsets_reversal');
    const reversal = t.state.stack.find(
      (iid) => t.state.cards[iid].oracleId === 'narsets_reversal',
    )!;
    // One other spell up, so it is taken without asking — and it is the other one.
    const chosen = t.state.cards[reversal].targets?.[0];
    expect(chosen?.kind).toBe('spell');
    if (chosen?.kind !== 'spell') return;
    expect(chosen.iid).not.toBe(reversal);
    expect(t.state.cards[chosen.iid].oracleId).toBe('brainstorm');
  });
});

describe('how many times a tax is asked', () => {
  /**
   * "He asked me if I want to pay 1... maybe check whether he does it three
   * times or once." Once per counterspell — and a storm copy is its own
   * counterspell, so a Flusterstorm that copied itself asks once per copy.
   * That is the answer to the question, and it is worth holding still.
   */
  it('once for one counterspell', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Brainstorm');
    t.p2.manaBase(6); // enough left over to actually be able to pay
    t.p1.conjure('Miscast');
    t.p1.manaBase(3);
    t.begin();
    t.p2.cast('Brainstorm');
    t.p2.pass();
    t.p1.cast('Miscast');

    let asked = 0;
    for (let i = 0; i < 14; i++) {
      const c = t.game.state.pendingChoice;
      if (c?.kind === 'yesNo') {
        expect(c.prompt).toMatch(/\{3\}/); // the amount the card prints
        asked++;
        t.no();
        continue;
      }
      if (c?.kind === 'chooseCards') {
        t.chooseNoCards();
        continue;
      }
      if (c) break;
      if (t.state.stack.length === 0) break;
      const p = t.state.priorityPlayer;
      if (!p) break;
      t.game.submitIntent(p, { t: 'passPriority' });
    }
    expect(asked).toBe(1);
    expect(t.wasCountered('Brainstorm')).toBe(true);
  });

  it('once per copy when the counterspell storms', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Brainstorm', 'Ponder');
    t.p2.manaBase(8);
    t.p1.conjure('Flusterstorm');
    t.p1.manaBase(4);
    t.begin();
    t.p2.cast('Ponder'); // one spell before it, so storm makes one copy
    t.p2.pass();
    t.p1.cast('Flusterstorm');

    let asked = 0;
    for (let i = 0; i < 25; i++) {
      const c = t.game.state.pendingChoice;
      if (c?.kind === 'yesNo') {
        asked++;
        t.no();
        continue;
      }
      if (c?.kind === 'chooseTargets') {
        t.answer({ kind: 'targets', targets: c.candidates.slice(0, 1) });
        continue;
      }
      if (c?.kind === 'chooseCards') {
        t.chooseNoCards();
        continue;
      }
      if (c) break;
      if (t.state.stack.length === 0) break;
      const p = t.state.priorityPlayer;
      if (!p) break;
      t.game.submitIntent(p, { t: 'passPriority' });
    }
    // The original and its one copy, each a spell that taxes on its own.
    expect(asked).toBe(2);
  });
});

describe("Narset's Reversal, the part that already worked", () => {
  /**
   * "He asked me whether I want to choose separate targets or keep, and I
   * clicked keep." "That is the sort of thing it's important works." It did, and
   * it still does after the self-target fix — so it is written down.
   */
  function reversalOverADecay() {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.conjure('Abrupt Decay');
    t.p2.manaBase(3);
    t.p2.conjureOntoBattlefield('Snapcaster Mage');
    t.p1.conjure("Narset's Reversal");
    t.p1.conjureOntoBattlefield('Psychic Frog');
    t.p1.manaBase(4);
    t.begin();

    t.p2.cast('Abrupt Decay');
    const targets = t.expectChoice();
    if (targets.kind !== 'chooseTargets') throw new Error('expected targets');
    const frog = targets.candidates.find(
      (c) => c.kind === 'permanent' && t.state.cards[c.iid].oracleId === 'psychic_frog',
    );
    t.answer({ kind: 'targets', targets: [frog!] });
    t.p2.pass();
    t.p1.cast("Narset's Reversal");
    return t;
  }

  it('keeps the original targets when you decline', () => {
    const t = reversalOverADecay();
    t.resolveAll();
    // The copy resolved with the target it was copied from: my own Frog dies.
    expect(t.p1.battlefieldNames()).not.toContain('Psychic Frog');
    expect(t.p2.battlefieldNames()).toContain('Snapcaster Mage');
    // And the original goes back to its owner's hand rather than the graveyard.
    expect(t.p2.handNames()).toContain('Abrupt Decay');
  });

  it('moves the copy onto a new target when you take the offer', () => {
    const t = reversalOverADecay();
    for (let i = 0; i < 20; i++) {
      const c = t.game.state.pendingChoice;
      if (!c) {
        // The offer only comes when the Reversal resolves, which is several
        // passes away — stopping at the first quiet moment answers nothing.
        if (t.state.stack.length === 0) break;
        const p = t.state.priorityPlayer;
        if (!p) break;
        t.game.submitIntent(p, { t: 'passPriority' });
        continue;
      }
      if (c.kind === 'yesNo') {
        expect(c.prompt).toMatch(/new targets/i);
        t.yes();
        continue;
      }
      if (c.kind === 'chooseTargets') {
        const snap = c.candidates.find(
          (x) => x.kind === 'permanent' && t.state.cards[x.iid].oracleId === 'snapcaster_mage',
        );
        expect(snap).toBeDefined();
        t.answer({ kind: 'targets', targets: [snap ?? c.candidates[0]] });
        continue;
      }
      break;
    }
    // Re-aimed: their creature dies instead of mine.
    expect(t.p2.battlefieldNames()).not.toContain('Snapcaster Mage');
    expect(t.p1.battlefieldNames()).toContain('Psychic Frog');
    expect(t.p2.handNames()).toContain('Abrupt Decay');
  });
});
