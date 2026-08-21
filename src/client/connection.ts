import { Game, type Intent } from '@engine/game';
import { MAINDECK } from '@engine/deck';
import { redact, type PlayerView } from '@engine/redact';
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

  constructor(private opts: LocalOptions) {
    super();
    this.mySeats = opts.seats;
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
// Remote
// ---------------------------------------------------------------------------

export interface RemoteOptions {
  url: string;
  room: string;
  playerName: string;
}

type ServerMsg =
  | { t: 'seat'; seat: PlayerId; room: string; token: string }
  | { t: 'view'; view: PlayerView; events: GameEvent[] }
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
