import { describe, expect, it } from 'vitest';
import { getScript, scriptedOracleIds } from '../../engine/cards/index.js';
import { redact, type PlayerView } from '../../engine/redact.js';
import { seedRng } from '../../engine/rng.js';
import type { PlayerId } from '../../engine/types.js';
import type { Agent } from '../agent.js';
import { playGame } from '../arena.js';
import { determinize, determinizedGame, faithful } from '../determinize.js';
import { HeuristicAgent } from '../heuristic.js';
import { RandomAgent } from '../random.js';

/**
 * Whether a position rebuilt from a view really is the position it was rebuilt from.
 *
 * Everything stage 2 does rests on this. A search that runs on a subtly wrong board
 * is worse than no search: it is confidently wrong, and nothing downstream would ever
 * notice.
 */
describe('rebuilding a position from a view', () => {
  it('reproduces the view it was built from, at every priority window of real games', () => {
    let checked = 0;
    let rebuilt = 0;

    for (let seed = 1; seed <= 6; seed++) {
      playGame({
        p1: new HeuristicAgent(),
        p2: new RandomAgent(seed),
        seed: 41000 + seed,
        startingPlayer: seed % 2 === 0 ? 'p1' : 'p2',
        onDecision: (game, seat, kind) => {
          if (kind !== 'priority') return;
          checked++;
          const view = redact(game.state, seat);
          const { state, failure } = determinize(view, seedRng(seed * 7919 + checked));
          expect(failure).toBeNull();
          if (!state) return;
          // The whole contract, in one line.
          expect(faithful(view, state)).toBe(true);
          rebuilt++;
        },
      });
    }

    expect(checked).toBeGreaterThan(400);
    expect(rebuilt).toBe(checked);
  });

  it('deals the opponent a hand of the right size out of the cards they could have', () => {
    playGame({
      p1: new HeuristicAgent(),
      p2: new HeuristicAgent(),
      seed: 5309,
      onDecision: (game, seat, kind) => {
        if (kind !== 'priority') return;
        if (game.state.turn < 4) return;
        const opponent: PlayerId = seat === 'p1' ? 'p2' : 'p1';
        const view = redact(game.state, seat);
        const { state } = determinize(view, seedRng(game.state.turn));
        if (!state) return;

        expect(state.zones[opponent].hand).toHaveLength(view.players[opponent].handCount);
        expect(state.zones[opponent].library).toHaveLength(
          view.players[opponent].libraryCount,
        );
        expect(state.zones[seat].library).toHaveLength(view.players[seat].libraryCount);

        // Sixty cards each, still, however they have been shuffled around.
        for (const p of ['p1', 'p2'] as PlayerId[]) {
          const owned = Object.values(state.cards).filter(
            (c) => c.owner === p && !c.isToken && !c.isAbility,
          );
          expect(owned).toHaveLength(60);
        }
      },
    });
  });

  it('gives different rolls different hands, and the same roll the same hand', () => {
    const view = firstMidGameView();
    const namesFrom = (seed: number) => {
      const { state } = determinize(view, seedRng(seed));
      const opponent: PlayerId = view.viewer === 'p1' ? 'p2' : 'p1';
      return state?.zones[opponent].hand.map((iid) => state.cards[iid].oracleId).join(',');
    };
    expect(namesFrom(1)).toBe(namesFrom(1));
    // Two draws from a 40-odd card pool agreeing exactly would be a broken shuffle.
    expect(namesFrom(1)).not.toBe(namesFrom(2));
  });

  it('refuses to rebuild a position the engine is part-way through', () => {
    let refusals = 0;
    playGame({
      p1: new HeuristicAgent(),
      p2: new RandomAgent(3),
      seed: 9090,
      onDecision: (game, seat, kind) => {
        if (kind !== 'choice') return;
        const view = redact(game.state, seat);
        const { state, failure } = determinize(view, seedRng(1));
        expect(state).toBeNull();
        expect(failure).toBe('pending-choice');
        refusals++;
      },
    });
    expect(refusals).toBeGreaterThan(10);
  });

  /**
   * Two assumptions the rebuild makes about ability objects on the stack, checked
   * against the live card registry rather than believed. If a future card breaks
   * either, this fails long before a search quietly resolves the wrong ability.
   */
  it('holds the assumptions the rebuild makes about abilities', () => {
    for (const oracleId of scriptedOracleIds()) {
      const script = getScript(oracleId);
      const abilities = script?.abilities ?? [];
      expect(
        abilities.length,
        `${oracleId} has more than one ability, so ability index 0 is no longer safe`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('produces a game that can actually be played on', () => {
    const view = firstMidGameView();
    const game = determinizedGame(view, seedRng(77));
    expect(game).not.toBeNull();
    if (!game) return;

    // The rebuilt position offers its viewer exactly the actions the real one did.
    expect(game.legalActions(view.viewer)).toEqual(view.legalActions);

    // And it runs forward to a real ending rather than falling over.
    const agent: Agent = new HeuristicAgent();
    for (let guard = 0; guard < 4000 && game.state.winner === null; guard++) {
      const pending = game.state.pendingChoice;
      if (pending) {
        const seats: PlayerId[] =
          pending.kind === 'mulligan' || pending.kind === 'simultaneousSecret'
            ? [...pending.awaiting]
            : [pending.player];
        for (const s of seats) {
          if (game.state.pendingChoice?.id !== pending.id) break;
          const v = redact(game.state, s);
          if (!v.choice) continue;
          game.submitChoice(s, pending.id, agent.respond(v, v.choice, 5));
        }
        continue;
      }
      const holder = game.state.priorityPlayer;
      if (holder === null) {
        game.advance();
        continue;
      }
      game.submitIntent(holder, agent.act(redact(game.state, holder), 5));
    }
    expect(game.state.winner).not.toBeNull();
  });
});

/** A view from the middle of a real game, which is the only interesting kind. */
function firstMidGameView(): PlayerView {
  let captured: PlayerView | null = null;
  playGame({
    p1: new HeuristicAgent(),
    p2: new RandomAgent(5),
    seed: 6161,
    onDecision: (game, seat, kind) => {
      if (captured || kind !== 'priority') return;
      if (game.state.turn < 5) return;
      if (game.state.zones[seat].battlefield.length < 3) return;
      captured = redact(game.state, seat);
    },
  });
  if (!captured) throw new Error('no mid-game position was reached');
  return captured;
}
