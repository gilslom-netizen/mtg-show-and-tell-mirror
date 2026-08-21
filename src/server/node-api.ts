import type { IncomingMessage, ServerResponse } from 'node:http';
import apiGame from '../../api/game';
import apiHealth from '../../api/health';

/**
 * The /api routes, as plain Node middleware.
 *
 * The serverless deployment runs `api/*.ts` directly; the self-hosted server and
 * the Vite dev server run them through here. One code path for all three is the
 * whole point: online play used to work on Vercel and silently not work under
 * `npm run dev`, which is exactly the kind of difference that costs an evening.
 */

interface Shim {
  status(code: number): Shim;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

function adapt(res: ServerResponse, url: URL): { shim: Shim; query: Record<string, string> } {
  const shim: Shim = {
    status(code: number) {
      res.statusCode = code;
      return shim;
    },
    json(body: unknown) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value);
    },
  };
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (query[k] = v));
  return { shim, query };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

/** Handles the request if it is an /api route. Returns false to let it fall through. */
export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/health') {
    const { shim } = adapt(res, url);
    await apiHealth({}, shim);
    return true;
  }
  if (url.pathname === '/api/game') {
    const { shim, query } = adapt(res, url);
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    await apiGame({ method: req.method, query, body }, shim);
    return true;
  }
  return false;
}
