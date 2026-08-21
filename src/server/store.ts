import type { Intent } from '../engine/game.js';
import type { MatchState } from '../engine/match.js';
import type { ChoiceResponse, PlayerId } from '../engine/types.js';

/**
 * Where an online match lives between requests.
 *
 * On Vercel every request is a fresh process, so nothing can be kept in memory.
 * That would normally be a problem for a game engine — except this one is fully
 * determined by (seed, action log), so the only thing that has to survive is the
 * log. Each request rebuilds the game by replaying it.
 *
 * The log is a Redis list and actions are appended with RPUSH, which is atomic.
 * That matters for exactly one moment in this format: the Show and Tell secret
 * choice, where both players legitimately act at the same instant. Redis decides
 * the order and the engine is happy with either.
 */

export type LoggedAction =
  | { k: 'intent'; seat: PlayerId; intent: Intent }
  | { k: 'choice'; seat: PlayerId; choiceId: string; response: ChoiceResponse };

export interface RoomMeta {
  code: string;
  /** Seed of the game the current log belongs to. */
  seed: number;
  startingPlayer: PlayerId;
  /** Seat tokens, so a returning player lands back in their own seat. */
  seats: Partial<Record<PlayerId, { token: string; name: string }>>;
  /** Series state. Survives across games; the log does not. */
  match: MatchState;
  createdAt: number;
  /** Bumped whenever meta changes, so a poll can notice a new game starting. */
  rev: number;
}

export interface MatchStore {
  readonly kind: 'redis' | 'memory';
  getMeta(code: string): Promise<RoomMeta | null>;
  setMeta(code: string, meta: RoomMeta): Promise<void>;
  getLog(code: string): Promise<LoggedAction[]>;
  appendAction(code: string, action: LoggedAction): Promise<number>;
  popAction(code: string): Promise<void>;
  clearLog(code: string): Promise<void>;
  logLength(code: string): Promise<number>;
}

const TTL_SECONDS = 60 * 60 * 24 * 3;

// ---------------------------------------------------------------------------
// Upstash / Vercel KV over REST — no client library, just fetch
// ---------------------------------------------------------------------------

interface RedisConfig {
  url: string;
  token: string;
}

export function redisConfigFromEnv(env = process.env): RedisConfig | null {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

class RedisStore implements MatchStore {
  readonly kind = 'redis';
  constructor(private cfg: RedisConfig) {}

  private async command<T>(args: (string | number)[]): Promise<T> {
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Store error ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { result: T; error?: string };
    if (json.error) throw new Error(json.error);
    return json.result;
  }

  async getMeta(code: string): Promise<RoomMeta | null> {
    const raw = await this.command<string | null>(['GET', `satm:${code}:meta`]);
    return raw ? (JSON.parse(raw) as RoomMeta) : null;
  }

  async setMeta(code: string, meta: RoomMeta): Promise<void> {
    await this.command(['SET', `satm:${code}:meta`, JSON.stringify(meta), 'EX', TTL_SECONDS]);
  }

  async getLog(code: string): Promise<LoggedAction[]> {
    const raw = await this.command<string[]>(['LRANGE', `satm:${code}:log`, 0, -1]);
    return (raw ?? []).map((s) => JSON.parse(s) as LoggedAction);
  }

  async appendAction(code: string, action: LoggedAction): Promise<number> {
    const len = await this.command<number>(['RPUSH', `satm:${code}:log`, JSON.stringify(action)]);
    await this.command(['EXPIRE', `satm:${code}:log`, TTL_SECONDS]);
    return len;
  }

  async popAction(code: string): Promise<void> {
    await this.command(['RPOP', `satm:${code}:log`]);
  }

  async clearLog(code: string): Promise<void> {
    await this.command(['DEL', `satm:${code}:log`]);
  }

  async logLength(code: string): Promise<number> {
    return (await this.command<number>(['LLEN', `satm:${code}:log`])) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// In-process fallback
// ---------------------------------------------------------------------------

/**
 * Only correct while a single process serves every request — the standalone
 * WebSocket server, or `vercel dev`. On real serverless it would silently lose
 * games, so /api/health reports which store is in use and the client says so.
 */
class MemoryStore implements MatchStore {
  readonly kind = 'memory';
  private meta = new Map<string, RoomMeta>();
  private logs = new Map<string, LoggedAction[]>();

  async getMeta(code: string) {
    return this.meta.get(code) ?? null;
  }
  async setMeta(code: string, meta: RoomMeta) {
    this.meta.set(code, meta);
  }
  async getLog(code: string) {
    return [...(this.logs.get(code) ?? [])];
  }
  async appendAction(code: string, action: LoggedAction) {
    const list = this.logs.get(code) ?? [];
    list.push(action);
    this.logs.set(code, list);
    return list.length;
  }
  async popAction(code: string) {
    this.logs.get(code)?.pop();
  }
  async clearLog(code: string) {
    this.logs.set(code, []);
  }
  async logLength(code: string) {
    return (this.logs.get(code) ?? []).length;
  }
}

let cached: MatchStore | null = null;

export function getStore(): MatchStore {
  if (cached) return cached;
  const cfg = redisConfigFromEnv();
  cached = cfg ? new RedisStore(cfg) : new MemoryStore();
  return cached;
}

/** For tests. */
export function setStore(store: MatchStore | null): void {
  cached = store;
}
