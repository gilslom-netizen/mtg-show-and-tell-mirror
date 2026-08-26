import { beforeEach, describe, expect, it } from 'vitest';
import handler from '../../../api/game.js';
import health from '../../../api/health.js';
import { redisConfigFromEnv, setStore } from '../store.js';
import type { PlayerId } from '../../engine/types.js';

/**
 * The serverless online path, exercised the same way Vercel calls it.
 *
 * This is the whole reason the engine is deterministic: each request rebuilds the
 * game from its action log, so no process has to stay alive between moves.
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

async function joinAs(room: string, name: string) {
  const r = await post({ room, name });
  return { token: r.body.token as string, seat: r.body.seat as PlayerId, snap: r.body };
}

describe('serverless online api', () => {
  beforeEach(() => {
    // A fresh in-memory store per test; production uses Redis.
    setStore(null);
  });

  it('reports that online play is available', async () => {
    const { res, out } = fakeRes();
    await health({}, res);
    expect(out.body.ok).toBe(true);
    expect(out.body.store).toBe('memory');
    // Memory is not shared across serverless instances, and the client is told so.
    expect(out.body.durable).toBe(false);
    // One process, one memory: usable here even without Redis.
    expect(out.body.usable).toBe(true);
  });

  it('refuses to promise online play a serverless host cannot deliver', async () => {
    const before = process.env.VERCEL;
    process.env.VERCEL = '1';
    try {
      const { res, out } = fakeRes();
      await health({}, res);
      // Two instances, two memories, two rooms — the lobby has to block this
      // rather than let both players wait for an opponent who is elsewhere.
      expect(out.body.serverless).toBe(true);
      expect(out.body.durable).toBe(false);
      expect(out.body.usable).toBe(false);
    } finally {
      if (before === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = before;
    }
  });

  it('seats two players who typed the code differently', async () => {
    const a = await joinAs(' room9 ', 'alice');
    const b = await joinAs('rOoM9', 'bob');
    expect(a.seat).toBe('p1');
    expect(b.seat).toBe('p2');
    expect((b.snap as { ready: boolean }).ready).toBe(true);
  });

  it('runs the series at the length the room was opened with', async () => {
    const a = await post({ room: 'LONG5', name: 'alice', bestOf: 5 });
    expect((a.body.match as { bestOf: number }).bestOf).toBe(5);

    // The second player joins into whatever is already set up, whatever their own
    // lobby says — the length belongs to the room, not to each client.
    const b = await post({ room: 'LONG5', name: 'bob', bestOf: 1 });
    expect((b.body.match as { bestOf: number }).bestOf).toBe(5);
  });

  it('opens a best of one, and reads an impossible length as a best of three', async () => {
    const one = await post({ room: 'SHORT1', name: 'alice', bestOf: 1 });
    expect((one.body.match as { bestOf: number }).bestOf).toBe(1);

    const odd = await post({ room: 'ODD', name: 'alice', bestOf: 4 });
    expect((odd.body.match as { bestOf: number }).bestOf).toBe(3);

    const none = await post({ room: 'PLAIN', name: 'alice' });
    expect((none.body.match as { bestOf: number }).bestOf).toBe(3);
  });

  it('seats two players and refuses a third', async () => {
    const a = await joinAs('ROOM1', 'alice');
    const b = await joinAs('ROOM1', 'bob');
    expect(a.seat).toBe('p1');
    expect(b.seat).toBe('p2');
    expect(a.token).not.toBe(b.token);
    expect((b.snap as { ready: boolean }).ready).toBe(true);

    const third = await post({ room: 'ROOM1', name: 'carol' });
    expect(third.code).toBe(409);
  });

  it('returns the same seat when a player comes back with their token', async () => {
    const a = await joinAs('ROOM2', 'alice');
    await joinAs('ROOM2', 'bob');
    const again = await post({ room: 'ROOM2', token: a.token, name: 'alice' });
    expect(again.body.seat).toBe(a.seat);
  });

  it('rejects an action from someone with no seat', async () => {
    await joinAs('ROOM3', 'alice');
    const r = await post({ room: 'ROOM3', token: 'not-a-token', action: { t: 'cancel' } });
    expect(r.code).toBe(403);
  });

  it('plays the mulligan step over HTTP and rebuilds state from the log each time', async () => {
    const a = await joinAs('ROOM4', 'alice');
    const b = await joinAs('ROOM4', 'bob');

    // Keep whichever hand is being asked about, until the game starts.
    for (let i = 0; i < 6; i++) {
      for (const p of [a, b]) {
        const snap = await get({ room: 'ROOM4', token: p.token, since: '-1', rev: '-1' });
        const view = snap.body.view as { choice?: { id: string; kind: string } };
        if (view.choice?.kind === 'mulligan') {
          await post({
            room: 'ROOM4',
            token: p.token,
            action: {
              t: 'choice',
              choiceId: view.choice.id,
              response: { kind: 'yesNo', value: true },
            },
          });
        }
      }
    }

    const final = await get({ room: 'ROOM4', token: a.token, since: '-1', rev: '-1' });
    const view = final.body.view as {
      mode: string;
      hand: number[];
      players: Record<PlayerId, { handCount: number }>;
    };
    expect(view.mode).toBe('playing');
    expect(view.hand).toHaveLength(7);
    expect(view.players.p2.handCount).toBe(7);
  });

  it('counts a finished game once, however many times it is polled', async () => {
    const a = await joinAs('SERIES', 'alice');
    const b = await joinAs('SERIES', 'bob');

    // Keep both hands so there is a real game to lose.
    for (let i = 0; i < 6; i++) {
      for (const p of [a, b]) {
        const snap = await get({ room: 'SERIES', token: p.token, since: '-1', rev: '-1' });
        const view = snap.body.view as { choice?: { id: string; kind: string } };
        if (view.choice?.kind === 'mulligan') {
          await post({
            room: 'SERIES',
            token: p.token,
            action: {
              t: 'choice',
              choiceId: view.choice.id,
              response: { kind: 'yesNo', value: true },
            },
          });
        }
      }
    }

    await post({ room: 'SERIES', token: a.token, action: { t: 'intent', intent: { t: 'concede' } } });

    /*
     * Every request rebuilds the game from its log and wraps the stored match in a
     * fresh tracker, so a guard held in tracker memory is empty on arrival. Polling
     * a finished game used to record the same win on every poll — two polls and one
     * concession took a best of three.
     */
    for (let i = 0; i < 5; i++) {
      await get({ room: 'SERIES', token: a.token, since: '-1', rev: '-1' });
      await get({ room: 'SERIES', token: b.token, since: '-1', rev: '-1' });
    }

    const snap = await get({ room: 'SERIES', token: b.token, since: '-1', rev: '-1' });
    const match = snap.body.match as {
      wins: Record<PlayerId, number>;
      history: unknown[];
      matchWinner: PlayerId | null;
      awaitingFirstChoiceFrom: PlayerId | null;
    };
    expect(match.wins).toEqual({ p1: 0, p2: 1 });
    expect(match.history).toHaveLength(1);
    // One game of a best of three is not a match, and the loser still gets to
    // choose play or draw for game two.
    expect(match.matchWinner).toBeNull();
    expect(match.awaitingFirstChoiceFrom).toBe('p1');
  });

  it('never sends a player the opponent hand or any library order', async () => {
    const a = await joinAs('ROOM5', 'alice');
    const b = await joinAs('ROOM5', 'bob');

    for (let i = 0; i < 6; i++) {
      for (const p of [a, b]) {
        const snap = await get({ room: 'ROOM5', token: p.token, since: '-1', rev: '-1' });
        const view = snap.body.view as { choice?: { id: string; kind: string } };
        if (view.choice?.kind === 'mulligan') {
          await post({
            room: 'ROOM5',
            token: p.token,
            action: {
              t: 'choice',
              choiceId: view.choice.id,
              response: { kind: 'yesNo', value: true },
            },
          });
        }
      }
    }

    const mine = await get({ room: 'ROOM5', token: a.token, since: '-1', rev: '-1' });
    const theirs = await get({ room: 'ROOM5', token: b.token, since: '-1', rev: '-1' });
    const myView = mine.body.view as { cards: Record<number, unknown> };
    const theirView = theirs.body.view as { hand: number[] };

    for (const iid of theirView.hand) {
      expect(myView.cards[iid]).toBeUndefined();
    }
    expect(JSON.stringify(mine.body)).not.toContain('"library":[');
  });

  it('answers a poll with "unchanged" when nothing has moved', async () => {
    const a = await joinAs('ROOM6', 'alice');
    await joinAs('ROOM6', 'bob');
    const first = await get({ room: 'ROOM6', token: a.token, since: '-1', rev: '-1' });
    const version = String(first.body.version);
    const rev = String(first.body.rev);

    const again = await get({ room: 'ROOM6', token: a.token, since: version, rev });
    expect(again.body).toEqual({ unchanged: true });
  });

  it('reports a rejected action but still returns the current state', async () => {
    const a = await joinAs('ROOM7', 'alice');
    await joinAs('ROOM7', 'bob');
    const r = await post({
      room: 'ROOM7',
      token: a.token,
      action: { t: 'intent', intent: { t: 'passPriority' } },
    });
    expect(r.code).toBe(200);
    // A mulligan is pending, so passing priority is not legal yet.
    expect(typeof r.body.error).toBe('string');
    expect(r.body.view).toBeDefined();
  });

  it('rejects a request with no room code', async () => {
    const r = await post({ name: 'nobody' });
    expect(r.code).toBe(400);
  });
});

describe('finding the Redis credentials', () => {
  it('takes the standard Vercel and Upstash variable names', () => {
    expect(
      redisConfigFromEnv({
        KV_REST_API_URL: 'https://example.upstash.io/',
        KV_REST_API_TOKEN: 'tok',
      } as NodeJS.ProcessEnv),
    ).toEqual({ url: 'https://example.upstash.io', token: 'tok' });

    expect(
      redisConfigFromEnv({
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'tok',
      } as NodeJS.ProcessEnv),
    ).toEqual({ url: 'https://example.upstash.io', token: 'tok' });
  });

  it('still finds them behind a custom prefix', () => {
    // Vercel's integration dialog offers a prefix field; choosing one renames
    // every variable, and used to leave the deployment silently on memory.
    expect(
      redisConfigFromEnv({
        STORAGE_KV_REST_API_URL: 'https://example.upstash.io',
        STORAGE_KV_REST_API_TOKEN: 'tok',
        SOME_OTHER_TOKEN: 'unrelated',
      } as NodeJS.ProcessEnv),
    ).toEqual({ url: 'https://example.upstash.io', token: 'tok' });
  });

  it('does not invent a store out of an unrelated variable', () => {
    expect(redisConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      redisConfigFromEnv({ KV_REST_API_URL: 'https://x.upstash.io' } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      redisConfigFromEnv({ GITHUB_TOKEN: 'x', PATH: '/usr/bin' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});
