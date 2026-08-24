import { describe, expect, it } from 'vitest';
import { testGame, type TestGame } from '../../engine/__tests__/harness.js';
import { redact, type ChoiceView } from '../../engine/redact.js';
import type { Intent } from '../../engine/game.js';
import type { PlayerId } from '../../engine/types.js';
import type { Agent } from '../agent.js';
import { HeuristicAgent } from '../heuristic.js';
import { RandomAgent } from '../random.js';
import { runPairRange } from '../series.js';
import { summarise } from '../elo.js';
import { playGame } from '../arena.js';

/**
 * What the heuristic does, in positions where there is a right answer.
 *
 * These are the behaviour tests DESIGN-AI.md 5.3 asks for, and they exist because Elo
 * cannot see them. An agent that stops picking Omniscience for Show and Tell, or that
 * starts pointing Orcish Bowmasters at its own face, loses a percentage point in the
 * arena and a whole point of sense here — and the arena takes ninety seconds to say
 * so where this takes ten milliseconds.
 */

// Typed as the interface, so what the tests exercise is the call an arena makes.
const agent: Agent = new HeuristicAgent();

/** What the heuristic would do with priority, in this position, as this seat. */
function act(t: TestGame, seat: PlayerId): Intent {
  return agent.act(redact(t.state, seat), 50);
}

/** The name of the card an intent is about, for readable assertions. */
function cardOf(t: TestGame, intent: Intent): string | null {
  if (intent.t !== 'castSpell' && intent.t !== 'playLand' && intent.t !== 'activateAbility') {
    return null;
  }
  return t.state.cards[intent.iid]?.oracleId ?? null;
}

function choiceFor(t: TestGame, seat: PlayerId): ChoiceView {
  const view = redact(t.state, seat);
  if (!view.choice) throw new Error(`No choice is open for ${seat}`);
  return view.choice;
}

function answer(t: TestGame, seat: PlayerId): void {
  const view = redact(t.state, seat);
  if (!view.choice) throw new Error(`No choice is open for ${seat}`);
  t.game.submitChoice(seat, view.choice.id, agent.respond(view, view.choice, 50));
}

/** Pass until the named seat holds priority, without letting the stack resolve. */
function priorityTo(t: TestGame, seat: PlayerId): void {
  for (let guard = 0; guard < 3 && t.state.priorityPlayer !== seat; guard++) {
    const holder = t.state.priorityPlayer;
    if (!holder) break;
    t.seat(holder).pass();
  }
  expect(t.state.priorityPlayer).toBe(seat);
}

/**
 * Run everything out with the heuristic answering whatever comes up — the same
 * alternation of answering and passing the arena driver does.
 *
 * "Until the stack is empty" would stop too early: a trigger that has fired but not
 * yet been put on the stack lives in `pendingTriggers`, and while it is choosing its
 * targets the stack really is empty. That is exactly the window the Bowmasters ping
 * is asked for.
 */
function runStackWithAgent(t: TestGame): void {
  for (let guard = 0; guard < 80; guard++) {
    const pending = t.state.pendingChoice;
    if (pending) {
      const seat =
        pending.kind === 'mulligan' || pending.kind === 'simultaneousSecret'
          ? pending.awaiting[0]
          : pending.player;
      answer(t, seat);
      continue;
    }
    if (t.state.stack.length === 0 && t.state.pendingTriggers.length === 0) return;
    const holder = t.state.priorityPlayer;
    if (!holder) {
      t.game.advance();
      continue;
    }
    t.seat(holder).pass();
  }
  throw new Error('the stack never settled');
}

describe('the plan', () => {
  it('casts Show and Tell over everything else it could be doing', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Omniscience', 'Brainstorm', 'Demonic Tutor');
    t.p1.manaBase(4);
    t.begin();

    expect(cardOf(t, act(t, 'p1'))).toBe('show_and_tell');
  });

  it('does not cast Show and Tell with nothing worth showing', () => {
    const t = testGame();
    // No permanent in hand, so the card is a Time Walk for the opponent.
    t.p1.hand('Show and Tell', 'Brainstorm', 'Mana Drain');
    t.p1.manaBase(4);
    t.begin();

    expect(cardOf(t, act(t, 'p1'))).not.toBe('show_and_tell');
  });

  it('shows Omniscience when there is a hand to spend it on', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Omniscience', 'Atraxa, Grand Unifier', 'Brainstorm');
    t.p1.manaBase(3);
    t.p2.hand('Atraxa, Grand Unifier');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();

    const choice = choiceFor(t, 'p1');
    expect(choice.kind).toBe('simultaneousSecret');
    const response = agent.respond(redact(t.state, 'p1'), choice, 50);
    expect(response.kind).toBe('secret');
    if (response.kind === 'secret' && response.iid !== null) {
      expect(t.state.cards[response.iid].oracleId).toBe('omniscience');
    }
  });

  it('shows Atraxa instead when the hand behind Omniscience is empty', () => {
    const t = testGame();
    // Show and Tell is on the stack, so the hand behind the pick is just the two
    // permanents: an Omniscience here would enchant an empty hand.
    t.p1.hand('Show and Tell', 'Omniscience', 'Atraxa, Grand Unifier');
    t.p1.manaBase(3);
    t.p2.hand('Brainstorm');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();

    const view = redact(t.state, 'p1');
    const response = agent.respond(view, view.choice!, 50);
    expect(response.kind).toBe('secret');
    if (response.kind === 'secret' && response.iid !== null) {
      expect(t.state.cards[response.iid].oracleId).toBe('atraxa_grand_unifier');
    }
  });

  it('takes the land drop before it spends the mana', () => {
    const t = testGame();
    t.p1.hand('Island', 'Brainstorm');
    t.p1.manaBase(2);
    t.begin();

    const intent = act(t, 'p1');
    expect(intent.t).toBe('playLand');
  });
});

describe('answering the opponent', () => {
  it('spends Mana Drain on Omniscience', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Omniscience');
    t.p2.manaBase(10);
    t.p1.hand('Mana Drain');
    t.p1.manaBase(2);
    t.begin();

    t.p2.cast('Omniscience');
    priorityTo(t, 'p1');
    expect(cardOf(t, act(t, 'p1'))).toBe('mana_drain');
  });

  it('does not spend Mana Drain on a Brainstorm', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p2.hand('Brainstorm');
    t.p2.manaBase(1);
    t.p1.hand('Mana Drain');
    t.p1.manaBase(2);
    t.begin();

    t.p2.cast('Brainstorm');
    priorityTo(t, 'p1');
    expect(cardOf(t, act(t, 'p1'))).not.toBe('mana_drain');
  });

  /**
   * The line the deck is built on: Veil of Summer resolves first, and their counter
   * resolves into a spell that can no longer be countered.
   */
  it('casts Veil of Summer to push a spell through a counter', () => {
    const t = testGame();
    t.p1.hand('Show and Tell', 'Omniscience', 'Veil of Summer');
    t.p1.manaBase(5);
    t.p2.hand('Mana Drain');
    t.p2.manaBase(2);
    t.begin();

    t.p1.cast('Show and Tell');
    priorityTo(t, 'p2');
    // One legal target, so the engine picks it without asking.
    t.p2.cast('Mana Drain');
    priorityTo(t, 'p1');

    expect(t.state.stack).toHaveLength(2);
    expect(cardOf(t, act(t, 'p1'))).toBe('veil_of_summer');
  });

  it('holds Veil of Summer when there is nothing to protect', () => {
    const t = testGame();
    t.p1.hand('Veil of Summer', 'Brainstorm');
    t.p1.manaBase(3);
    t.begin();

    expect(cardOf(t, act(t, 'p1'))).not.toBe('veil_of_summer');
  });
});

describe('the Orcish Bowmasters loop', () => {
  it('casts the second Bowmasters for free and bounces the first', () => {
    const t = testGame();
    t.p1.hand('Orcish Bowmasters');
    t.p1.battlefield('Omniscience', 'Hullbreaker Horror', 'Orcish Bowmasters', 'Island');
    t.p2.battlefield('Watery Grave');
    t.begin();

    const intent = act(t, 'p1');
    expect(intent.t).toBe('castSpell');
    expect(cardOf(t, intent)).toBe('orcish_bowmasters');
    if (intent.t === 'castSpell') expect(intent.free).toBe(true);

    const lifeBefore = t.state.players.p2.life;
    t.game.submitIntent('p1', intent);

    // Let the whole chain run on the agent's own answers: the Horror's mode, which
    // permanent it bounces, and where the Bowmasters ping goes. The point of the
    // test is that those three answers add up to a life total going down.
    runStackWithAgent(t);

    expect(t.state.players.p2.life).toBeLessThan(lifeBefore);
    // The bounced Bowmasters is back in hand, ready to go round again.
    expect(t.p1.handNames()).toContain('Orcish Bowmasters');
  });

  it('never points the ping at itself', () => {
    const t = testGame();
    t.p1.hand('Orcish Bowmasters');
    t.p1.battlefield('Atraxa, Grand Unifier', 'Watery Grave', 'Undercity Sewers');
    t.p2.battlefield('Breeding Pool');
    t.begin();

    t.p1.cast('Orcish Bowmasters');
    t.resolveStack();

    const choice = choiceFor(t, 'p1');
    expect(choice.kind).toBe('chooseTargets');
    const response = agent.respond(redact(t.state, 'p1'), choice, 50);
    expect(response.kind).toBe('targets');
    if (response.kind === 'targets') {
      const target = response.targets[0];
      expect(target.kind === 'player' && target.id === 'p1').toBe(false);
      if (target.kind === 'permanent') {
        expect(t.state.cards[target.iid].controller).toBe('p2');
      }
    }
  });
});

/**
 * The mirror's one genuine non-terminating loop, and the reason the arena tracks
 * unfinished games at all.
 *
 * Two Hullbreaker Horrors across two Omnisciences will bounce each other's Mana
 * Drains back and forth for ever: the card lands in a hand it costs nothing to leave
 * again, so no card is spent, no life total moves, and nothing is ever different.
 * The arena found it by failing to finish 65 games out of 600.
 */
describe('two Omnisciences on the table', () => {
  it('will not bounce a spell back to a hand it costs nothing to leave', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p1.battlefield('Omniscience', 'Hullbreaker Horror');
    t.p1.hand('Mana Drain');
    t.p2.battlefield('Omniscience');
    t.p2.hand('Brainstorm');
    t.begin();

    t.p2.cast('Brainstorm', { free: true });
    priorityTo(t, 'p1');
    t.p1.cast('Mana Drain', { free: true });

    const choice = choiceFor(t, 'p1');
    expect(choice.kind).toBe('chooseMode');
    if (choice.kind !== 'chooseMode') return;
    // Both halves are on offer, which is what makes this a decision.
    expect(choice.modes.filter((m) => m.enabled).map((m) => m.index)).toEqual([0, 1]);

    const response = agent.respond(redact(t.state, 'p1'), choice, 50);
    expect(response.kind).toBe('modes');
    if (response.kind === 'modes') expect(response.modes).not.toContain(0);
  });

  it('still bounces a spell when the opponent would have to pay for it again', () => {
    const t = testGame({ startingPlayer: 'p2' });
    t.p1.battlefield('Omniscience', 'Hullbreaker Horror');
    t.p1.hand('Mana Drain');
    // No Omniscience for p2: the bounce is a real counter here.
    t.p2.hand('Atraxa, Grand Unifier');
    t.p2.manaBase(7);
    t.begin();

    t.p2.cast('Atraxa, Grand Unifier');
    priorityTo(t, 'p1');
    t.p1.cast('Mana Drain', { free: true });

    const choice = choiceFor(t, 'p1');
    expect(choice.kind).toBe('chooseMode');
    const response = agent.respond(redact(t.state, 'p1'), choice, 50);
    expect(response.kind).toBe('modes');
    if (response.kind === 'modes') expect(response.modes).toEqual([0]);
  });

  /*
   * A generous timeout on this and the two below, not because they are slow but
   * because they are the only tests here whose cost is measured in games rather than
   * in assertions — and a laptop that has been running an arena throttles itself
   * enough to turn a five second test into a twenty second one.
   */
  it(
    'finishes every game of a mirror run',
    () => {
      const outcomes = runPairRange(
        { a: 'heuristic', b: 'heuristic', pairs: 12, seed: 20260824 },
        0,
        12,
      );
      expect(outcomes).toHaveLength(24);
      expect(outcomes.reduce((n, o) => n + o.unfinished, 0)).toBe(0);
    },
    60_000,
  );
});

describe('the mulligan', () => {
  const keeps = (hand: string[], mulligansTaken = 0): boolean => {
    const t = testGame();
    t.p1.hand(...hand);
    t.state.players.p1.mulligansTaken = mulligansTaken;
    t.begin();
    const view = redact(t.state, 'p1');
    const response = agent.respond(
      view,
      {
        kind: 'mulligan',
        id: 'm1',
        prompt: 'Keep this hand?',
        mulligansTaken,
        opponentMulligansTaken: 0,
        opponentHandSize: 7,
        iHaveDecided: false,
        opponentDecided: false,
      },
      50,
    );
    if (response.kind !== 'yesNo') throw new Error('Expected keep or mulligan');
    return response.value;
  };

  it('keeps the combo with mana behind it', () => {
    expect(
      keeps([
        'Island',
        'Watery Grave',
        'Breeding Pool',
        'Show and Tell',
        'Omniscience',
        'Brainstorm',
        'Mana Drain',
      ]),
    ).toBe(true);
  });

  it('ships a one-lander', () => {
    expect(
      keeps([
        'Island',
        'Omniscience',
        'Atraxa, Grand Unifier',
        'Show and Tell',
        'Mana Drain',
        'Veil of Summer',
        'Hullbreaker Horror',
      ]),
    ).toBe(false);
  });

  it('ships six lands and a brick', () => {
    expect(
      keeps([
        'Island',
        'Watery Grave',
        'Breeding Pool',
        'Hedge Maze',
        'Undercity Sewers',
        'Hallowed Fountain',
        'Omniscience',
      ]),
    ).toBe(false);
  });

  it('ships a hand of lands and uncastable enchantments', () => {
    // Three lands and no way to find anything: Omniscience without a Show and Tell
    // is a ten-drop this deck cannot cast.
    expect(
      keeps([
        'Island',
        'Watery Grave',
        'Breeding Pool',
        'Omniscience',
        'Omniscience',
        'Veil of Summer',
        'Veil of Summer',
      ]),
    ).toBe(false);
  });

  it('keeps whatever it has rather than going below five', () => {
    expect(keeps(['Island', 'Omniscience', 'Veil of Summer', 'Veil of Summer'], 3)).toBe(true);
  });
});

describe('two life for a land', () => {
  const paysForShockland = (life: number, lands: number): boolean => {
    const t = testGame();
    t.p1.hand('Watery Grave');
    if (lands > 0) t.p1.manaBase(lands);
    t.state.players.p1.life = life;
    t.begin();

    t.game.submitIntent('p1', { t: 'playLand', iid: t.state.zones.p1.hand[0] });
    const choice = choiceFor(t, 'p1');
    expect(choice.kind).toBe('yesNo');
    const response = agent.respond(redact(t.state, 'p1'), choice, 50);
    if (response.kind !== 'yesNo') throw new Error('Expected yes/no');
    return response.value;
  };

  it('pays at twenty life while the manabase is still short', () => {
    expect(paysForShockland(20, 1)).toBe(true);
  });

  it('will not pay at five, where two life is the game', () => {
    expect(paysForShockland(5, 1)).toBe(false);
  });
});

describe('against the ladder', () => {
  /**
   * The stage 1 bar from DESIGN-AI.md 4: "beats a beginner". Random play is the floor
   * of the ladder, and beating it by a wide and *significant* margin is the only thing
   * this proves — the real measurement is `npm run ai:arena`, which runs a hundred
   * times as many games as a test suite has time for.
   */
  it(
    'beats random by a margin that is significant, not just large',
    () => {
      const opts = { a: 'heuristic', b: 'random:1', pairs: 40, seed: 4711 };
      const outcomes = runPairRange(opts, 0, opts.pairs);

      const byPair = new Map<number, number[]>();
      let wins = 0;
      let losses = 0;
      let unfinished = 0;
      for (const o of outcomes) {
        if (!byPair.has(o.pair)) byPair.set(o.pair, []);
        byPair.get(o.pair)!.push(o.aScore);
        if (o.aScore === 1) wins++;
        else losses++;
        unfinished += o.unfinished;
      }
      const summary = summarise({
        pairScores: [...byPair.values()].map((s) => (s[0] + s[1]) / 2),
        wins,
        losses,
        draws: 0,
        unfinished,
      });

      expect(summary.score).toBeGreaterThan(0.85);
      expect(summary.significant).toBe(true);
      // A game that never ends is a bug in an agent, not a draw.
      expect(summary.unfinished).toBe(0);
    },
    60_000,
  );

  /**
   * The failure this deck is most prone to, and the one an opponent has nothing to do
   * with: an Omniscience turn that draws the whole library and dies on the next draw
   * step, having beaten nobody.
   */
  it(
    'almost never decks itself',
    () => {
      let deckedOut = 0;
      const games = 30;
      for (let i = 0; i < games; i++) {
        const record = playGame({
          p1: new HeuristicAgent(),
          p2: new RandomAgent(i + 1),
          seed: 20000 + i,
          startingPlayer: i % 2 === 0 ? 'p1' : 'p2',
        });
        if (record.winner === 'p2' && record.reason?.includes('empty library')) deckedOut++;
      }
      expect(deckedOut).toBeLessThanOrEqual(games * 0.1);
    },
    60_000,
  );
});
