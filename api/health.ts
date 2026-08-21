/**
 * Tells the client whether online play is actually usable here.
 *
 * The client probes this on load: if it answers, online goes over HTTP; if not,
 * it falls back to the WebSocket server. `durable` is the important field —
 * without a Redis store configured, serverless instances do not share memory and
 * a match would be lost between requests, so the lobby says so instead of failing
 * mysteriously.
 *
 * Nothing is imported at the top of this file on purpose. A health check that
 * cannot load is worse than useless: it is exactly the case the client needs to
 * hear about, and a static import failure would take the whole function down with
 * a blank 500 instead. Everything is loaded inside the try below.
 */

interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

export default async function handler(_req: unknown, res: Res): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const serverless = Boolean(process.env.VERCEL ?? process.env.AWS_LAMBDA_FUNCTION_NAME);
  try {
    const [{ MAINDECK_SIZE }, { getStore }] = await Promise.all([
      import('../src/engine/deck'),
      import('../src/server/store'),
    ]);
    const store = getStore();
    res.status(200).json({
      ok: true,
      online: true,
      store: store.kind,
      durable: store.kind === 'redis',
      serverless,
      usable: store.kind === 'redis' || !serverless,
      deckSize: MAINDECK_SIZE,
    });
  } catch (e) {
    // The engine could not be loaded here at all. Say so in a shape the client
    // understands, and include the reason: this is the only place it can surface.
    res.status(200).json({
      ok: false,
      online: false,
      serverless,
      usable: false,
      node: process.version,
      error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e),
    });
  }
}
