import { describe, expect, it } from 'vitest';
import { Game } from '../game.js';
import { MAINDECK } from '../deck.js';
import { redact } from '../redact.js';
import type { PlayerId } from '../types.js';

/**
 * The opening hand, from both seats at once.
 *
 * Mulligans used to be asked one player at a time: you mulliganed, and your next
 * hand only arrived once your opponent had finished deciding — with nothing on
 * screen saying so, which reads as a frozen client rather than as waiting. Both
 * players are asked together now, and these tests hold that shape in place.
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
  it('asks both players at the same time', () => {
    const game = opening();
    const c = mulliganChoice(game);
    expect(c.awaiting.sort()).toEqual(['p1', 'p2']);
    expect(game.state.zones.p1.hand).toHaveLength(7);
    expect(game.state.zones.p2.hand).toHaveLength(7);
  });

  it('keeps the choice open for one player after the other has answered', () => {
    const game = opening();
    const c = mulliganChoice(game);
    game.submitChoice('p1', c.id, { kind: 'yesNo', value: false });

    const still = mulliganChoice(game);
    expect(still.awaiting).toEqual(['p2']);
    expect(still.lockedIn).toEqual(['p1']);
    // p1's hand has NOT been replaced yet — the round resolves together, so
    // nobody learns what the other did from the timing of their own redraw.
    expect(game.state.players.p1.mulligansTaken).toBe(0);
  });

  it('deals the new hand as soon as the round closes', () => {
    const game = opening();
    const c = mulliganChoice(game);
    const before = [...game.state.zones.p1.hand];
    game.submitChoice('p1', c.id, { kind: 'yesNo', value: false });
    game.submitChoice('p2', c.id, { kind: 'yesNo', value: true });

    expect(game.state.players.p1.mulligansTaken).toBe(1);
    expect(game.state.players.p2.keptHand).toBe(true);
    expect(game.state.zones.p1.hand).toHaveLength(7);
    expect(game.state.zones.p1.hand).not.toEqual(before);
    // And p1 is immediately asked again, rather than waiting on anything.
    expect(mulliganChoice(game).awaiting).toEqual(['p1']);
  });

  it('tells each player where the other one is, without leaking the decision', () => {
    const game = opening();
    const c = mulliganChoice(game);
    game.submitChoice('p1', c.id, { kind: 'yesNo', value: false });

    const p2View = redact(game.state, 'p2').choice;
    expect(p2View?.kind).toBe('mulligan');
    if (p2View?.kind !== 'mulligan') throw new Error('unreachable');
    expect(p2View.opponentDecided).toBe(true);
    expect(p2View.iHaveDecided).toBe(false);

    const p1View = redact(game.state, 'p1').choice;
    if (p1View?.kind !== 'mulligan') throw new Error('unreachable');
    expect(p1View.iHaveDecided).toBe(true);
    expect(p1View.opponentDecided).toBe(false);
  });

  it('shows p2 the same thing whichever way p1 decided', () => {
    // The point of resolving the round together: until it closes, "they have
    // decided" is all anyone learns. If these two differed by a single byte,
    // p2 could read the opponent's keep off their own screen.
    const views = [true, false].map((p1Keeps) => {
      const game = opening();
      const c = mulliganChoice(game);
      game.submitChoice('p1', c.id, { kind: 'yesNo', value: p1Keeps });
      const v = redact(game.state, 'p2');
      return JSON.stringify({ choice: v.choice, players: v.players, hand: v.hand });
    });
    expect(views[0]).toEqual(views[1]);
  });

  it('refuses a second answer from the same player', () => {
    const game = opening();
    const c = mulliganChoice(game);
    game.submitChoice('p1', c.id, { kind: 'yesNo', value: true });
    expect(() => game.submitChoice('p1', c.id, { kind: 'yesNo', value: false })).toThrow(
      /already decided/i,
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
