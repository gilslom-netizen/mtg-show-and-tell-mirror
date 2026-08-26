import { beforeEach, describe, expect, it } from 'vitest';
import handler from '../../../api/game.js';
import { setStore } from '../store.js';
import { Game } from '../../engine/game.js';
import { MAINDECK } from '../../engine/deck.js';
import type { ChoiceResponse, PlayerId } from '../../engine/types.js';
import type { Intent } from '../../engine/game.js';

/**
 * Keeping an online game.
 *
 * Local games have been recorded for a while; online ones were not recorded at
 * all, so an evening against a real opponent left nothing behind — the exact gap
 * recording was built to close. The fix rests on the property the whole engine
 * rests on: a game is `(seed, starting player, action log)`, so handing the
 * client the log once the game is over gives it the entire game, both hands
 * included, without ever having shown it anything mid-game.
 *
 * These hold both halves: nothing before the end, everything after — and
 * "everything" checked by replaying it, not by counting actions.
 */

interface Captured {
  code: number;
  body: Record<string, unknown>;
}

function fakeRes(): { res: never; out: Captured } {
  const out: Captured = { code: 0, body: {} };
  const res = {
    status(code: number) {
      out.code = code;
      return res;
    },
    json(body: unknown) {
      out.body = body as Record<string, unknown>;
    },
    setHeader() {},
  };
  return { res: res as never, out };
}

async function post(body: Record<string, unknown>): Promise<Captured> {
  const { res, out } = fakeRes();
  await handler({ method: 'POST', body } as never, res);
  return out;
}

async function get(query: Record<string, string>): Promise<Captured> {
  const { res, out } = fakeRes();
  await handler({ method: 'GET', query } as never, res);
  return out;
}

interface Finished {
  gameId: string;
  seed: number;
  startingPlayer: PlayerId;
  winner: PlayerId | 'draw';
  reason: string | null;
  turns: number;
  actions: { k: 'intent' | 'choice'; seat: PlayerId; intent?: Intent; response?: ChoiceResponse }[];
}

async function seatBoth(room: string) {
  const a = await post({ room, name: 'alice', bestOf: 1 });
  const b = await post({ room, name: 'bob' });
  return {
    a: { token: a.body.token as string, seat: a.body.seat as PlayerId },
    b: { token: b.body.token as string, seat: b.body.seat as PlayerId },
  };
}

/** Keep both hands, then concede: the shortest route to a real finished game. */
async function playToAnEnding(room: string, a: { token: string }, b: { token: string }) {
  for (let i = 0; i < 6; i++) {
    for (const p of [a, b]) {
      const snap = await get({ room, token: p.token, since: '-1', rev: '-1' });
      const view = snap.body.view as { choice?: { id: string; kind: string } };
      if (view.choice?.kind === 'mulligan') {
        await post({
          room,
          token: p.token,
          action: { t: 'choice', choiceId: view.choice.id, response: { kind: 'yesNo', value: true } },
        });
      }
    }
  }
  await post({ room, token: b.token, action: { t: 'intent', intent: { t: 'concede' } } });
}

describe('an online game is written down', () => {
  beforeEach(() => setStore(null));

  it('sends nothing while the game is still being played', async () => {
    const room = 'REC1';
    const { a, b } = await seatBoth(room);
    void b;
    const snap = await get({ room, token: a.token, since: '-1', rev: '-1' });
    // Mid-game the client gets a redacted view and nothing else. Sending the log
    // here would be handing over the opponent's hand.
    expect((snap.body.view as { winner: unknown }).winner).toBeNull();
    expect(snap.body.finished).toBeUndefined();
  });

  it('sends the whole game once it is over', async () => {
    const room = 'REC2';
    const { a, b } = await seatBoth(room);
    await playToAnEnding(room, a, b);

    const snap = await get({ room, token: a.token, since: '-1', rev: '-1' });
    const f = snap.body.finished as Finished | undefined;
    expect(f).toBeDefined();
    if (!f) return;
    expect(f.winner).toBe(a.seat);
    expect(f.actions.length).toBeGreaterThan(0);
  });

  /**
   * The claim that matters: what is saved is the game, not a summary of it.
   * Replaying the log reaches the same ending — and reconstructs both players'
   * hands on the way, which a redacted view could never do however much of it
   * you stored.
   */
  it('replays back into the same game, both hands included', async () => {
    const room = 'REC3';
    const { a, b } = await seatBoth(room);
    await playToAnEnding(room, a, b);

    const snap = await get({ room, token: a.token, since: '-1', rev: '-1' });
    const f = snap.body.finished as Finished | undefined;
    if (!f) throw new Error('no finished game was sent');

    const replay = Game.create({
      gameId: f.gameId,
      seed: f.seed,
      deck: MAINDECK,
      startingPlayer: f.startingPlayer,
    });
    replay.advance();
    for (const action of f.actions) {
      if (replay.state.winner !== null) break;
      if (action.k === 'intent' && action.intent) {
        replay.submitIntent(action.seat, action.intent);
      } else if (action.response) {
        const pc = replay.state.pendingChoice;
        if (pc) replay.submitChoice(action.seat, pc.id, action.response);
      }
    }

    expect(replay.state.winner).toBe(f.winner);
    // Both hands are reconstructed — the whole reason to keep the log rather
    // than a scoreline.
    const hands = (['p1', 'p2'] as PlayerId[]).map((p) => replay.state.zones[p].hand.length);
    expect(hands.every((n) => n > 0)).toBe(true);
  });
});
