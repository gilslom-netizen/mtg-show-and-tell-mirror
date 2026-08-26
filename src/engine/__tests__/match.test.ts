import { describe, expect, it } from 'vitest';
import {
  MAX_SERIES_LENGTH,
  MatchTracker,
  canExtend,
  newMatchState,
  seriesLength,
  summarise,
} from '../match.js';
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

describe('series length', () => {
  it('takes any odd length, and reads anything else as a best of three', () => {
    expect(seriesLength(1)).toBe(1);
    expect(seriesLength(3)).toBe(3);
    expect(seriesLength(5)).toBe(5);
    /*
     * Seven and up are not offered when a room is opened, but they are real:
     * a series extended twice is a best of seven, and a room stored at that
     * length has to load back as one rather than quietly shrinking to three
     * and declaring somebody the winner of a match they were still playing.
     */
    expect(seriesLength(7)).toBe(7);
    expect(seriesLength(11)).toBe(11);
    expect(newMatchState('p1', 7).bestOf).toBe(7);
    expect(new MatchTracker('p1', 9).state.bestOf).toBe(9);

    // An even length has no rule anywhere — 2 wins out of 4 is not a format.
    expect(seriesLength(2)).toBe(3);
    expect(seriesLength(0)).toBe(3);
    expect(seriesLength(4)).toBe(3);
    expect(seriesLength(undefined)).toBe(3);
    // And a number nobody could reach by agreeing twice at a time.
    expect(seriesLength(1001)).toBe(3);
  });

  /**
   * Two more games, agreed at the end rather than chosen at the start.
   *
   * "Best of five" is usually something people decide after three, which is why
   * this exists at all — and why it needs both of them to agree: a longer match
   * is not the loser's to demand or the winner's to refuse alone.
   */
  describe('extending a decided match', () => {
    function decided(): MatchTracker {
      const t = new MatchTracker('p1', 3);
      t.state.wins = { p1: 2, p2: 0 };
      t.state.history = [
        { game: 1, winner: 'p1', loser: 'p2', reason: 'x', turns: 5, onPlay: 'p1' },
        { game: 2, winner: 'p1', loser: 'p2', reason: 'x', turns: 5, onPlay: 'p2' },
      ];
      t.state.gameNumber = 2;
      t.state.matchWinner = 'p1';
      return t;
    }

    it('cannot be offered while the match is still live', () => {
      const t = new MatchTracker('p1', 3);
      expect(canExtend(t.state)).toBe(false);
      expect(t.offerExtend('p1')).toBe(false);
    });

    it('needs the other player to accept, and then adds exactly two games', () => {
      const t = decided();
      expect(t.offerExtend('p1')).toBe(true);
      // The offerer cannot answer their own offer.
      expect(t.answerExtend('p1', true)).toBe(false);
      expect(t.answerExtend('p2', true)).toBe(true);
      expect(t.state.bestOf).toBe(5);
      expect(t.state.matchWinner).toBeNull();
      expect(t.isOver()).toBe(false);
    });

    it('hands the next play-or-draw choice to whoever just lost', () => {
      const t = decided();
      t.offerExtend('p1');
      t.answerExtend('p2', true);
      // p2 lost game two, so it is p2's choice — an extension is not a fresh
      // start with the winner on the play.
      expect(t.state.awaitingFirstChoiceFrom).toBe('p2');
    });

    it('leaves the match decided when the offer is declined', () => {
      const t = decided();
      t.offerExtend('p1');
      expect(t.answerExtend('p2', false)).toBe(false);
      expect(t.state.bestOf).toBe(3);
      expect(t.state.matchWinner).toBe('p1');
      // The offer is cleared either way, so it cannot be answered twice.
      expect(t.state.extendOfferFrom ?? null).toBeNull();
    });

    it('goes on as long as they keep agreeing: 3, 5, 7, 9', () => {
      const t = decided();
      const lengths: number[] = [];
      for (let i = 0; i < 3; i++) {
        t.offerExtend('p1');
        t.answerExtend('p2', true);
        lengths.push(t.state.bestOf);
        // Play the extension out so there is a decided match to extend again.
        t.state.wins.p1 += 1;
        t.state.matchWinner = 'p1';
        t.state.history.push({
          game: t.state.history.length + 1,
          winner: 'p1',
          loser: 'p2',
          reason: 'x',
          turns: 5,
          onPlay: 'p1',
        });
      }
      expect(lengths).toEqual([5, 7, 9]);
    });

    it('refuses to run away past the cap', () => {
      const t = decided();
      t.state.bestOf = MAX_SERIES_LENGTH;
      expect(canExtend(t.state)).toBe(false);
      expect(t.offerExtend('p1')).toBe(false);
    });
  });

  it('best of one is over after one game, with nobody asked to choose', () => {
    const m = new MatchTracker('p1', 1);
    expect(m.state.bestOf).toBe(1);
    m.noteResult(finishedGame('p2', 'g1'));

    expect(m.isOver()).toBe(true);
    expect(m.state.matchWinner).toBe('p2');
    // No game two, so there is no play-or-draw decision to hand anyone.
    expect(m.state.awaitingFirstChoiceFrom).toBeNull();
    expect(m.chooseFirst('p1', 'p1')).toBeNull();
    expect(m.state.gameNumber).toBe(1);
  });

  it('best of five needs three wins and keeps asking until then', () => {
    const m = new MatchTracker('p1', 5);
    const win = (who: 'p1' | 'p2', n: number) => {
      m.noteResult(finishedGame(who, `g${n}`));
      if (!m.isOver()) m.chooseFirst(m.state.awaitingFirstChoiceFrom!, 'p1');
    };

    win('p1', 1);
    win('p2', 2);
    expect(m.state.gameNumber).toBe(3);
    win('p1', 3);
    // Two wins is a finished best of three and only halfway through a best of five.
    expect(m.isOver()).toBe(false);
    expect(m.state.gameNumber).toBe(4);
    win('p2', 4);
    expect(m.isOver()).toBe(false);
    win('p1', 5);

    expect(m.isOver()).toBe(true);
    expect(m.state.matchWinner).toBe('p1');
    expect(m.state.history).toHaveLength(5);
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
