import { describe, expect, it } from 'vitest';
import { MatchTracker, summarise } from '../match.js';
import { testGame } from './harness.js';

/** Best-of-three bookkeeping. */

function finishedGame(winner: 'p1' | 'p2', gameId: string) {
  const t = testGame();
  const loser = winner === 'p1' ? 'p2' : 'p1';
  t.state.gameId = gameId;
  t.state.winner = winner;
  t.state.endReason = 'life total reached 0';
  t.state.players[loser].hasLost = true;
  t.state.turn = 6;
  return t.game;
}

describe('match tracker', () => {
  it('records a game once and hands the choice to the loser', () => {
    const m = new MatchTracker('p1');
    const g = finishedGame('p1', 'g1');

    expect(m.noteResult(g)).toBe(true);
    // Calling again must not double count.
    expect(m.noteResult(g)).toBe(false);

    expect(m.state.wins).toEqual({ p1: 1, p2: 0 });
    expect(m.state.awaitingFirstChoiceFrom).toBe('p2');
    expect(m.isOver()).toBe(false);
  });

  it('only the loser may choose who plays first', () => {
    const m = new MatchTracker('p1');
    m.noteResult(finishedGame('p1', 'g1'));

    expect(m.chooseFirst('p1', 'p1')).toBeNull();
    expect(m.chooseFirst('p2', 'p2')).toBe('p2');
    expect(m.state.gameNumber).toBe(2);
    expect(m.state.onPlay).toBe('p2');
    expect(m.state.awaitingFirstChoiceFrom).toBeNull();
  });

  it('ends the match at two wins and stops asking', () => {
    const m = new MatchTracker('p1');
    m.noteResult(finishedGame('p1', 'g1'));
    m.chooseFirst('p2', 'p2');
    m.noteResult(finishedGame('p1', 'g2'));

    expect(m.isOver()).toBe(true);
    expect(m.state.matchWinner).toBe('p1');
    expect(m.state.awaitingFirstChoiceFrom).toBeNull();
  });

  it('goes to three games when the series is split', () => {
    const m = new MatchTracker('p1');
    m.noteResult(finishedGame('p1', 'g1'));
    m.chooseFirst('p2', 'p2');
    m.noteResult(finishedGame('p2', 'g2'));
    expect(m.isOver()).toBe(false);
    m.chooseFirst('p1', 'p1');
    expect(m.state.gameNumber).toBe(3);
    m.noteResult(finishedGame('p2', 'g3'));
    expect(m.state.matchWinner).toBe('p2');
  });

  it('never reports a game as a draw win', () => {
    const m = new MatchTracker('p1');
    const t = testGame();
    t.state.winner = 'draw';
    expect(m.noteResult(t.game)).toBe(false);
    expect(m.state.history).toHaveLength(0);
  });
});

describe('series statistics', () => {
  it('splits wins by who was on the play', () => {
    const stats = summarise([
      { game: 1, winner: 'p1', loser: 'p2', reason: 'life total reached 0', turns: 4, onPlay: 'p1' },
      { game: 2, winner: 'p1', loser: 'p2', reason: 'life total reached 0', turns: 6, onPlay: 'p2' },
    ]);
    expect(stats.games).toBe(2);
    expect(stats.onPlayWins).toBe(1);
    expect(stats.onDrawWins).toBe(1);
    expect(stats.averageTurns).toBe(5);
  });

  it('warns once the same seat has taken three in a row', () => {
    const g = (winner: 'p1' | 'p2', n: number) => ({
      game: n,
      winner,
      loser: (winner === 'p1' ? 'p2' : 'p1') as 'p1' | 'p2',
      reason: 'conceded',
      turns: 5,
      onPlay: 'p1' as const,
    });
    expect(summarise([g('p1', 1), g('p2', 2), g('p1', 3)]).repeatWarning).toBeNull();
    expect(summarise([g('p1', 1), g('p1', 2), g('p1', 3)]).repeatWarning).toMatch(/three|3/i);
  });

  it('handles an empty series', () => {
    expect(summarise([]).games).toBe(0);
    expect(summarise([]).repeatWarning).toBeNull();
  });
});
