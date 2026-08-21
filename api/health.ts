import { MAINDECK_SIZE } from '../src/engine/deck';
import { getStore } from '../src/server/store';

/**
 * Tells the client whether online play is actually usable here.
 *
 * The client probes this on load: if it answers, online goes over HTTP; if not
 * (running against the plain Vite dev server) it falls back to the WebSocket
 * server. `durable` is the important field — without a Redis store configured,
 * serverless instances do not share memory and a match would be lost between
 * requests, so the lobby says so instead of failing mysteriously.
 */

interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

export default function handler(_req: unknown, res: Res): void {
  const store = getStore();
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    online: true,
    store: store.kind,
    durable: store.kind === 'redis',
    deckSize: MAINDECK_SIZE,
  });
}
