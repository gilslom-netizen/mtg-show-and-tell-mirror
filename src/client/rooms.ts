/**
 * The rooms you are in the middle of.
 *
 * An online match already survives everything: the server keeps a room for three
 * days, the whole game is `(seed, action log)` so every request rebuilds it, and
 * a seat token in this browser puts you back in your own chair rather than a new
 * one. Closing the tab, closing the browser, turning the machine off and coming
 * back tomorrow all work — and none of it was any use, because there was nothing
 * on screen that knew a game was waiting.
 *
 * So this is the missing half: a list of the codes this browser has played in,
 * with enough written down to tell you what you would be going back to. It is
 * deliberately not the game — the game lives on the server, where the other
 * player can reach it too.
 */

export interface RememberedRoom {
  code: string;
  /** Last time this browser did anything in that room. */
  at: number;
  format: 'classic' | 'draft';
  /** What the room was doing when we last looked. */
  phase: 'draft' | 'build' | 'game';
  /** Series score, so the entry says something more useful than the code. */
  wins?: { mine: number; theirs: number };
  bestOf?: number;
  opponent?: string;
  /** Set once the series is decided, so it can be shown as finished. */
  done?: boolean;
}

const KEY = 'satm:rooms';
/**
 * The server keeps a room for three days, so an entry older than that points at
 * a room that no longer exists — offering it would be offering a dead link.
 */
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_ROOMS = 12;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Private mode can throw on access rather than returning null.
    return null;
  }
}

export function rememberedRooms(now = Date.now()): RememberedRoom[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RememberedRoom[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r && typeof r.code === 'string' && now - r.at < MAX_AGE_MS)
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/**
 * Record — or update — one room.
 *
 * Merged rather than appended: a room you are still playing in is touched on
 * every poll, and a list with the same code in it forty times is not a list.
 */
export function rememberRoom(entry: RememberedRoom): void {
  const store = storage();
  if (!store) return;
  const rest = rememberedRooms(entry.at).filter((r) => r.code !== entry.code);
  const next = [entry, ...rest].slice(0, MAX_ROOMS);
  try {
    store.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or disabled store costs the resume list, not the game.
  }
}

export function forgetRoom(code: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(rememberedRooms().filter((r) => r.code !== code)));
  } catch {
    // As above.
  }
}

/** "2 hours ago", for a list whose whole job is telling you what is still warm. */
export function howLongAgo(at: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - at) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
