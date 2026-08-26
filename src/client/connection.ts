import { Game, type Intent } from '@engine/game';
import { MAINDECK } from '@engine/deck';
import { redact, type PlayerView } from '@engine/redact';
import { MatchTracker, seriesLength, type MatchState } from '@engine/match';
import { stageScenario, type ScenarioSpec } from '@engine/scenario';
import type { ChoiceResponse, GameEvent, PlayerId } from '@engine/types';
import type { DeckEntry } from '@engine/state';
import type { DraftView } from '../draft/redact';
import type { DraftAction } from '../draft/types';
import type { Agent } from '../ai/agent';
import { recordPlayed, type RecordedAction } from './history';

/** What the lobby and the waiting screen need to show while nothing is playable yet. */
export interface ConnectionInfo {
  kind: 'local' | 'remote';
  /** Room code, for online connections. */
  room?: string;
  status: 'connecting' | 'open' | 'closed';
  /** Who is currently sitting in the room. */
  players: { seat: PlayerId; name: string }[];
  /** Both seats are filled. */
  ready: boolean;
}

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
  /** Connection state for the lobby and the waiting screen. */
  info(): ConnectionInfo;
  /** Which of draft, deckbuilding or playing this session is doing. */
  phase(): SessionPhase;
  /** The draft as this seat may see it, while drafting. */
  draftView(seat: PlayerId): DraftView | null;
  submitDraftAction(seat: PlayerId, action: DraftAction): void;
  /** What this seat may build with, while deckbuilding. */
  cardPool(seat: PlayerId): CardPool | null;
  /** Who has already locked a list in. */
  deckReady(): PlayerId[];
  submitDeck(seat: PlayerId, deck: DeckEntry[]): void;
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

  info(): ConnectionInfo {
    return { kind: this.kind, status: 'open', players: [], ready: true };
  }

  // A connection that does not draft is always in the game phase; the draft
  // members exist so no component has to know which kind it is holding.
  phase(): SessionPhase {
    return 'game';
  }

  draftView(_seat: PlayerId): DraftView | null {
    return null;
  }

  submitDraftAction(_seat: PlayerId, _action: DraftAction): void {}

  cardPool(_seat: PlayerId): CardPool | null {
    return null;
  }

  deckReady(): PlayerId[] {
    return [];
  }

  submitDeck(_seat: PlayerId, _deck: DeckEntry[]): void {}

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
  /** Length of the series: 1, 3 or 5. A drill ignores it — it is one position. */
  bestOf?: number;
  /**
   * Plays any seat the human is not.
   *
   * It lives on the connection rather than in a component because that is what it
   * is: the other player. The store refuses to act for a seat this client does not
   * own, and rightly — so an opponent driven from the client would either be
   * ignored or would require handing the human both seats and trusting the UI not
   * to show them the second one. Here it sits on the far side of the same seam the
   * server sits behind, is handed `redact(state, seat)` exactly as a remote player
   * would be, and cannot be acted for from the board at all.
   */
  opponent?: Agent;
}

/** What the opponent is told it has to think in. The heuristic does not need it. */
const OPPONENT_BUDGET_MS = 250;

/**
 * How long it waits before answering.
 *
 * The same randomised window the auto-pass layer uses, for the same reason pointed
 * the other way: an opponent that replied instantly when it had nothing and paused
 * when it was thinking would be readable off the clock.
 */
const OPPONENT_DELAY_MS: [number, number] = [220, 600];

export class LocalConnection extends BaseConnection {
  readonly kind = 'local';
  game: Game;
  private events: GameEvent[] = [];
  private mySeats: PlayerId[];
  private tracker: MatchTracker | null;
  /** Polls for a move the opponent owes. Runs only while there is an opponent. */
  private aiTicker: number | null = null;
  /** When the opponent's next move is due, or 0 when nothing is owed. */
  private aiNextAt = 0;
  /** Every action of this game, in order — the whole game, in a few KB. */
  private log: RecordedAction[] = [];
  /**
   * How long the log was when the engine last took its Esc snapshot, and for whom.
   *
   * Esc rewinds the engine to a snapshot the engine chose. The log has to rewind to
   * *that* point and not to one of its own choosing, or the two stop describing the
   * same game — and a log that no longer replays is not a record, it is a story
   * about one. The engine snapshots exactly when a seat is left holding priority
   * with nothing pending, which is a moment this side can see too.
   */
  private rollbackLogLength: number | null = null;
  private rollbackSeat: PlayerId | null = null;
  /** Guards against writing the same finished game down twice. */
  private saved = false;

  constructor(private opts: LocalOptions) {
    super();
    this.mySeats = opts.seats;
    // A drill is a single position, not a series.
    this.tracker = opts.scenario
      ? null
      : new MatchTracker(opts.startingPlayer, seriesLength(opts.bestOf));
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
    this.startOpponentLoop();
  }

  private collect(): void {
    this.events.push(...this.game.flushEvents());
    /*
     * The same condition `advance()` uses before taking its rollback snapshot: a
     * seat is waiting on priority with nothing pending. Marking the log here is what
     * keeps the two rewinds identical rather than merely similar.
     */
    const s = this.game.state;
    if (s.winner === null && s.pendingChoice === null && s.priorityPlayer !== null) {
      this.rollbackLogLength = this.log.length;
      this.rollbackSeat = s.priorityPlayer;
    }
    const recorded = this.tracker?.noteResult(this.game);
    // `noteResult` is true on the first call that sees this game finished, which is
    // exactly once — so this is the hook for "a game just ended" without polling.
    if (recorded) this.savePlayed();
    // A drill has no tracker and no series, but it is still a game that was played.
    if (!this.tracker && this.game.state.winner !== null && !this.saved) this.savePlayed();
  }

  /**
   * Write the finished game down, as `(seed, starting player, action log)`.
   *
   * Not a summary: replaying that log reproduces the game exactly, so a run of
   * evenings is something that can be examined afterwards rather than remembered.
   */
  private savePlayed(): void {
    if (this.saved) return;
    this.saved = true;
    const s = this.game.state;
    recordPlayed({
      at: Date.now(),
      seat: this.mySeats[0] ?? 'p1',
      opponent: this.opts.opponent?.name ?? (this.mySeats.length > 1 ? 'hotseat' : 'none'),
      seed: this.opts.seed,
      startingPlayer: this.opts.scenario?.startingPlayer ?? this.opts.startingPlayer,
      winner: s.winner,
      reason: s.endReason,
      turns: s.turn,
      actions: this.log,
    });
  }

  // --- the computer's seat --------------------------------------------------

  /** Which seat, if any, the opponent currently owes an action for. */
  private opponentOwes(): PlayerId | null {
    if (!this.opts.opponent) return null;
    const theirs = (['p1', 'p2'] as PlayerId[]).filter((p) => !this.mySeats.includes(p));

    /*
     * Play or draw, after a game of a series.
     *
     * Checked before the game-over test below, because that is exactly when it is
     * asked: the game has a winner and the loser owes a decision. It is a decision
     * like any other and the match cannot continue without it — so when the computer
     * lost the previous game and nothing answered for it, a best-of-three simply
     * stopped, with a screen that was waiting for somebody who was never asked.
     */
    const awaiting = this.tracker?.state.awaitingFirstChoiceFrom ?? null;
    if (awaiting !== null) return theirs.includes(awaiting) ? awaiting : null;

    const s = this.game.state;
    if (s.winner !== null) return null;

    const pc = s.pendingChoice;
    if (pc) {
      // Mulligan and Show and Tell are asked of both players at once, and either
      // may still owe an answer.
      if (pc.kind === 'mulligan' || pc.kind === 'simultaneousSecret') {
        return theirs.find((p) => pc.awaiting.includes(p)) ?? null;
      }
      return theirs.includes(pc.player) ? pc.player : null;
    }
    return s.priorityPlayer !== null && theirs.includes(s.priorityPlayer)
      ? s.priorityPlayer
      : null;
  }

  /**
   * A ticker rather than a timer per move, and the difference matters.
   *
   * The first version scheduled one `setTimeout` per action and used "a timer is
   * already set" as the guard against scheduling two. That makes the timer id a
   * mutex, and a mutex that is only ever released by its own callback: if the
   * callback is lost — a hot reload, a disposed instance, anything — the opponent
   * stops playing for the rest of the game and nothing says so. It happened within
   * a few minutes of writing it, and from the board it is indistinguishable from an
   * opponent thinking.
   *
   * A poll cannot wedge, because the next tick does not depend on the last one
   * having run. It also means no call site has to remember to schedule anything:
   * the loop notices the opponent owes a move, whatever caused that.
   */
  private startOpponentLoop(): void {
    if (!this.opts.opponent || this.aiTicker !== null) return;
    this.aiTicker = setInterval(() => this.opponentTick(), 100) as unknown as number;
  }

  private opponentTick(): void {
    if (this.opponentOwes() === null) {
      // Nothing owed: forget any countdown so the next move is timed from when it
      // actually became theirs to make.
      this.aiNextAt = 0;
      return;
    }
    /*
     * The pause exists so the opponent is not readable off the clock, which only
     * means anything to somebody watching it. In a hidden tab there is nobody, and
     * paying it there is actively bad: a background tab has its timers clamped to
     * roughly one a second and eventually far less, so a delay spread over several
     * ticks can leave someone who switched away mid-turn coming back to an opponent
     * that appears to have stopped playing.
     *
     * No document at all — a test, or anything running this outside a page — counts
     * as unwatched for the same reason. Reading `document.hidden` unguarded there
     * threw on every tick, a hundred times a second, and the opponent never moved.
     */
    if (typeof document === 'undefined' || document.hidden) {
      this.aiNextAt = 0;
      this.runOpponent();
      return;
    }
    const now = Date.now();
    if (this.aiNextAt === 0) {
      const [lo, hi] = OPPONENT_DELAY_MS;
      this.aiNextAt = now + lo + Math.random() * (hi - lo);
      return;
    }
    if (now < this.aiNextAt) return;
    this.aiNextAt = 0;
    this.runOpponent();
  }

  private runOpponent(): void {
    const agent = this.opts.opponent;
    // Re-derived rather than captured: a shared choice can resolve between the
    // timer being set and it firing.
    const seat = this.opponentOwes();
    if (!agent || !seat) return;

    // Play or draw comes from the match, not from the game — there is no view to
    // redact for it and no priority to hold.
    const awaiting = this.tracker?.state.awaitingFirstChoiceFrom ?? null;
    if (awaiting === seat) {
      const onPlay = agent.chooseFirst?.(this.tracker!.state, seat) ?? seat;
      this.chooseFirst(seat, onPlay);
      return;
    }

    const view = redact(this.game.state, seat);
    try {
      if (view.choice) {
        const response = agent.respond(view, view.choice, OPPONENT_BUDGET_MS);
        this.game.submitChoice(seat, view.choice.id, response);
        this.log.push({ k: 'choice', seat, choiceId: view.choice.id, response });
      } else {
        const intent = agent.act(view, OPPONENT_BUDGET_MS);
        this.game.submitIntent(seat, intent);
        this.log.push({ k: 'intent', seat, intent });
      }
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.collect();
    this.notify();
    // Anything still owed is picked up by the next tick, including a whole chain of
    // triggers answered one after another.
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
    // A new game of the series: its own seed, and its own log to be written down.
    this.log = [];
    this.saved = false;
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
      this.log.push({ k: 'intent', seat, intent });
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
      this.log.push({ k: 'choice', seat, choiceId, response });
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.collect();
    this.notify();
  }

  cancel(seat: PlayerId): boolean {
    const ok = this.game.cancelPendingAction(seat);
    /*
     * Rewind the log to exactly where the engine rewound.
     *
     * The first version of this backed out "the answers given since, and the action
     * that asked for them", which sounds like the same thing and is not: the engine
     * goes back to a snapshot it took when the seat last held priority, and a cast
     * that has been passed on has *two* such moments behind it. Two games played
     * here could not be replayed afterwards because of that one word, which makes
     * the record worthless precisely when something interesting happened.
     */
    if (ok && this.rollbackSeat === seat && this.rollbackLogLength !== null) {
      this.log.length = Math.min(this.log.length, this.rollbackLogLength);
    }
    this.collect();
    this.notify();
    return ok;
  }

  restart(seed = this.opts.seed + 1): void {
    this.clearOpponentTimer();
    this.opts = { ...this.opts, seed };
    const next = new LocalConnection(this.opts);
    this.game = next.game;
    this.events = next.drainEvents();
    next.dispose();
    this.log = [];
    this.saved = false;
    this.notify();
    this.startOpponentLoop();
  }

  private clearOpponentTimer(): void {
    if (this.aiTicker === null) return;
    clearInterval(this.aiTicker);
    this.aiTicker = null;
    this.aiNextAt = 0;
  }

  dispose(): void {
    this.clearOpponentTimer();
    super.dispose();
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
  /** The API is running on a host whose instances share no memory. */
  serverless: boolean;
  /** Two people can actually meet in a room here. */
  usable: boolean;
}

const NO_ONLINE: OnlineCapability = {
  http: false,
  durable: false,
  serverless: false,
  usable: false,
};

/**
 * Decides how online play should work here.
 *
 * A serverless host cannot hold a WebSocket open, so the HTTP API is preferred
 * wherever it exists — and dev, self-host and Vercel all serve it now. The socket
 * transport is left as the fallback for a host that serves only static files.
 */
export async function probeOnline(): Promise<OnlineCapability> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return NO_ONLINE;
    // A static host answers every path with index.html, so a 200 proves nothing;
    // only a JSON body carrying our own flag does.
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      durable?: boolean;
      serverless?: boolean;
      usable?: boolean;
    } | null;
    if (!json?.ok) return NO_ONLINE;
    const durable = Boolean(json.durable);
    const serverless = Boolean(json.serverless);
    return {
      http: true,
      durable,
      serverless,
      usable: json.usable ?? (durable || !serverless),
    };
  } catch {
    return NO_ONLINE;
  }
}

export type SessionPhase = 'draft' | 'build' | 'game';

/** What a player may put in a deck: the shared mirror, their picks, their lands. */
export interface CardPool {
  base: DeckEntry[];
  drafted: DeckEntry[];
  lands: DeckEntry[];
}

interface Snapshot {
  seat: PlayerId;
  phase?: SessionPhase;
  draft?: DraftView;
  pool?: CardPool;
  deckReady?: PlayerId[];
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
  /** Only used by whoever opens the room; a joiner takes what is already set. */
  format?: 'classic' | 'draft';
  bestOf?: number;
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
  /** Consecutive polls that found nothing new. Drives the backoff. */
  private quiet = 0;
  private sessionPhase: SessionPhase = 'game';
  private draft: DraftView | null = null;
  private pool: CardPool | null = null;
  private ready: PlayerId[] = [];
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
    this.sessionPhase = snap.phase ?? 'game';
    this.draft = snap.draft ?? null;
    this.pool = snap.pool ?? null;
    this.ready = snap.deckReady ?? [];
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

  private onVisibility = (): void => {
    if (typeof document !== 'undefined' && !document.hidden) this.wake();
  };

  private async joinRoom(): Promise<void> {
    this.token = this.loadToken() ?? null;
    const snap = await this.post({
      name: this.opts.playerName,
      format: this.opts.format,
      bestOf: this.opts.bestOf,
    });
    this.absorb(snap);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    this.schedulePoll();
  }

  /**
   * How long to wait before looking again.
   *
   * Polling is the cost model here: every poll is a couple of Redis commands, and
   * a forgotten tab left open overnight would spend a free-tier month's budget
   * without a single card being played. So an idle room backs off, and a hidden
   * tab stops entirely — nobody is reading it.
   *
   * The backoff resets to fast on the first thing that actually happens, which is
   * what keeps the opponent's move feeling immediate: the fast rate is what you
   * are on whenever the game is moving.
   */
  private nextDelay(): number {
    const fast = this.opts.pollMs ?? 800;
    // A hidden tab has no reader. Keep the seat alive, spend almost nothing.
    if (typeof document !== 'undefined' && document.hidden) return 15000;
    // An opponent thinking is not idleness — staying fast for the first three
    // minutes of silence means the backoff never costs a move its responsiveness.
    if (this.quiet < 225) return fast;
    if (this.quiet < 500) return 3000;
    return 6000;
  }

  private schedulePoll(): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, this.nextDelay());
  }

  /** Come back to full speed at once — the player is here and something happened. */
  private wake(): void {
    this.quiet = 0;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
      this.schedulePoll();
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.inFlight || !this.seat || !this.token) {
      this.schedulePoll();
      return;
    }
    this.inFlight = true;
    const was = this.status;
    try {
      const url = `/api/game?room=${encodeURIComponent(this.opts.room)}&token=${encodeURIComponent(
        this.token,
      )}&since=${this.version}&rev=${this.rev}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const json = (await res.json()) as Snapshot;
        if (json.unchanged) this.quiet++;
        else this.quiet = 0;
        this.status = 'open';
        this.absorb(json);
      } else {
        this.status = 'closed';
      }
    } catch {
      // A dropped poll is not fatal; the next one picks the state back up.
      this.status = 'closed';
    } finally {
      this.inFlight = false;
      /*
       * Tell somebody. `absorb` is the only thing that notifies, and it returns
       * early on an unchanged poll and is never reached at all on a failed one —
       * so going offline was completely silent: the board simply stopped moving
       * and clicks stopped working, which is indistinguishable from an opponent
       * thinking. Coming back has to be announced too, so the warning clears.
       */
      if (this.status !== was) this.notify();
      this.schedulePoll();
    }
  }

  private async act(action: unknown): Promise<void> {
    this.wake();
    this.absorb(await this.post({ action }));
  }

  info(): ConnectionInfo {
    return {
      kind: 'remote',
      room: this.opts.room,
      status: this.status,
      players: this.lobby.players,
      ready: this.lobby.ready,
    };
  }

  phase(): SessionPhase {
    return this.sessionPhase;
  }

  draftView(seat: PlayerId): DraftView | null {
    return this.seat === seat ? this.draft : null;
  }

  submitDraftAction(_seat: PlayerId, action: DraftAction): void {
    void this.act({ t: 'draft', action });
  }

  cardPool(seat: PlayerId): CardPool | null {
    return this.seat === seat ? this.pool : null;
  }

  deckReady(): PlayerId[] {
    return this.ready;
  }

  submitDeck(_seat: PlayerId, deck: DeckEntry[]): void {
    void this.act({ t: 'submitDeck', deck });
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
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
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
  /** Only used by whoever opens the room; a joiner takes what is already set. */
  bestOf?: number;
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
  private everOpened = false;
  /** Consecutive failed connections, for the reconnect backoff. */
  private failedAttempts = 0;
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
      this.everOpened = true;
      this.failedAttempts = 0;
      // The token is what makes a reconnect land back in the same seat rather than
      // being treated as a third player.
      ws.send(
        JSON.stringify({
          t: 'join',
          room: this.opts.room,
          bestOf: this.opts.bestOf,
          name: this.opts.playerName,
          token: this.savedToken(),
        }),
      );
      this.notify();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        // Anything that is not our protocol — a proxy's error page, a stray
        // frame — is not worth taking the connection down over.
        return;
      }
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
      // Never having connected at all is a different problem from a dropped
      // connection, and it has a different fix — say which one this is.
      if (!this.everOpened) {
        this.error = `No game server answered at ${this.opts.url}. Run npm run selfhost and open the address it prints, or deploy where /api is served.`;
      }
      this.notify();
      /*
       * The server replays the action log on reconnect, so retrying is safe.
       * The wait grows, though: a server that is down stays down, and hammering
       * it once a second from every open tab for as long as the tab is open is
       * neither kind nor useful. It resets the moment a connection succeeds.
       */
      if (!this.closed && this.reconnectTimer === null) {
        const wait = Math.min(15000, 1000 * 2 ** this.failedAttempts);
        this.failedAttempts++;
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.open();
        }, wait);
      }
    };
    ws.onerror = () => {
      if (this.everOpened) this.error = 'Connection problem';
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

  info(): ConnectionInfo {
    return {
      kind: 'remote',
      room: this.opts.room,
      status: this.status,
      players: this.lobby.players,
      ready: this.lobby.ready,
    };
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
