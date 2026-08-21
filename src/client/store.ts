import { create } from 'zustand';
import type { Intent } from '@engine/game';
import type { PlayerView } from '@engine/redact';
import type { ChoiceResponse, GameEvent, IID, PlayerId } from '@engine/types';
import type { Connection } from './connection';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings';

/**
 * All client state that is not derived from the PlayerView.
 *
 * The important idea: the store never reaches into the engine. It only ever sees a
 * redacted view, so a bug here cannot leak hidden information even in local play.
 */

export type AutoPassMode = 'off' | 'endOfTurn' | 'myNextTurn';

export interface KnownTopEntry {
  iid: IID;
  /** How the player came to know about this card. */
  via: 'brainstorm' | 'surveil' | 'sanctuary' | 'other';
}

interface StoreState {
  connection: Connection | null;
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

  hoveredIid: IID | null;
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
  send(intent: Intent, seat?: PlayerId): void;
  respond(response: ChoiceResponse, seat?: PlayerId): void;
  cancel(): void;
  setAutoPass(mode: AutoPassMode): void;
  setForceStop(v: boolean): void;
  setHoldPriority(v: boolean): void;
  setHovered(iid: IID | null): void;
  setHighlight(iids: IID[]): void;
  clearReveal(): void;
  toggle(panel: 'logOpen' | 'settingsOpen' | 'helpOpen'): void;
  setArtAvailable(v: boolean): void;
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
  viewSeat: 'p1',
  views: { p1: null, p2: null },
  settings: typeof localStorage === 'undefined' ? DEFAULT_SETTINGS : loadSettings(),
  knownTop: emptyKnownTop(),
  autoPass: 'off',
  forceStop: false,
  holdPriority: false,
  hoveredIid: null,
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
      viewSeat,
      knownTop: emptyKnownTop(),
      autoPass: 'off',
      error: null,
    });
    (conn as Connection & { _unsub?: () => void })._unsub = unsubscribe;
    get().refresh();
  },

  detach() {
    const conn = get().connection as (Connection & { _unsub?: () => void }) | null;
    conn?._unsub?.();
    conn?.dispose();
    set({ connection: null, views: { p1: null, p2: null }, knownTop: emptyKnownTop() });
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
    const knownTop = applyEventsToKnownTop(get().knownTop, events);
    const reveal = detectShowAndTellReveal(events, views);
    set({
      views,
      knownTop,
      error: conn.lastError(),
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

  send(intent, seat) {
    const conn = get().connection;
    if (!conn) return;
    const s = seat ?? get().viewSeat;
    if (!conn.seats().includes(s)) return;
    // Any deliberate action cancels a running auto-pass run.
    if (intent.t !== 'passPriority') set({ autoPass: 'off' });
    conn.submitIntent(s, intent);
  },

  respond(response, seat) {
    const conn = get().connection;
    if (!conn) return;
    const view = get().views[seat ?? get().viewSeat];
    const choice = view?.choice;
    if (!choice) return;
    const s = seat ?? get().viewSeat;

    // Learn the top of the library from choices the player just made.
    const learned = knownTopFromChoice(choice, response);
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
    conn.cancel(get().viewSeat);
  },

  setAutoPass(mode) {
    set({ autoPass: mode });
  },
  setForceStop(v) {
    set({ forceStop: v });
  },
  setHoldPriority(v) {
    set({ holdPriority: v });
  },
  setHovered(iid) {
    set({ hoveredIid: iid });
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
          mutate(ev.owner, (list) => [{ iid: ev.iid, via: 'other' as const }, ...list]);
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
  const isSurveil = /surveil/i.test(choice.prompt);
  if (!isSurveil) return null;
  const kept = choice.options.map((o) => o.iid).filter((iid) => !response.iids.includes(iid));
  return kept.map((iid) => ({ iid, via: 'surveil' as const }));
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
