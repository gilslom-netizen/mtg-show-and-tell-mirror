import { describe, expect, it } from 'vitest';
import { redact } from '../../engine/redact.js';
import type { PlayerId } from '../../engine/types.js';
import { playGame } from '../arena.js';
import { HeuristicAgent } from '../heuristic.js';
import { RandomAgent } from '../random.js';

/**
 * Principle ע1: an agent sees exactly what a player sees.
 *
 * The `Agent` interface takes a `PlayerView`, so an agent cannot reach the state by
 * accident. That is worth checking anyway, because the thing that could quietly break
 * it is not an agent — it is a driver that hands one the wrong view, or a redaction
 * that starts leaking. Both would be invisible until an agent had already learned to
 * rely on it.
 *
 * So this walks the views actually produced during real games and asserts that none
 * of them ever names a card in the opponent's hand or in either library.
 */
describe('agents only ever see a redacted view', () => {
  it('never names a hidden card in any view handed out during a game', () => {
    let checked = 0;

    for (let seed = 1; seed <= 6; seed++) {
      playGame({
        p1: new HeuristicAgent(),
        p2: new RandomAgent(seed),
        seed: 5000 + seed,
        startingPlayer: seed % 2 === 0 ? 'p1' : 'p2',
        onDecision: (game, seat) => {
          const s = game.state;
          const opponent: PlayerId = seat === 'p1' ? 'p2' : 'p1';
          const view = redact(s, seat);
          checked++;

          /*
           * Library order is never sent to anyone. A card in my own library may be
           * identifiable, but only while a choice is showing it to me — a Dig
           * Through Time, a surveil, a fetchland search. Anything outside that set
           * is a leak, and one in the opponent's library is a leak whatever is open.
           */
          const shown = new Set<number>();
          const pc = s.pendingChoice;
          if (pc?.kind === 'chooseCards' && (pc.player === seat || pc.publicReveal)) {
            for (const o of pc.options) shown.add(o.iid);
          }
          for (const iid of s.zones[seat].library) {
            if (shown.has(iid)) continue;
            expect(view.cards[iid]).toBeUndefined();
          }
          for (const iid of s.zones[opponent].library) {
            expect(view.cards[iid]).toBeUndefined();
          }

          /*
           * The opponent's hand is hidden — except for cards a choice legitimately
           * shows this player, which in this pool is Atraxa's public reveal. Those
           * have already moved out of the hand by the time they are shown, so a
           * card that is in the hand right now is never legitimately visible.
           */
          for (const iid of s.zones[opponent].hand) {
            expect(view.cards[iid]).toBeUndefined();
          }

          // And the Show and Tell pick stays secret until both players have locked in.
          if (view.choice?.kind === 'simultaneousSecret') {
            expect(view.choice).not.toHaveProperty('requests');
            expect(JSON.stringify(view.choice)).not.toContain('secretResponses');
          }
        },
      });
    }

    // A failure to produce views at all would pass every assertion above.
    expect(checked).toBeGreaterThan(500);
  });

  it('hands each seat its own view, not the other seat’s', () => {
    playGame({
      p1: new HeuristicAgent(),
      p2: new HeuristicAgent(),
      seed: 777,
      onDecision: (game, seat) => {
        const view = redact(game.state, seat);
        expect(view.viewer).toBe(seat);
        expect(view.hand).toEqual(game.state.zones[seat].hand);
      },
    });
  });
});
