import type { Intent } from '@engine/game';
import type { ChoiceResponse, PlayerId } from '@engine/types';

/**
 * Keeping the games you have played.
 *
 * Nothing did, before this. The online store holds a room for three days and
 * deletes the action log between games of a series, the client kept only settings
 * and a seat token, and a local game lived in memory until the tab was reloaded. So
 * an evening of playing left behind a win-loss count you had to remember yourself,
 * and nothing that could be looked at afterwards.
 *
 * What makes fixing that nearly free is the same property the whole engine is built
 * on: a game is `(seed, starting player, action log)` and nothing else, because the
 * engine is deterministic. So a finished game is a few kilobytes rather than the
 * couple of megabytes its states would be, and — the part that matters — it is not a
 * summary. Replaying the log reproduces the game exactly, every hidden card and
 * every decision, which is what turns "I lost three in a row" into something anyone
 * can actually examine.
 */

export interface RecordedAction {
  k: 'intent' | 'choice';
  seat: PlayerId;
  intent?: Intent;
  choiceId?: string;
  response?: ChoiceResponse;
}

export interface PlayedGame {
  /** Wall clock, so a run of games can be put back in order. */
  at: number;
  /** Which seat the human held. */
  seat: PlayerId;
  opponent: string;
  seed: number;
  startingPlayer: PlayerId;
  winner: PlayerId | 'draw' | null;
  reason: string | null;
  turns: number;
  actions: RecordedAction[];
}

const KEY = 'satm:played';
/**
 * Old games are dropped first. A game is a few KB and localStorage is a few MB, so
 * this is generous — but unbounded growth in a store that throws when it is full,
 * and throws while you are in the middle of a game, is not a trade worth making.
 */
const MAX_GAMES = 300;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Some browsers throw on access rather than returning null in private mode.
    return null;
  }
}

export function allPlayed(): PlayedGame[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as PlayedGame[]) : [];
  } catch {
    // A corrupt entry is not worth taking the app down for, and not worth keeping.
    return [];
  }
}

export function recordPlayed(game: PlayedGame): void {
  const store = storage();
  if (!store) return;
  const games = [...allPlayed(), game].slice(-MAX_GAMES);
  try {
    store.setItem(KEY, JSON.stringify(games));
  } catch {
    /*
     * Out of quota. Drop the oldest half rather than the newest game: what someone
     * wants after an evening of playing is this evening.
     */
    try {
      store.setItem(KEY, JSON.stringify(games.slice(Math.floor(games.length / 2))));
    } catch {
      // Storage is unusable. Losing the record is bad; losing the game is worse.
    }
  }
}

export function clearPlayed(): void {
  storage()?.removeItem(KEY);
}

export interface PlayedSummary {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  averageTurns: number;
  byReason: Record<string, number>;
}

export function summarisePlayed(games = allPlayed()): PlayedSummary {
  const out: PlayedSummary = {
    games: games.length,
    wins: 0,
    losses: 0,
    draws: 0,
    averageTurns: 0,
    byReason: {},
  };
  let turns = 0;
  for (const g of games) {
    turns += g.turns;
    if (g.winner === g.seat) out.wins++;
    else if (g.winner === null || g.winner === 'draw') out.draws++;
    else out.losses++;
    const reason = g.reason ?? 'unknown';
    out.byReason[reason] = (out.byReason[reason] ?? 0) + 1;
  }
  out.averageTurns = games.length > 0 ? Math.round((turns / games.length) * 10) / 10 : 0;
  return out;
}

/** The whole history as a file, for reading somewhere that is not a browser. */
export function downloadPlayed(): void {
  const games = allPlayed();
  const blob = new Blob([JSON.stringify({ version: 1, games }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `show-and-tell-games-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
