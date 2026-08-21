import type { Game } from './game.js';
import type { PlayerId } from './types.js';

/**
 * Best-of-three bookkeeping, shared by the local and the online path so both
 * behave identically.
 *
 * Sideboarding is deliberately not modelled here. The six sideboard cards are
 * outside the implemented card pool, so offering a swap screen would be a screen
 * that cannot do anything. What is tracked instead is the thing this format is
 * actually about: who was on the play, how long each game took, and how the series
 * is going — the raw material for the "is my meta just a repeating cycle?" question
 * the format's own description raises.
 */

export interface GameResult {
  game: number;
  winner: PlayerId;
  loser: PlayerId;
  reason: string;
  turns: number;
  onPlay: PlayerId;
}

export interface MatchState {
  bestOf: number;
  /** 1-based. */
  gameNumber: number;
  wins: Record<PlayerId, number>;
  history: GameResult[];
  /** Who is on the play in the game currently being set up or played. */
  onPlay: PlayerId;
  /** The loser of the last game, while they are choosing play or draw. */
  awaitingFirstChoiceFrom: PlayerId | null;
  matchWinner: PlayerId | null;
}

export function newMatchState(onPlay: PlayerId, bestOf = 3): MatchState {
  return {
    bestOf,
    gameNumber: 1,
    wins: { p1: 0, p2: 0 },
    history: [],
    onPlay,
    awaitingFirstChoiceFrom: null,
    matchWinner: null,
  };
}

function needed(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}

export class MatchTracker {
  state: MatchState;
  /** Guards against recording the same finished game twice. */
  private recordedGameId: string | null = null;

  constructor(onPlay: PlayerId, bestOf = 3) {
    this.state = newMatchState(onPlay, bestOf);
  }

  /**
   * Call after every engine step. Records the result the first time a game is
   * seen to be over and returns true on that call only.
   */
  noteResult(game: Game): boolean {
    const s = game.state;
    if (s.winner === null || s.winner === 'draw') return false;
    if (this.recordedGameId === s.gameId) return false;
    this.recordedGameId = s.gameId;

    const winner = s.winner;
    const loser: PlayerId = winner === 'p1' ? 'p2' : 'p1';
    this.state.history.push({
      game: this.state.gameNumber,
      winner,
      loser,
      reason: s.endReason ?? 'unknown',
      turns: s.turn,
      onPlay: this.state.onPlay,
    });
    this.state.wins[winner]++;

    if (this.state.wins[winner] >= needed(this.state.bestOf)) {
      this.state.matchWinner = winner;
      this.state.awaitingFirstChoiceFrom = null;
    } else {
      // The loser of the previous game chooses who plays first.
      this.state.awaitingFirstChoiceFrom = loser;
    }
    return true;
  }

  /** The loser's play-or-draw decision. Returns who will be on the play. */
  chooseFirst(player: PlayerId, onPlay: PlayerId): PlayerId | null {
    if (this.state.awaitingFirstChoiceFrom !== player) return null;
    this.state.awaitingFirstChoiceFrom = null;
    this.state.gameNumber++;
    this.state.onPlay = onPlay;
    this.recordedGameId = null;
    return onPlay;
  }

  isOver(): boolean {
    return this.state.matchWinner !== null;
  }
}

// ---------------------------------------------------------------------------
// Series statistics
// ---------------------------------------------------------------------------

export interface SeriesStats {
  games: number;
  onPlayWins: number;
  onPlayGames: number;
  onDrawWins: number;
  averageTurns: number;
  byReason: Record<string, number>;
  /** Longest run of games won by the same seat, on the same side of the play. */
  repeatWarning: string | null;
}

/**
 * Aggregates a run of games. The play/draw split is the first number worth looking
 * at in a combo mirror, and the repeat warning is aimed at the format's own advice
 * about not letting the matchup settle into a cycle.
 */
export function summarise(history: GameResult[]): SeriesStats {
  const stats: SeriesStats = {
    games: history.length,
    onPlayWins: 0,
    onPlayGames: 0,
    onDrawWins: 0,
    averageTurns: 0,
    byReason: {},
    repeatWarning: null,
  };
  if (history.length === 0) return stats;

  let turns = 0;
  for (const g of history) {
    turns += g.turns;
    stats.onPlayGames++;
    if (g.winner === g.onPlay) stats.onPlayWins++;
    else stats.onDrawWins++;
    stats.byReason[g.reason] = (stats.byReason[g.reason] ?? 0) + 1;
  }
  stats.averageTurns = Math.round((turns / history.length) * 10) / 10;

  let run = 1;
  let best = 1;
  let bestWinner = history[0].winner;
  for (let i = 1; i < history.length; i++) {
    if (history[i].winner === history[i - 1].winner) {
      run++;
      if (run > best) {
        best = run;
        bestWinner = history[i].winner;
      }
    } else {
      run = 1;
    }
  }
  if (best >= 3) {
    stats.repeatWarning = `${bestWinner === 'p1' ? 'Seat 1' : 'Seat 2'} has won ${best} in a row — the matchup may be settling into a cycle.`;
  }
  return stats;
}
