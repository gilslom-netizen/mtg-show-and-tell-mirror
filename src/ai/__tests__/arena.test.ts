import { describe, expect, it } from 'vitest';
import { stateHash } from '../../engine/__tests__/bot.js';
import { playGame, playGameDetailed, playMatch, replayRecord } from '../arena.js';
import { HeuristicAgent } from '../heuristic.js';
import { RandomAgent } from '../random.js';
import { eloFromScore, summarise } from '../elo.js';
import { runPairRange } from '../series.js';

describe('the arena', () => {
  it('plays games to a real ending', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const record = playGame({
        p1: new HeuristicAgent(),
        p2: new RandomAgent(seed),
        seed: 900 + seed,
        startingPlayer: seed % 2 === 0 ? 'p1' : 'p2',
      });
      expect(record.unfinished).toBe(false);
      expect(record.winner).not.toBeNull();
      expect(record.reason).toBeTruthy();
      expect(record.turns).toBeGreaterThan(0);
    }
  });

  it('is deterministic: the same seed and agents replay the same game', () => {
    const once = playGame({ p1: new HeuristicAgent(), p2: new RandomAgent(3), seed: 4242 });
    const twice = playGame({ p1: new HeuristicAgent(), p2: new RandomAgent(3), seed: 4242 });
    expect(twice.winner).toBe(once.winner);
    expect(twice.turns).toBe(once.turns);
    expect(JSON.stringify(twice.actions)).toBe(JSON.stringify(once.actions));
  });

  /**
   * The claim a training corpus is built on: a game is `(seed, starting player,
   * action log)` and nothing else, so a record is a lossless stand-in for every state
   * the game passed through at about a three-hundredth of the size. Worth checking
   * rather than asserting, because everything downstream assumes it.
   */
  it('replays a record back to the exact same final state', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { record, game } = playGameDetailed({
        p1: new HeuristicAgent(),
        p2: new RandomAgent(seed),
        seed: 3300 + seed,
      });
      const replayed = replayRecord(record);
      expect(stateHash(replayed.state)).toBe(stateHash(game.state));
      expect(replayed.state.winner).toBe(record.winner);
    }
  });

  it('a record is far smaller than the states it stands in for', () => {
    const { record, game } = playGameDetailed({
      p1: new HeuristicAgent(),
      p2: new HeuristicAgent(),
      seed: 8181,
    });
    const stateBytes = JSON.stringify(game.state).length;
    const recordBytes = JSON.stringify(record).length;
    // Even one state is comparable to the whole log; the game passed through
    // hundreds of them.
    expect(recordBytes).toBeLessThan(stateBytes * record.decisions * 0.05);
  });

  it('plays a best-of-three and awards it to whoever wins two', () => {
    const match = playMatch({
      p1: new HeuristicAgent(),
      p2: new RandomAgent(9),
      seed: 5150,
      bestOf: 3,
    });
    expect(match.winner).not.toBeNull();
    expect(match.games.length).toBeGreaterThanOrEqual(2);
    expect(match.games.length).toBeLessThanOrEqual(3);
    const wins = match.history.filter((g) => g.winner === match.winner).length;
    expect(wins).toBe(2);
  });

  it('gives every game of a series its own shuffle', () => {
    const match = playMatch({
      p1: new HeuristicAgent(),
      p2: new RandomAgent(4),
      seed: 6060,
      bestOf: 3,
    });
    const seeds = match.games.map((g) => g.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('mirrors a pair: same shuffle, other player on the play', () => {
    const outcomes = runPairRange({ a: 'heuristic', b: 'random:2', pairs: 1, seed: 31337 }, 0, 1);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].half).toBe(0);
    expect(outcomes[1].half).toBe(1);
    expect(outcomes.every((o) => o.unfinished === 0)).toBe(true);
  });

  it('a shard is reproducible from its numbers alone', () => {
    const opts = { a: 'heuristic', b: 'random:7', pairs: 3, seed: 2024 };
    expect(JSON.stringify(runPairRange(opts, 0, 3))).toBe(
      JSON.stringify(runPairRange(opts, 0, 3)),
    );
    // And a shard of the whole is the same as that slice of the whole.
    expect(JSON.stringify(runPairRange(opts, 1, 2))).toBe(
      JSON.stringify(runPairRange(opts, 0, 3).filter((o) => o.pair === 1)),
    );
  });
});

describe('reading a result', () => {
  it('turns a score into an Elo difference', () => {
    expect(eloFromScore(0.5, 1000)).toBeCloseTo(0, 5);
    expect(eloFromScore(0.75, 1000)).toBeCloseTo(190.85, 1);
    expect(eloFromScore(0.25, 1000)).toBeCloseTo(-190.85, 1);
  });

  it('does not report an infinite gap for a clean sweep', () => {
    expect(Number.isFinite(eloFromScore(1, 100))).toBe(true);
    expect(Number.isFinite(eloFromScore(0, 100))).toBe(true);
  });

  /**
   * The reason mirror pairs exist. A run that is genuinely even must not be reported
   * as a result, however many games it contains.
   */
  it('refuses to call an even split significant', () => {
    const pairScores = Array.from({ length: 500 }, (_, i) => (i % 2 === 0 ? 1 : 0));
    const s = summarise({ pairScores, wins: 500, losses: 500, draws: 0, unfinished: 0 });
    expect(s.score).toBeCloseTo(0.5, 6);
    expect(s.significant).toBe(false);
    expect(s.scoreLow).toBeLessThan(0.5);
    expect(s.scoreHigh).toBeGreaterThan(0.5);
  });

  it('calls a landslide significant, and says which way', () => {
    const pairScores = Array.from({ length: 200 }, (_, i) => (i % 20 === 0 ? 0.5 : 1));
    const s = summarise({ pairScores, wins: 390, losses: 0, draws: 10, unfinished: 0 });
    expect(s.significant).toBe(true);
    expect(s.scoreLow).toBeGreaterThan(0.5);
    expect(s.elo).toBeGreaterThan(300);
  });

  it('widens the interval when there is little to go on', () => {
    const few = summarise({ pairScores: [1, 1, 1], wins: 6, losses: 0, draws: 0, unfinished: 0 });
    // Three pairs of a deck this swingy cannot establish anything.
    expect(few.significant).toBe(false);
  });
});
