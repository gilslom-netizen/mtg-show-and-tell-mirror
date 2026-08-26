import { describe, expect, it } from 'vitest';
import { HeuristicAgent } from '../../ai/heuristic';
import { LocalConnection } from '../connection';

/**
 * Sitting with the result.
 *
 * When the computer lost the game it also owed the play-or-draw decision for the
 * next one, and it answered inside a second — which started game two and took
 * the result, the final board and the log off the table before they had been
 * read. There was nothing wrong with the answer; the problem was that nobody had
 * asked for it yet.
 *
 * So the match is held while the result is on screen. These pin both halves: it
 * really does stop, and it really does go again.
 */

const tick = () => new Promise((r) => setTimeout(r, 400));

function computerGame() {
  return new LocalConnection({
    seed: 21,
    startingPlayer: 'p1',
    // One seat is mine; the other is played by the agent.
    seats: ['p1'],
    opponent: new HeuristicAgent(),
    bestOf: 3,
  });
}

describe('the computer does not start the next game on its own', () => {
  it('leaves the play-or-draw decision alone while the result is held', async () => {
    const conn = computerGame();
    try {
      conn.holdResult(true);
      conn.submitIntent('p2', { t: 'concede' }); // the computer loses game one
      expect(conn.match()?.awaitingFirstChoiceFrom).toBe('p2');

      await tick();

      // Still waiting: the game is over, the board is intact, nothing moved on.
      expect(conn.match()?.awaitingFirstChoiceFrom).toBe('p2');
      expect(conn.match()?.gameNumber).toBe(1);
      expect(conn.view('p1')?.winner).toBe('p1');
    } finally {
      conn.dispose();
    }
  });

  it('gets on with it the moment the result is let go', async () => {
    const conn = computerGame();
    try {
      conn.holdResult(true);
      conn.submitIntent('p2', { t: 'concede' });
      await tick();
      expect(conn.match()?.awaitingFirstChoiceFrom).toBe('p2');

      conn.holdResult(false);
      await tick();

      // Answered, and game two is under way.
      expect(conn.match()?.awaitingFirstChoiceFrom).toBeNull();
      expect(conn.match()?.gameNumber).toBe(2);
      expect(conn.view('p1')?.winner).toBeNull();
    } finally {
      conn.dispose();
    }
  });
});
