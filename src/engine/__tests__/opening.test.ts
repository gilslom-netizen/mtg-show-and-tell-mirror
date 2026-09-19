import { describe, expect, it } from 'vitest';
import { Game } from '../game.js';
import { MAINDECK } from '../deck.js';
import { redact } from '../redact.js';
import type { PlayerId } from '../types.js';

/**
 * The opening hand, one seat at a time.
 *
 * In turn order: the player on the play decides first (CR 103.4), and the other
 * seat is shown its hand with nothing it may press yet.
 *
 * This was simultaneous for a while, so that the second to answer could not read
 * the first's decision. What that traded away is the thing the rule is for —
 * across a table you watch them ship it back and reshuffle before deciding
 * whether to keep a hand that beats a fresh six. The problem that drove the
 * change was that a mulligan was not dealt until both had answered, which reads
 * as a frozen client; that is fixed by applying each answer as it is given,
 * rather than by hiding the order of play.
 */
function opening(seed = 5, startingPlayer: PlayerId = 'p1'): Game {
  const game = Game.create({ gameId: 'mull', seed, deck: MAINDECK, startingPlayer });
  game.advance();
  return game;
}

function mulliganChoice(game: Game) {
  const c = game.state.pendingChoice;
  if (!c || c.kind !== 'mulligan') throw new Error(`Expected a mulligan, got ${c?.kind}`);
  return c;
}

describe('the opening hand', () => {
  it('asks the player on the play first, and only them', () => {
    for (const onThePlay of ['p1', 'p2'] as PlayerId[]) {
      const game = opening(5, onThePlay);
      const c = mulliganChoice(game);
      expect(c.awaiting).toEqual([onThePlay]);
      // Both hands are dealt up front: the other seat is looking at its seven
      // the whole time, it just may not act on it yet.
      expect(game.state.zones.p1.hand).toHaveLength(7);
      expect(game.state.zones.p2.hand).toHaveLength(7);
    }
  });

  it('will not take an answer from the seat that is not to act', () => {
    const game = opening(5, 'p1');
    const c = mulliganChoice(game);
    expect(() => game.submitChoice('p2', c.id, { kind: 'yesNo', value: true })).toThrow(
      /already decided/i,
    );
    // And nothing moved.
    expect(game.state.players.p2.keptHand).toBeFalsy();
    expect(mulliganChoice(game).awaiting).toEqual(['p1']);
  });

  it('passes the decision to the other seat once the first has answered', () => {
    const game = opening(5, 'p1');
    game.submitChoice('p1', mulliganChoice(game).id, { kind: 'yesNo', value: true });

    const next = mulliganChoice(game);
    expect(next.awaiting).toEqual(['p2']);
    expect(next.lockedIn).toEqual(['p1']);
  });

  /**
   * The frozen client this sequencing had to avoid: a player who mulligans gets
   * their new hand at once, rather than when the other seat finishes thinking.
   */
  it('deals a mulligan immediately, while the other seat is still deciding', () => {
    const game = opening(5, 'p1');
    const before = [...game.state.zones.p1.hand];
    game.submitChoice('p1', mulliganChoice(game).id, { kind: 'yesNo', value: false });

    expect(game.state.players.p1.mulligansTaken).toBe(1);
    expect(game.state.zones.p1.hand).toHaveLength(7);
    expect(game.state.zones.p1.hand).not.toEqual(before);
    // p2 has still not been asked to do anything but is now the one to act.
    expect(game.state.players.p2.mulligansTaken).toBe(0);
    expect(mulliganChoice(game).awaiting).toEqual(['p2']);
  });

  it('comes back round to the first seat only after the second has answered', () => {
    const game = opening(5, 'p1');
    game.submitChoice('p1', mulliganChoice(game).id, { kind: 'yesNo', value: false });
    expect(mulliganChoice(game).awaiting).toEqual(['p2']);
    game.submitChoice('p2', mulliganChoice(game).id, { kind: 'yesNo', value: true });

    expect(game.state.players.p2.keptHand).toBe(true);
    expect(mulliganChoice(game).awaiting).toEqual(['p1']);
  });

  it('tells each seat whose turn it is', () => {
    const game = opening(5, 'p1');

    let p1 = redact(game.state, 'p1').choice;
    let p2 = redact(game.state, 'p2').choice;
    if (p1?.kind !== 'mulligan' || p2?.kind !== 'mulligan') throw new Error('unreachable');
    expect(p1.myTurnToDecide).toBe(true);
    expect(p2.myTurnToDecide).toBe(false);

    game.submitChoice('p1', mulliganChoice(game).id, { kind: 'yesNo', value: false });

    p1 = redact(game.state, 'p1').choice;
    p2 = redact(game.state, 'p2').choice;
    if (p1?.kind !== 'mulligan' || p2?.kind !== 'mulligan') throw new Error('unreachable');
    expect(p1.myTurnToDecide).toBe(false);
    expect(p1.iHaveDecided).toBe(true);
    expect(p2.myTurnToDecide).toBe(true);
    expect(p2.opponentDecided).toBe(true);
  });

  it('shows the second seat that the first shipped it, and never what was in it', () => {
    const game = opening(5, 'p1');
    game.submitChoice('p1', mulliganChoice(game).id, { kind: 'yesNo', value: false });

    const v = redact(game.state, 'p2');
    if (v.choice?.kind !== 'mulligan') throw new Error('unreachable');
    // Across a table you watch them reshuffle, so this is theirs to know.
    expect(v.choice.opponentMulligansTaken).toBe(1);
    // What was in either hand is still nobody else's business.
    for (const iid of game.state.zones.p1.hand) expect(v.cards[iid]).toBeUndefined();
  });

  it('refuses a second answer from the same player', () => {
    const game = opening(5, 'p1');
    const c = mulliganChoice(game);
    game.submitChoice('p1', c.id, { kind: 'yesNo', value: true });
    expect(() => game.submitChoice('p1', c.id, { kind: 'yesNo', value: false })).toThrow(
      /Stale choice id|already decided/i,
    );
  });

  /** Mulligan until this many have been taken, then keep. p2 always keeps. */
  function playOut(game: Game, p1Mulligans: number): void {
    let guard = 0;
    while (game.state.mode === 'mulligan' && guard++ < 20) {
      const c = game.state.pendingChoice;
      if (!c) break;
      if (c.kind === 'mulligan') {
        for (const p of [...c.awaiting]) {
          const keep = !(p === 'p1' && game.state.players.p1.mulligansTaken < p1Mulligans);
          game.submitChoice(p, c.id, { kind: 'yesNo', value: keep });
        }
      } else if (c.kind === 'chooseCards') {
        game.submitChoice(c.player, c.id, {
          kind: 'cards',
          iids: c.options.slice(0, c.min).map((o) => o.iid),
        });
      } else {
        break;
      }
    }
  }

  /**
   * The first mulligan is free, as in Commander.
   *
   * Both players run the same sixty cards, so a free look costs neither of them
   * anything relative to the other. What it buys is fewer games decided by an
   * opening hand rather than by anything either player did.
   */
  it('costs nothing the first time: a new seven, and no card on the bottom', () => {
    const game = opening();
    playOut(game, 1);

    expect(game.state.mode).toBe('playing');
    expect(game.state.players.p1.mulligansTaken).toBe(1);
    expect(game.state.zones.p1.hand).toHaveLength(7);
    // Nothing was ever asked, because there was nothing to put back.
    expect(game.state.log.some((l) => /bottom/i.test(l.text))).toBe(false);
    expect(game.state.log.some((l) => /free mulligan/i.test(l.text))).toBe(true);
    expect(game.state.turn).toBe(1);
    // p2 kept their opening seven untouched. "Seven or more" rather than exactly
    // seven because the engine's own auto-pass may already have run p1's turn out
    // and given p2 their draw; `turn` counts rounds, not player-turns, either way.
    expect(game.state.players.p2.mulligansTaken).toBe(0);
    expect(game.state.zones.p2.hand.length).toBeGreaterThanOrEqual(7);
  });

  it('starts costing cards from the second one, London-style', () => {
    const game = opening();
    playOut(game, 2);

    expect(game.state.mode).toBe('playing');
    expect(game.state.players.p1.mulligansTaken).toBe(2);
    expect(game.state.zones.p1.hand).toHaveLength(6);
    expect(game.state.log.some((l) => /mulligans to 6/.test(l.text))).toBe(true);
  });

  it('bottoms one fewer than it used to, all the way down', () => {
    // The rule as a table, because off-by-one here is the whole feature: taking
    // three mulligans to reach five is not the same game as reaching four.
    const game = opening();
    playOut(game, 4);
    expect(game.state.zones.p1.hand).toHaveLength(4);
  });
});
