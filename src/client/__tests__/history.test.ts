import { beforeEach, describe, expect, it } from 'vitest';
import { Game } from '@engine/game';
import { MAINDECK } from '@engine/deck';
import { stateHash } from '../../engine/__tests__/bot';
import { LocalConnection } from '../connection';
import { allPlayed, clearPlayed, recordPlayed, summarisePlayed, type PlayedGame } from '../history';

/**
 * A saved game is only worth saving if it is the game.
 *
 * The whole point of storing `(seed, starting player, action log)` rather than a
 * result line is that it is not a summary — replaying it reproduces the game
 * exactly, every hidden card and every decision. That is a claim about the format,
 * so it gets checked rather than asserted: a game is played, the record it leaves
 * behind is replayed into a fresh engine, and the two final states have to be
 * identical.
 */

function installStorage(): void {
  const data = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

/** Replays a saved game into a fresh engine, the way the arena replays a record. */
function replay(g: PlayedGame): Game {
  const game = Game.create({
    gameId: `replay-${g.seed}`,
    seed: g.seed,
    deck: MAINDECK,
    startingPlayer: g.startingPlayer,
  });
  game.advance();
  for (const a of g.actions) {
    if (a.k === 'intent' && a.intent) game.submitIntent(a.seat, a.intent);
    else if (a.k === 'choice' && a.choiceId && a.response) {
      game.submitChoice(a.seat, a.choiceId, a.response);
    }
  }
  return game;
}

describe('the games you have played', () => {
  beforeEach(() => {
    installStorage();
    clearPlayed();
  });

  it('writes a finished game down, and the record replays to the same position', () => {
    const seed = 909090;
    const conn = new LocalConnection({ seed, startingPlayer: 'p1', seats: ['p1', 'p2'] });

    // Both players keep, then a few real turns, then someone gives up. Driving both
    // seats by hand keeps this about the recording rather than about an agent.
    for (let guard = 0; guard < 400; guard++) {
      const s = conn.game.state;
      if (s.winner !== null) break;
      if (s.turn >= 3) {
        conn.submitIntent('p2', { t: 'concede' });
        break;
      }
      const pc = s.pendingChoice;
      if (pc) {
        if (pc.kind === 'mulligan') {
          for (const seat of [...pc.awaiting]) {
            conn.submitChoice(seat, pc.id, { kind: 'yesNo', value: true });
          }
        } else if (pc.kind === 'simultaneousSecret') {
          for (const seat of [...pc.awaiting]) {
            conn.submitChoice(seat, pc.id, { kind: 'secret', iid: null });
          }
        } else {
          const seat = pc.player;
          if (pc.kind === 'chooseCards') {
            const ok = pc.options.filter((o) => !o.disabledReason).map((o) => o.iid);
            conn.submitChoice(seat, pc.id, { kind: 'cards', iids: ok.slice(0, pc.min) });
          } else if (pc.kind === 'yesNo') {
            conn.submitChoice(seat, pc.id, { kind: 'yesNo', value: false });
          } else if (pc.kind === 'chooseTargets') {
            conn.submitChoice(seat, pc.id, {
              kind: 'targets',
              targets: pc.optional ? [] : pc.candidates.slice(0, pc.count),
            });
          } else if (pc.kind === 'orderTriggers') {
            conn.submitChoice(seat, pc.id, { kind: 'order', ids: pc.triggers.map((t) => t.id) });
          } else if (pc.kind === 'declareAttackers') {
            conn.submitChoice(seat, pc.id, { kind: 'attackers', iids: [] });
          } else if (pc.kind === 'declareBlockers') {
            conn.submitChoice(seat, pc.id, { kind: 'blockers', blocks: [] });
          } else if (pc.kind === 'chooseMode') {
            conn.submitChoice(seat, pc.id, { kind: 'modes', modes: [] });
          } else {
            conn.submitChoice(seat, pc.id, {
              kind: 'damage',
              assignment: { [pc.blockers[0]]: pc.total },
            });
          }
        }
        continue;
      }
      const p = s.priorityPlayer;
      if (p === null) break;
      conn.submitIntent(p, { t: 'passPriority' });
    }

    const saved = allPlayed();
    expect(saved).toHaveLength(1);
    const record = saved[0];
    expect(record.opponent).toBe('hotseat');
    expect(record.winner).not.toBeNull();
    expect(record.actions.length).toBeGreaterThan(2);

    // The claim, checked: the log is the game, not a description of it.
    expect(stateHash(replay(record).state)).toBe(stateHash(conn.game.state));
  });

  it('keeps games across sessions and counts them from the seat that played', () => {
    const base: PlayedGame = {
      at: 1,
      seat: 'p1',
      opponent: 'heuristic',
      seed: 1,
      startingPlayer: 'p1',
      winner: 'p1',
      reason: 'life total reached 0',
      turns: 8,
      actions: [],
    };
    recordPlayed(base);
    recordPlayed({ ...base, at: 2, winner: 'p2', turns: 12 });
    recordPlayed({ ...base, at: 3, winner: 'p2', reason: 'conceded', turns: 4 });

    const s = summarisePlayed();
    expect(s.games).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(2);
    expect(s.averageTurns).toBe(8);
    expect(s.byReason['conceded']).toBe(1);
  });

  it('survives a corrupt entry rather than taking the app down with it', () => {
    localStorage.setItem('satm:played', '{not json');
    expect(allPlayed()).toEqual([]);
    expect(() => summarisePlayed()).not.toThrow();
  });
});
