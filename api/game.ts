import {
  applyAction,
  join,
  normaliseCode,
  snapshot,
  type RoomAction,
} from '../src/server/room';
import { getStore } from '../src/server/store';
import type { PlayerId } from '../src/engine/types';

/**
 * The online match, as a serverless function.
 *
 * A WebSocket server cannot run on Vercel, but this engine does not need one: a
 * game is fully determined by (seed, action log), so every request can rebuild the
 * game from the log, apply one action, and append it. Clients poll for changes,
 * which for a turn-based card game is both simple and cheap.
 *
 *   POST /api/game  { room, token?, name? }                 → join or rejoin
 *   POST /api/game  { room, token, action }                 → take an action
 *   GET  /api/game?room&token&since&rev                     → poll
 */

interface Req {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  url?: string;
}

interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

async function readBody(req: Req): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>;
  if (typeof req.body === 'string' && req.body.length > 0) {
    try {
      return JSON.parse(req.body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

/** Confirms the caller actually holds the seat they claim. */
async function authorise(
  code: string,
  token: string,
): Promise<{ seat: PlayerId } | { error: string }> {
  const meta = await getStore().getMeta(code);
  if (!meta) return { error: 'Unknown room' };
  const seat = (['p1', 'p2'] as PlayerId[]).find((s) => meta.seats[s]?.token === token);
  if (!seat) return { error: 'Not a player in this room' };
  return { seat };
}

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const store = getStore();

    // ---- poll -------------------------------------------------------------
    if (req.method === 'GET') {
      const code = normaliseCode(firstParam(req.query?.room));
      const token = firstParam(req.query?.token);
      const since = Number(firstParam(req.query?.since) ?? -1);
      const sinceRev = Number(firstParam(req.query?.rev) ?? -1);
      if (!code) return void res.status(400).json({ error: 'A room code is required' });

      const auth = await authorise(code, token);
      if ('error' in auth) return void res.status(403).json({ error: auth.error });

      const snap = await snapshot(store, code, auth.seat);
      if (!snap) return void res.status(404).json({ error: 'Unknown room' });
      // The state is a pure function of the log, so its length is a perfect etag.
      if (snap.version === since && snap.rev === sinceRev) {
        return void res.status(200).json({ unchanged: true });
      }
      return void res.status(200).json(snap);
    }

    if (req.method !== 'POST') {
      return void res.status(405).json({ error: 'Method not allowed' });
    }

    const body = await readBody(req);
    const code = normaliseCode(String(body.room ?? ''));
    if (!code) return void res.status(400).json({ error: 'A room code is required' });
    const token = typeof body.token === 'string' ? body.token : undefined;

    // ---- join / rejoin ----------------------------------------------------
    if (!body.action) {
      const result = await join(store, code, {
        token,
        name: typeof body.name === 'string' ? body.name : undefined,
      });
      if ('error' in result) return void res.status(409).json({ error: result.error });
      const snap = await snapshot(store, code, result.seat);
      return void res.status(200).json({ ...snap, token: result.token, room: code });
    }

    // ---- act --------------------------------------------------------------
    if (!token) return void res.status(403).json({ error: 'Missing seat token' });
    const auth = await authorise(code, token);
    if ('error' in auth) return void res.status(403).json({ error: auth.error });

    const outcome = await applyAction(store, code, auth.seat, body.action as RoomAction);
    const snap = await snapshot(
      store,
      code,
      auth.seat,
      outcome.ok ? { events: outcome.events } : {},
    );
    if (!snap) return void res.status(404).json({ error: 'Unknown room' });
    // A rejected action still returns the current state, so the client can never be
    // left showing a board the server does not agree with.
    return void res
      .status(200)
      .json({ ...snap, error: outcome.ok ? undefined : outcome.error });
  } catch (e) {
    return void res.status(500).json({ error: (e as Error).message });
  }
}
