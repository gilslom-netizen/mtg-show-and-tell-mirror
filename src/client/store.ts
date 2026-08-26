import { create } from 'zustand';
import type { Intent } from '@engine/game';
import type { PlayerView } from '@engine/redact';
import type { ChoiceResponse, GameEvent, IID, OracleId, PlayerId } from '@engine/types';
import type {
  CardPool,
  Connection,
  ConnectionInfo,
  OnlineCapability,
  SessionPhase,
} from './connection';
import type { DeckEntry } from '@engine/state';
import type { DraftView } from '../draft/redact';
import type { DraftAction } from '../draft/types';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings';
import {
  MAX_REPEATS,
  responseFor,
  waitingForAQuietBoard,
  stepForChoice,
  stepForIntent,
  type RepeatStep,
} from './repeat';

/**
 * Whether this seat may act right now.
 *
 * `waitingOnOpponentChoice` is the one that is easy to miss: while the opponent is
 * ordering triggers or picking a target, your own view has no choice of its own and
 * may still name you as the priority player — but the engine will refuse anything
 * you send.
 */
export function canAct(view: PlayerView, seat: PlayerId): boolean {
  return (
    view.winner === null &&
    view.choice === null &&
    !view.waitingOnOpponentChoice &&
    view.priorityPlayer === seat
  );
}

/** Loose comparison — the client omits optional flags the engine fills in. */
function sameIntentShape(a: Intent, b: Intent): boolean {
  if (a.t !== b.t) return false;
  if (a.t === 'castSpell' && b.t === 'castSpell') {
    return a.iid === b.iid && Boolean(a.free) === Boolean(b.free);
  }
  if (a.t === 'playLand' && b.t === 'playLand') {
    return a.iid === b.iid && (a.face ?? 'front') === (b.face ?? 'front');
  }
  if (a.t === 'activateAbility' && b.t === 'activateAbility') {
    return a.iid === b.iid && a.index === b.index;
  }
  if (a.t === 'tapForMana' && b.t === 'tapForMana') {
    return a.iid === b.iid && a.kind === b.kind;
  }
  return true;
}

/**
 * All client state that is not derived from the PlayerView.
 *
 * The important idea: the store never reaches into the engine. It only ever sees a
 * redacted view, so a bug here cannot leak hidden information even in local play.
 */

export type AutoPassMode = 'off' | 'endOfTurn' | 'myNextTurn';

export interface KnownTopEntry {
  iid: IID;
  /**
   * The card's identity, remembered at the moment it was seen.
   *
   * This panel is the player's memory, not a live query - and it was written as
   * a live query. The name was looked up in the current view on every render,
   * and the moment redaction stopped including the card (it went back under the
   * top of the library), the lookup returned "a card" and the memory read as
   * two anonymous placeholders. What you learned does not expire because the
   * card is face down again; that is the entire point of having learned it.
   */
  oracleId: OracleId;
  /** How the player came to know about this card. */
  via: 'brainstorm' | 'surveil' | 'sanctuary' | 'other';
}

interface StoreState {
  connection: Connection | null;
  /** Room code, transport status and who is seated — null when not connected. */
  connInfo: ConnectionInfo | null;
  /** What the host can actually host, from the /api/health probe. */
  online: OnlineCapability | null;

  /** Draft, deckbuilding or playing. */
  phase: SessionPhase;
  draft: DraftView | null;
  pool: CardPool | null;
  /** The list this seat locked in last game, to sideboard out of. */
  lastDeck: DeckEntry[] | null;
  /** Seats that have locked a decklist in for the game about to start. */
  deckReady: PlayerId[];
  /** Whose side of the table we are looking at. */
  viewSeat: PlayerId;
  views: Record<PlayerId, PlayerView | null>;
  settings: Settings;

  /** Cards the player legitimately saw on top of their own library. */
  knownTop: Record<PlayerId, KnownTopEntry[]>;

  autoPass: AutoPassMode;
  /** Set by holding the stop modifier — forces one stop even if settings say pass. */
  forceStop: boolean;
  /** Hold priority on the next cast. */
  holdPriority: boolean;
  /**
   * A pass is waiting on the floating-mana warning.
   *
   * Shared state rather than a component's, because there are two ways to pass -
   * the button and the spacebar - and the warning was implemented only in the
   * button. The fast path skipped the safety check, which is exactly backwards:
   * a playtester spaced through a phase and watched his mana evaporate. Any way
   * of passing goes through requestPass, so any way of passing gets the warning.
   */
  passWarning: boolean;

  /**
   * The actions this client has taken, newest last, for the repeat detector.
   *
   * Only actions taken by one seat in a row are kept: in lab mode the player
   * drives both sides, and a run of "tap Island" on one board followed by the
   * same on the other is two rhythms, not one.
   */
  actionHistory: RepeatStep[];
  historySeat: PlayerId | null;
  /**
   * An in-progress repeat run, or null.
   *
   * `since` is when the current step started waiting, in milliseconds. Patience
   * is measured in time rather than in ticks so that the runner's cadence and
   * how long it is willing to wait are two separate decisions — they were one,
   * and speeding the runner up quietly shortened every timeout with it.
   */
  repeat: {
    steps: RepeatStep[];
    index: number;
    remaining: number;
    seat: PlayerId;
    since: number;
  } | null;
  /** Why the last run ended, shown once and then dismissed. */
  repeatNote: string | null;
  /**
   * The signature of the last prompt a trigger policy answered on our behalf.
   *
   * A run and the policy bar answer the same questions, and whichever gets there
   * first is fine — but the run then has a step whose prompt is already gone, and
   * "gone" is indistinguishable from "not asked yet" unless somebody says so.
   * Without this the run waited out its full patience on every round of a loop
   * whose last question the policy always wins, which turned an instant kill into
   * eight seconds of a bar sitting still.
   */
  policyAnswered: string | null;

  /**
   * The view each seat last acted from.
   *
   * Online there is a round trip between sending an action and seeing its result,
   * and during it the local view still says you have priority — so a second click
   * (or an impatient double-click on Pass) sent a second action that the server
   * rightly refused, surfacing as an error and a board that disagreed with what
   * you just did. One action per state, per seat: the next snapshot re-arms it.
   */
  actedFrom: Record<PlayerId, PlayerView | null>;
  /** The draft view the last bid or pick was sent from. */
  actedFromDraft: DraftView | null;

  hoveredIid: IID | null;
  /**
   * The card held open in the reading panel, and the one merely under the pointer.
   *
   * Both are oracle ids rather than instance ids because the draft has no game to
   * resolve an instance against — its cards are dealt by the auction, not by the
   * engine — and a reader that worked on the table but not on the pile you are
   * bidding for would be the wrong half.
   */
  pinnedOracleId: OracleId | null;
  hoveredOracleId: OracleId | null;
  /** Cards highlighted because the pointer is over a log line. */
  highlightIids: IID[];
  /** Set while the Show and Tell reveal animation plays. */
  revealing: { p1: IID | null; p2: IID | null } | null;

  error: string | null;
  /** null while the art probe is still running. */
  artAvailable: boolean | null;
  logOpen: boolean;
  settingsOpen: boolean;
  helpOpen: boolean;

  // --- actions ---
  attach(conn: Connection, viewSeat: PlayerId): void;
  detach(): void;
  refresh(): void;
  setViewSeat(seat: PlayerId): void;
  updateSettings(patch: Partial<Settings>): void;
  /**
   * `source` says where this came from. Only a deliberate click ends a running
   * repeat — that is the cancel gesture people reliably reach for — so the
   * comfort layer's own auto-passes and the run's own steps are marked as such.
   */
  send(intent: Intent, seat?: PlayerId, source?: 'user' | 'repeat' | 'auto'): void;
  /**
   * `source` says who is answering: you, a step of a running repeat, or a
   * trigger policy. Only the first two are worth remembering — a policy answers
   * itself again next time round, so recording it would double the pattern.
   */
  respond(response: ChoiceResponse, seat?: PlayerId, source?: 'user' | 'repeat' | 'policy'): void;
  cancel(): void;
  setAutoPass(mode: AutoPassMode): void;
  /** Run the detected pattern again `times` more times. */
  startRepeat(steps: RepeatStep[], times: number, seat: PlayerId): void;
  /** End the run. `note` explains why, when it was not the player's doing. */
  stopRepeat(note?: string): void;
  /** Advance a running repeat by one step. Called by the runner hook. */
  advanceRepeat(): void;
  dismissRepeatNote(): void;
  setForceStop(v: boolean): void;
  setHoldPriority(v: boolean): void;
  /** Pass priority, or raise the floating-mana warning if it applies. */
  requestPass(seat?: PlayerId): void;
  /** The warning's own buttons: go through with the pass, or stay. */
  confirmPass(seat?: PlayerId): void;
  dismissPassWarning(): void;
  setHovered(iid: IID | null): void;
  /** Hold a card open in the reader. Passing the one already pinned closes it. */
  togglePinnedCard(oracleId: OracleId | null): void;
  setHoveredOracle(oracleId: OracleId | null): void;
  setHighlight(iids: IID[]): void;
  clearReveal(): void;
  toggle(panel: 'logOpen' | 'settingsOpen' | 'helpOpen'): void;
  setArtAvailable(v: boolean): void;
  setOnlineCapability(v: OnlineCapability): void;
  /** Bid, withdraw, or keep the cards from a pile you bought. */
  sendDraft(action: DraftAction, seat?: PlayerId): void;
  /** Lock a decklist in for the next game. */
  sendDeck(deck: DeckEntry[], seat?: PlayerId): void;
  dismissError(): void;
  /** The view for the seat currently being displayed. */
  currentView(): PlayerView | null;
  /** Whether this client may act for the given seat. */
  controls(seat: PlayerId): boolean;
}

function emptyKnownTop(): Record<PlayerId, KnownTopEntry[]> {
  return { p1: [], p2: [] };
}

export const useStore = create<StoreState>((set, get) => ({
  connection: null,
  connInfo: null,
  online: null,
  phase: 'game',
  draft: null,
  pool: null,
  lastDeck: null,
  deckReady: [],
  viewSeat: 'p1',
  views: { p1: null, p2: null },
  settings: typeof localStorage === 'undefined' ? DEFAULT_SETTINGS : loadSettings(),
  knownTop: emptyKnownTop(),
  autoPass: 'off',
  forceStop: false,
  holdPriority: false,
  passWarning: false,
  actionHistory: [],
  historySeat: null,
  repeat: null,
  repeatNote: null,
  policyAnswered: null,
  actedFrom: { p1: null, p2: null },
  actedFromDraft: null,
  hoveredIid: null,
  pinnedOracleId: null,
  hoveredOracleId: null,
  highlightIids: [],
  revealing: null,
  error: null,
  artAvailable: null,
  logOpen: false,
  settingsOpen: false,
  helpOpen: false,

  attach(conn, viewSeat) {
    const unsubscribe = conn.subscribe(() => get().refresh());
    set({
      connection: conn,
      connInfo: conn.info(),
      viewSeat,
      knownTop: emptyKnownTop(),
      autoPass: 'off',
      actionHistory: [],
      historySeat: null,
      repeat: null,
      repeatNote: null,
      policyAnswered: null,
      actedFrom: { p1: null, p2: null },
      error: null,
    });
    (conn as Connection & { _unsub?: () => void })._unsub = unsubscribe;
    get().refresh();
  },

  detach() {
    const conn = get().connection as (Connection & { _unsub?: () => void }) | null;
    conn?._unsub?.();
    conn?.dispose();
    set({
      connection: null,
      connInfo: null,
      views: { p1: null, p2: null },
      knownTop: emptyKnownTop(),
      error: null,
    });
  },

  refresh() {
    const conn = get().connection;
    if (!conn) return;
    // Online, the server decides which seat we get; follow it.
    const seats = conn.seats();
    if (seats.length === 1 && seats[0] !== get().viewSeat) {
      set({ viewSeat: seats[0] });
    }
    const views: Record<PlayerId, PlayerView | null> = {
      p1: conn.view('p1'),
      p2: conn.view('p2'),
    };
    const events = conn.drainEvents();
    const knownTop = applyEventsToKnownTop(
      get().knownTop,
      events,
      (iid) => views.p1?.cards[iid]?.oracleId ?? views.p2?.cards[iid]?.oracleId,
    );
    const reveal = detectShowAndTellReveal(events, views);
    const nextInfo = conn.info();
    const infoChanged =
      JSON.stringify(nextInfo) !== JSON.stringify(get().connInfo);

    // The seat this client actually holds; online that is the only one, and in
    // a local session it is whichever half of the table is being looked at.
    const mySeat = seats.length === 1 ? seats[0] : get().viewSeat;
    set({
      views,
      knownTop,
      error: conn.lastError(),
      phase: conn.phase(),
      draft: conn.draftView(mySeat),
      pool: conn.cardPool(mySeat),
      lastDeck: conn.lastDeck(),
      deckReady: conn.deckReady(),
      ...(infoChanged ? { connInfo: nextInfo } : {}),
      ...(reveal ? { revealing: reveal } : {}),
    });
  },

  setViewSeat(seat) {
    set({ viewSeat: seat });
  },

  updateSettings(patch) {
    const next = { ...get().settings, ...patch };
    saveSettings(next);
    set({ settings: next });
  },

  send(intent, seat, source = 'user') {
    const conn = get().connection;
    if (!conn) return;
    const s = seat ?? get().viewSeat;
    if (!conn.seats().includes(s)) return;
    // Only your own seat's clicks; in lab mode the other side is auto-passing
    // constantly and that is not you changing your mind.
    if (source === 'user' && get().repeat?.seat === s) set({ repeat: null });

    // Guard rails against a stale click. The engine rejects these anyway, but a
    // rejection surfaces as an error toast, and an action the player could not
    // have meant should never produce one.
    const view = get().views[s];
    if (view) {
      if (view.winner !== null) return;
      if (intent.t !== 'concede' && !canAct(view, s)) return;
      if (intent.t !== 'passPriority' && intent.t !== 'concede') {
        const legal = view.legalActions.some((a) => sameIntentShape(a.intent, intent));
        if (!legal) return;
      }
      // Conceding is the one thing that must go through even if it is the second
      // click; everything else waits for the state its predecessor produced.
      if (intent.t !== 'concede' && intent.t !== 'tapForMana') {
        if (get().actedFrom[s] === view) return;
        set((st) => ({ actedFrom: { ...st.actedFrom, [s]: view } }));
      }
    }

    // Any deliberate action cancels a running auto-pass run.
    if (intent.t !== 'passPriority') set({ autoPass: 'off' });

    /*
     * Remember what was done, so the repeat detector has something to see.
     *
     * Passes are not recorded and do not break the run. A rhythm is made of
     * actions, and plenty of real ones span a pass or a whole turn — playing a
     * fetchland and cracking it, every turn, is the obvious example. What does
     * break it is the other seat acting, which in lab mode is a different
     * player's rhythm entirely.
     */
    if (view && intent.t !== 'passPriority') {
      const step = stepForIntent(intent, view);
      if (step) {
        const sameSeat = get().historySeat === s;
        set((st) => ({
          historySeat: s,
          actionHistory: [...(sameSeat ? st.actionHistory : []), step].slice(-24),
        }));
      }
    }

    conn.submitIntent(s, intent);
  },

  respond(response, seat, source = 'user') {
    const conn = get().connection;
    if (!conn) return;
    const s = seat ?? get().viewSeat;
    const view = get().views[s];
    const choice = view?.choice;
    // The prompt may have been answered already — by the trigger policy, by the
    // other seat in lab mode, or by a double click.
    if (!choice) return;
    if (choice.kind === 'simultaneousSecret' && choice.iHaveLockedIn) return;
    if (choice.kind === 'mulligan' && choice.iHaveDecided) return;

    // An answer is part of the process too. A loop is mostly answers — bounce
    // this, ping them — and a recording of only the casts could never replay it.
    if (view && source === 'policy') {
      // Not part of the process — the player did not do it — but the run has to be
      // told, or it waits for a question that has already been answered.
      set({ policyAnswered: stepForChoice(choice, response, view, s)?.sig ?? null });
    }
    if (source !== 'policy' && view) {
      const step = stepForChoice(choice, response, view, s);
      if (step) {
        const sameSeat = get().historySeat === s;
        set((st) => ({
          historySeat: s,
          actionHistory: [...(sameSeat ? st.actionHistory : []), step].slice(-32),
        }));
      }
    }

    // Learn the top of the library from choices the player just made. The name
    // is captured now, while the view still contains the card - see KnownTopEntry.
    const learned = knownTopFromChoice(choice, response)?.map((e) => ({
      ...e,
      oracleId: view?.cards[e.iid]?.oracleId ?? e.oracleId,
    }));
    if (learned) {
      set((st) => ({
        knownTop: { ...st.knownTop, [s]: learned.concat(st.knownTop[s]).slice(0, 12) },
      }));
    }
    conn.submitChoice(s, choice.id, response);
  },

  cancel() {
    const conn = get().connection;
    if (!conn) return;
    /*
     * A finished game does not rewind.
     *
     * Escape is undo, and it applied to the last action whatever that was — so
     * pressing it while reading the result took the concede back, resurrected the
     * game and left the match tracker holding a result for a game that was
     * suddenly in progress again. The result screen exists to be sat with; the
     * one key everyone presses to dismiss things should not quietly undo it.
     */
    const seat = get().viewSeat;
    if (get().views[seat]?.winner !== null) return;
    conn.cancel(seat);
  },

  setAutoPass(mode) {
    // A "pass until" run and a repeat run are two different automations; the
    // one you asked for most recently is the one that should be happening.
    set({ autoPass: mode, ...(mode === 'off' ? {} : { repeat: null }) });
  },

  startRepeat(steps, times, seat) {
    if (steps.length === 0) return;
    set({
      repeat: { steps, index: 0, remaining: Math.min(times, MAX_REPEATS), seat, since: Date.now() },
      repeatNote: null,
      policyAnswered: null,
      autoPass: 'off',
    });
  },

  stopRepeat(note) {
    if (!get().repeat) return;
    set({ repeat: null, repeatNote: note ?? null });
  },

  dismissRepeatNote() {
    set({ repeatNote: null });
  },

  /**
   * One step of a running repeat.
   *
   * Driven by the view rather than by a timer: each step is only taken once the
   * previous one has actually landed, which is what makes this safe over a
   * network as well as locally.
   *
   * A step is either an action or an answer, and the loop this exists for is
   * mostly answers. The rule for both is the same — resolve it against what the
   * engine is offering right now, and if it does not fit, stop and say so rather
   * than pressing something arbitrary.
   */
  advanceRepeat() {
    const run = get().repeat;
    if (!run) return;
    const view = get().views[run.seat];
    if (!view) return;
    if (view.winner !== null) {
      get().stopRepeat('The game ended.');
      return;
    }
    if (!get().controls(run.seat)) return;

    const step = run.steps[run.index];
    const advance = () => {
      const nextIndex = (run.index + 1) % run.steps.length;
      const remaining = nextIndex === 0 ? run.remaining - 1 : run.remaining;
      set({
        repeat:
          remaining <= 0 ? null : { ...run, index: nextIndex, remaining, since: Date.now() },
        // The policy's answer belongs to the step just finished. A loop asks the
        // same question every round, so a flag left lying around would be matched
        // by the next round's step and skip a question that had not been asked.
        policyAnswered: null,
      });
    };
    const waitedMs = Date.now() - run.since;

    /*
     * Whether the game is still mid-flight.
     *
     * A loop's later questions only arrive once the stack has drained — the
     * Bowmasters ping is asked when the spell resolves, four passes after it was
     * cast. So "the step I want is not here" means nothing while anything is
     * still resolving; it only means the loop is broken once the board is quiet
     * and the decision is yours again.
     */
    const settling =
      view.stack.length > 0 ||
      view.waitingOnOpponentChoice ||
      view.priorityPlayer !== run.seat;
    /*
     * How long to keep waiting.
     *
     * Generous while anything is still resolving — a loop's later questions only
     * arrive after several passes, and over a network those passes are a round
     * trip each. Short when the board is quiet, because then the thing being
     * waited for is simply not coming.
     */
    const SETTLING_PATIENCE_MS = 10000;
    const QUIET_PATIENCE_MS = 400;

    /*
     * The start of a round waits for the board to look the way it did when you
     * started the round yourself. For a loop that is a clear stack: the
     * Bowmasters has to actually be back on the battlefield before the next
     * bounce has anything to point at, and firing the recast the instant the
     * card reached your hand is what made the run stop dead a round in.
     */
    if (waitingForAQuietBoard(run.steps, run.index, view.stack.length)) {
      if (waitedMs < SETTLING_PATIENCE_MS) return;
      get().stopRepeat('Stopped — the stack never cleared, so the next round never came round.');
      return;
    }

    if (step.what === 'answer') {
      const choice = view.choice;
      if (!choice) {
        // The policy bar got there first and said so. Nothing to wait for.
        if (get().policyAnswered === step.sig) {
          set({ policyAnswered: null });
          advance();
          return;
        }
        // Wait a beat even when the board is quiet: between two states there is
        // a moment with no prompt on screen, and skipping there would put the
        // whole run out of step.
        if (waitedMs < (settling ? SETTLING_PATIENCE_MS : QUIET_PATIENCE_MS)) return;
        /*
         * Nothing is coming. Usually that means a trigger policy answered this
         * one before the run could — "bounce their spell", "their face" — in
         * which case stepping over it is exactly right.
         */
        advance();
        return;
      }
      const response = responseFor(step, choice, view, run.seat);
      if (!response) {
        get().stopRepeat(
          `Stopped — the game asked something the run has no answer for. Over to you.`,
        );
        return;
      }
      advance();
      get().respond(response, run.seat, 'repeat');
      return;
    }

    // An action step. A question that is not part of the pattern is not the
    // run's to answer: it waits, and picks up once you have dealt with it.
    if (view.choice || view.waitingOnOpponentChoice) return;
    if (!canAct(view, run.seat)) return;

    const action = view.legalActions.find(
      (a) => stepForIntent(a.intent, view)?.sig === step.sig,
    );
    if (!action) {
      // Not there yet is not the same as gone: the card you are about to recast
      // is still on the stack for most of every loop.
      if (view.stack.length > 0 && waitedMs < SETTLING_PATIENCE_MS) return;
      get().stopRepeat(
        view.stack.length > 0
          ? 'Stopped — the stack never cleared, so the next round never came round.'
          : `Stopped — "${step.label}" is not available any more.`,
      );
      return;
    }
    // One action per view, exactly like a human click; the guard in send()
    // enforces it too, but bailing here keeps the index honest.
    if (get().actedFrom[run.seat] === view && action.intent.t !== 'tapForMana') return;

    advance();
    get().send(action.intent, run.seat, 'repeat');
  },
  setForceStop(v) {
    set({ forceStop: v });
  },
  setHoldPriority(v) {
    set({ holdPriority: v });
  },
  requestPass(seat) {
    const s = seat ?? get().viewSeat;
    const view = get().views[s];
    if (!view || !canAct(view, s)) return;
    const pool = view.players[s].manaPool;
    const floating = Object.values(pool).reduce((n, x) => n + x, 0);
    if (floating > 0 && get().settings.warnOnFloatingMana) {
      set({ passWarning: true });
      return;
    }
    get().send({ t: 'passPriority' }, s);
  },
  confirmPass(seat) {
    set({ passWarning: false });
    get().send({ t: 'passPriority' }, seat ?? get().viewSeat);
  },
  dismissPassWarning() {
    set({ passWarning: false });
  },
  setHovered(iid) {
    set({ hoveredIid: iid });
  },

  togglePinnedCard(oracleId) {
    set((s) => ({ pinnedOracleId: oracleId !== null && s.pinnedOracleId === oracleId ? null : oracleId }));
  },

  setHoveredOracle(oracleId) {
    set({ hoveredOracleId: oracleId });
  },
  setHighlight(iids) {
    set({ highlightIids: iids });
  },
  clearReveal() {
    set({ revealing: null });
  },
  toggle(panel) {
    set((s) => ({ [panel]: !s[panel] }) as Partial<StoreState>);
  },
  setOnlineCapability(v) {
    set({ online: v });
  },

  sendDraft(action, seat) {
    const conn = get().connection;
    if (!conn) return;
    const s = seat ?? get().viewSeat;
    const draft = get().draft;
    if (draft) {
      // Same guard as the game's send(): online there is a round trip between
      // acting and seeing the result, and during it the screen still shows your
      // own turn. A second click — an impatient double press on Withdraw — would
      // otherwise send a second bid the server rightly refuses.
      if (get().actedFromDraft === draft) return;
      set({ actedFromDraft: draft });
    }
    conn.submitDraftAction(s, action);
  },

  sendDeck(deck, seat) {
    const conn = get().connection;
    if (!conn) return;
    conn.submitDeck(seat ?? get().viewSeat, deck);
  },

  setArtAvailable(v) {
    set({ artAvailable: v });
  },
  dismissError() {
    get().connection?.clearError();
    set({ error: null });
  },

  currentView() {
    return get().views[get().viewSeat];
  },

  controls(seat) {
    return get().connection?.seats().includes(seat) ?? false;
  },
}));

// ---------------------------------------------------------------------------
// Known top of library
// ---------------------------------------------------------------------------

/**
 * Maintains the "you saw this" tracker. Everything here comes from information the
 * player was legitimately shown; the server still never sends library order.
 */
function applyEventsToKnownTop(
  current: Record<PlayerId, KnownTopEntry[]>,
  events: GameEvent[],
  /** Identity lookup at the moment of learning — the views forget, this must not. */
  oracleIdOf: (iid: IID) => OracleId | undefined,
): Record<PlayerId, KnownTopEntry[]> {
  let next = current;
  const mutate = (p: PlayerId, fn: (list: KnownTopEntry[]) => KnownTopEntry[]) => {
    next = { ...next, [p]: fn(next[p]) };
  };

  for (const ev of events) {
    switch (ev.t) {
      case 'shuffle':
        // Any shuffle invalidates everything. This is the whole reason a
        // fetchland after a Brainstorm is a real decision.
        mutate(ev.player, () => []);
        break;
      case 'draw':
        mutate(ev.player, (list) => list.slice(1));
        break;
      case 'zoneChange':
        if (ev.to === 'library' && ev.position === 'top') {
          mutate(ev.owner, (list) => [
            { iid: ev.iid, oracleId: oracleIdOf(ev.iid) ?? '', via: 'other' as const },
            ...list,
          ]);
        } else if (ev.from === 'library' && ev.to !== 'library') {
          mutate(ev.owner, (list) => list.filter((e) => e.iid !== ev.iid));
        }
        break;
      default:
        break;
    }
  }
  return next;
}

/** Surveil: the cards you looked at and did not bin are still sitting on top. */
function knownTopFromChoice(
  choice: NonNullable<PlayerView['choice']>,
  response: ChoiceResponse,
): KnownTopEntry[] | null {
  if (choice.kind !== 'chooseCards' || choice.from !== 'library') return null;
  if (response.kind !== 'cards') return null;
  // Postponing is not an answer: nothing was looked past, so nothing was learned.
  if (response.deferred) return null;
  const isSurveil = /surveil/i.test(choice.prompt);
  if (!isSurveil) return null;
  const kept = choice.options.map((o) => o.iid).filter((iid) => !response.iids.includes(iid));
  return kept.map((iid) => ({ iid, oracleId: '', via: 'surveil' as const }));
}

// ---------------------------------------------------------------------------
// Show and Tell reveal
// ---------------------------------------------------------------------------

/**
 * Detects the moment both Show and Tell picks become visible, so the UI can play
 * the reveal before the cards slide onto the battlefield.
 */
function detectShowAndTellReveal(
  events: GameEvent[],
  views: Record<PlayerId, PlayerView | null>,
): { p1: IID | null; p2: IID | null } | null {
  const entering = events.filter((e) => e.t === 'entersBattlefield');
  if (entering.length < 2) return null;
  const view = views.p1 ?? views.p2;
  if (!view) return null;
  const byController: { p1: IID | null; p2: IID | null } = { p1: null, p2: null };
  for (const e of entering) {
    if (e.t !== 'entersBattlefield') continue;
    byController[e.controller] = e.iid;
  }
  if (byController.p1 === null || byController.p2 === null) return null;
  return byController;
}
