import { Game, type Intent } from '@engine/game';
import { MAINDECK } from '@engine/deck';
import { redact, type PlayerView } from '@engine/redact';
import { MatchTracker, type MatchState } from '@engine/match';
import { stageScenario, type ScenarioSpec } from '@engine/scenario';
import type { ChoiceResponse, GameEvent, PlayerId } from '@engine/types';

/**
 * The client talks to the game through this interface and nothing else.
 *
 * LocalConnection runs the engine in the browser (practice, hotseat, lab mode).
 * RemoteConnection talks to the authoritative server. Both hand back the same
 * redacted PlayerView, so no component ever needs to know which one it is using —
 * and local play cannot accidentally see more than online play would show.
 */
export interface Connection {
  readonly kind: 'local' | 'remote';
  /** Seats this client is allowed to act for. */
  seats(): PlayerId[];
  view(seat: PlayerId): PlayerView | null;
  /** Events since the last drain, for animations and the known-top tracker. */
  drainEvents(): GameEvent[];
  submitIntent(seat: PlayerId, intent: Intent): void;
  submitChoice(seat: PlayerId, choiceId: string, response: ChoiceResponse): void;
  cancel(seat: PlayerId): boolean;
  /** Best-of-three state, or null when this connection is not running a match. */
  match(): MatchState | null;
  /** The loser of the previous game picks who is on the play. */
  chooseFirst(seat: PlayerId, onPlay: PlayerId): void;
  subscribe(cb: () => void): () => void;
  /** Human readable problem with the last action, if any. */
  lastError(): string | null;
  clearError(): void;
  dispose(): void;
}

abstract class BaseConnection implements Connection {
  abstract readonly kind: 'local' | 'remote';
  protected listeners = new Set<() => void>();
  protected error: string | null = null;

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  protected notify(): void {
    for (const cb of this.listeners) cb();
  }

  lastError(): string | null {
    return this.error;
  }

  clearError(): void {
    if (this.error !== null) {
      this.error = null;
      this.notify();
    }
  }

  abstract seats(): PlayerId[];
  abstract view(seat: PlayerId): PlayerView | null;
  abstract drainEvents(): GameEvent[];
  abstract submitIntent(seat: PlayerId, intent: Intent): void;
  abstract submitChoice(seat: PlayerId, choiceId: string, response: ChoiceResponse): void;
  abstract cancel(seat: PlayerId): boolean;
  abstract match(): MatchState | null;
  abstract chooseFirst(seat: PlayerId, onPlay: PlayerId): void;
  dispose(): void {
    this.listeners.clear();
  }
}

export interface LocalOptions {
  seed: number;
  startingPlayer: PlayerId;
  /** Which seats the human is playing. Lab mode controls both. */
  seats: PlayerId[];
  /** Skip mulligans and deal seven — handy for a quick practice game. */
  skipMulligans?: boolean;
  /** Stage a specific board instead of dealing opening hands. */
  scenario?: ScenarioSpec;
}

export class LocalConnection extends BaseConnection {
  readonly kind = 'local';
  game: Game;
  private events: GameEvent[] = [];
  private mySeats: PlayerId[];
  private tracker: MatchTracker | null;

  constructor(private opts: LocalOptions) {
    super();
    this.mySeats = opts.seats;
    // A drill is a single position, not a series.
    this.tracker = opts.scenario ? null : new MatchTracker(opts.startingPlayer);
    this.game = Game.create({
      gameId: `local-${opts.seed}`,
      seed: opts.seed,
      deck: MAINDECK,
      startingPlayer: opts.scenario?.startingPlayer ?? opts.startingPlayer,
      bare: Boolean(opts.skipMulligans || opts.scenario),
    });
    if (opts.scenario) {
      stageScenario(this.game, opts.scenario);
    } else if (opts.skipMulligans) {
      // Deal opening hands without the mulligan flow.
      this.game.draw('p1', 7);
      this.game.draw('p2', 7);
      this.game.flushEvents();
    }
    this.game.advance();
    this.collect();
  }

  private collect(): void {
    this.events.push(...this.game.flushEvents());
    this.tracker?.noteResult(this.game);
  }

  match(): MatchState | null {
    return this.tracker?.state ?? null;
  }

  chooseFirst(seat: PlayerId, onPlay: PlayerId): void {
    if (!this.tracker) return;
    const chosen = this.tracker.chooseFirst(seat, onPlay);
    if (chosen === null) return;
    // A new game in the same series: fresh shuffle, same decks.
    this.opts = { ...this.opts, seed: this.opts.seed + this.tracker.state.gameNumber * 7919 };
    this.game = Game.create({
      gameId: `local-${this.opts.seed}-g${this.tracker.state.gameNumber}`,
      seed: this.opts.seed,
      deck: MAINDECK,
      startingPlayer: chosen,
    });
    this.game.advance();
    this.events = [];
    this.collect();
    this.notify();
  }

  seats(): PlayerId[] {
    return this.mySeats;
  }

  view(seat: PlayerId): PlayerView {
    return redact(this.game.state, seat);
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  submitIntent(seat: PlayerId, intent: Intent): void {
    try {
      this.game.submitIntent(seat, intent);
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.collect();
    this.notify();
  }

  submitChoice(seat: PlayerId, choiceId: string, response: ChoiceResponse): void {
    try {
      this.game.submitChoice(seat, choiceId, response);
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.collect();
    this.notify();
  }

  cancel(seat: PlayerId): boolean {
    const ok = this.game.cancelPendingAction(seat);
    this.collect();
    this.notify();
    return ok;
  }

  restart(seed = this.opts.seed + 1): void {
    this.opts = { ...this.opts, seed };
    const next = new LocalConnection(this.opts);
    this.game = next.game;
    this.events = next.drainEvents();
    this.notify();
  }
}

// ---------------------------------------------------------------------------
// Online over HTTP (Vercel and anything else without a socket server)
// ---------------------------------------------------------------------------

export interface OnlineCapability {
  /** An HTTP match API is reachable. */
  http: boolean;
  /** State survives between requests. False means a single process only. */
  durable: boolean;
}

/**
 * Decides how online play should work here.
 *
 * A serverless host cannot hold a WebSocket open, so the HTTP API is preferred
 * wherever it exists. The plain Vite dev server has no /api, so there we fall back
 * to the standalone socket server.
 */
export async function probeOnline(): Promise<OnlineCapability> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return { http: false, durable: false };
    const json = (await res.json()) as { ok?: boolean; durable?: boolean };
    return { http: Boolean(json.ok), durable: Boolean(json.durable) };
  } catch {
    return { http: false, durable: false };
  }
}

interface Snapshot {
  seat: PlayerId;
  version: number;
  rev: number;
  view: PlayerView;
  match: MatchState;
  events: GameEvent[];
  players: { seat: PlayerId; name: string }[];
  ready: boolean;
  token?: string;
  error?: string;
  unchanged?: boolean;
}

export interface HttpOptions {
  room: string;
  playerName: string;
  /** How often to look for the opponent's move. */
  pollMs?: number;
}

export class HttpConnection extends BaseConnection {
  readonly kind = 'remote';
  private seat: PlayerId | null = null;
  private token: string | null = null;
  private currentView: PlayerView | null = null;
  private matchState: MatchState | null = null;
  private events: GameEvent[] = [];
  private version = -1;
  private rev = -1;
  private timer: number | null = null;
  private stopped = false;
  private inFlight = false;
  lobby: { players: { seat: PlayerId; name: string }[]; ready: boolean } = {
    players: [],
    ready: false,
  };
  status: 'connecting' | 'open' | 'closed' = 'connecting';

  constructor(private opts: HttpOptions) {
    super();
    void this.joinRoom();
  }

  private tokenKey(): string {
    return `satm.seat.${this.opts.room}`;
  }

  private loadToken(): string | undefined {
    try {
      return localStorage.getItem(this.tokenKey()) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private saveToken(token: string): void {
    try {
      localStorage.setItem(this.tokenKey(), token);
    } catch {
      // Losing the token only costs seat recovery.
    }
  }

  private async post(body: Record<string, unknown>): Promise<Snapshot | null> {
    const res = await fetch('/api/game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: this.opts.room, token: this.token ?? undefined, ...body }),
    });
    const json = (await res.json().catch(() => ({}))) as Snapshot & { error?: string };
    if (!res.ok) {
      this.error = json.error ?? `Request failed (${res.status})`;
      this.notify();
      return null;
    }
    return json;
  }

  private absorb(snap: Snapshot | null): void {
    if (!snap || snap.unchanged) return;
    if (snap.token) {
      this.token = snap.token;
      this.saveToken(snap.token);
    }
    if (snap.seat) this.seat = snap.seat;
    this.currentView = snap.view;
    this.matchState = snap.match;
    this.version = snap.version;
    this.rev = snap.rev;
    this.lobby = { players: snap.players ?? [], ready: Boolean(snap.ready) };
    if (snap.events?.length) this.events.push(...snap.events);
    this.error = snap.error ?? null;
    this.status = 'open';
    this.notify();
  }

  private async joinRoom(): Promise<void> {
    this.token = this.loadToken() ?? null;
    const snap = await this.post({ name: this.opts.playerName });
    this.absorb(snap);
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, this.opts.pollMs ?? 800);
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.inFlight || !this.seat || !this.token) {
      this.schedulePoll();
      return;
    }
    this.inFlight = true;
    try {
      const url = `/api/game?room=${encodeURIComponent(this.opts.room)}&token=${encodeURIComponent(
        this.token,
      )}&since=${this.version}&rev=${this.rev}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const json = (await res.json()) as Snapshot;
        this.absorb(json);
      } else {
        this.status = 'closed';
      }
    } catch {
      // A dropped poll is not fatal; the next one picks the state back up.
      this.status = 'closed';
    } finally {
      this.inFlight = false;
      this.schedulePoll();
    }
  }

  private async act(action: unknown): Promise<void> {
    this.absorb(await this.post({ action }));
  }

  seats(): PlayerId[] {
    return this.seat ? [this.seat] : [];
  }

  view(seat: PlayerId): PlayerView | null {
    return this.seat === seat ? this.currentView : null;
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  submitIntent(_seat: PlayerId, intent: Intent): void {
    void this.act({ t: 'intent', intent });
  }

  submitChoice(_seat: PlayerId, choiceId: string, response: ChoiceResponse): void {
    void this.act({ t: 'choice', choiceId, response });
  }

  cancel(): boolean {
    void this.act({ t: 'cancel' });
    return true;
  }

  match(): MatchState | null {
    return this.matchState;
  }

  chooseFirst(_seat: PlayerId, onPlay: PlayerId): void {
    void this.act({ t: 'chooseFirst', onPlay });
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    super.dispose();
  }
}

// ---------------------------------------------------------------------------
// Online over WebSocket (self-hosted server)
// ---------------------------------------------------------------------------

export interface RemoteOptions {
  url: string;
  room: string;
  playerName: string;
}

type ServerMsg =
  | { t: 'seat'; seat: PlayerId; room: string; token: string }
  | { t: 'view'; view: PlayerView; events: GameEvent[] }
  | { t: 'match'; match: MatchState }
  | { t: 'error'; message: string }
  | { t: 'lobby'; players: { seat: PlayerId; name: string }[]; ready: boolean };

export class RemoteConnection extends BaseConnection {
  readonly kind = 'remote';
  private ws: WebSocket | null = null;
  private seat: PlayerId | null = null;
  private currentView: PlayerView | null = null;
  private events: GameEvent[] = [];
  private reconnectTimer: number | null = null;
  private closed = false;
  private matchState: MatchState | null = null;
  lobby: { players: { seat: PlayerId; name: string }[]; ready: boolean } = {
    players: [],
    ready: false,
  };
  status: 'connecting' | 'open' | 'closed' = 'connecting';

  constructor(private opts: RemoteOptions) {
    super();
    this.open();
  }

  private open(): void {
    this.status = 'connecting';
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.status = 'open';
      // The token is what makes a reconnect land back in the same seat rather than
      // being treated as a third player.
      ws.send(
        JSON.stringify({
          t: 'join',
          room: this.opts.room,
          name: this.opts.playerName,
          token: this.savedToken(),
        }),
      );
      this.notify();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMsg;
      switch (msg.t) {
        case 'seat':
          this.seat = msg.seat;
          this.saveToken(msg.token);
          break;
        case 'view':
          this.currentView = msg.view;
          this.events.push(...msg.events);
          break;
        case 'match':
          this.matchState = msg.match;
          break;
        case 'lobby':
          this.lobby = { players: msg.players, ready: msg.ready };
          break;
        case 'error':
          this.error = msg.message;
          break;
      }
      this.notify();
    };
    ws.onclose = () => {
      this.status = 'closed';
      this.notify();
      // The server replays the action log on reconnect, so this is safe to retry.
      if (!this.closed && this.reconnectTimer === null) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.open();
        }, 1500);
      }
    };
    ws.onerror = () => {
      this.error = 'Connection problem';
      this.notify();
    };
  }

  private tokenKey(): string {
    return `satm.seat.${this.opts.room}`;
  }

  private savedToken(): string | undefined {
    try {
      return localStorage.getItem(this.tokenKey()) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private saveToken(token: string): void {
    try {
      localStorage.setItem(this.tokenKey(), token);
    } catch {
      // Storage being unavailable only costs us seat recovery, not the game.
    }
  }

  /** Which seat the server gave us, or null while still joining. */
  mySeat(): PlayerId | null {
    return this.seat;
  }

  seats(): PlayerId[] {
    return this.seat ? [this.seat] : [];
  }

  view(seat: PlayerId): PlayerView | null {
    return this.seat === seat ? this.currentView : null;
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  submitIntent(_seat: PlayerId, intent: Intent): void {
    this.send({ t: 'intent', intent });
  }

  rematch(): void {
    this.send({ t: 'rematch' });
  }

  match(): MatchState | null {
    return this.matchState;
  }

  chooseFirst(_seat: PlayerId, onPlay: PlayerId): void {
    this.send({ t: 'chooseFirst', onPlay });
  }

  submitChoice(_seat: PlayerId, choiceId: string, response: ChoiceResponse): void {
    this.send({ t: 'choice', choiceId, response });
  }

  cancel(): boolean {
    this.send({ t: 'cancel' });
    return true;
  }

  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
    super.dispose();
  }
}
