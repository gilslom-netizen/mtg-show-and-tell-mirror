import { enumerateLegalActions } from '../engine/game.js';
import { redact } from '../engine/redact.js';
import type { GameState, PlayerId } from '../engine/types.js';
import type { Agent } from './agent.js';
import { playGame, type GameRecord } from './arena.js';
import { HeuristicAgent } from './heuristic.js';
import { RandomAgent } from './random.js';
import { runSeries } from './series.js';

/**
 * Measuring the engine before optimising it, and before designing anything on top.
 *
 * This is principle ע4 with a command attached. Every number in DESIGN-AI.md 1 came
 * out of a run of this, and they are the numbers that decide which approaches are
 * even possible: a branching factor of three makes search cheap, a state clone that
 * costs more than a whole decision rules out textbook MCTS, and 48% of a decision
 * spent on a snapshot for a UI button is the highest-return fix in the project.
 *
 * Re-running it is how the plan stays honest as the engine changes.
 */

export interface Stats {
  n: number;
  mean: number;
  median: number;
  p95: number;
  max: number;
}

function stats(values: number[]): Stats {
  if (values.length === 0) return { n: 0, mean: 0, median: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  };
}

/** Median of repeated timings, in microseconds. Medians, because a GC pause is not the cost. */
function microseconds(reps: number, fn: () => unknown): number {
  const samples: number[] = [];
  // A warm-up run, so the first sample is not measuring the JIT.
  fn();
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    samples.push((performance.now() - t0) * 1000);
  }
  return stats(samples).median;
}

export interface BenchResult {
  games: number;
  /** Throughput, both agents random. */
  randomMsPerGame: number;
  randomGamesPerSecond: number;
  /** The same, with the Esc snapshot left on — what the client pays. */
  undoableMsPerGame: number;
  snapshotSpeedup: number;
  heuristicMsPerGame: number;
  heuristicGamesPerSecond: number;

  decisionsPerGame: number;
  turnsPerGame: number;
  decisionUs: number;
  undoableDecisionUs: number;

  stringifyUs: number;
  cloneUs: number;
  redactUs: number;
  legalActionsUs: number;
  heuristicActUs: number;

  stateBytes: number;
  viewBytes: number;
  recordBytes: number;
  /** How many times smaller a record is than the states it stands in for. */
  recordRatio: number;

  priorityBranching: Stats;
  choiceBranching: Stats;
}

function totals(records: GameRecord[]): { decisions: number; turns: number } {
  return {
    decisions: records.reduce((n, r) => n + r.decisions, 0),
    turns: records.reduce((n, r) => n + r.turns, 0),
  };
}

function timeRun(games: number, undoable: boolean, heuristic: boolean): {
  ms: number;
  records: GameRecord[];
} {
  const records: GameRecord[] = [];
  const t0 = performance.now();
  for (let i = 0; i < games; i++) {
    records.push(
      playGame({
        p1: heuristic ? new HeuristicAgent() : new RandomAgent(i * 2 + 1),
        p2: heuristic ? new HeuristicAgent() : new RandomAgent(i * 2 + 2),
        seed: 1000 + i,
        startingPlayer: i % 2 === 0 ? 'p1' : 'p2',
        undoable,
      }),
    );
  }
  return { ms: performance.now() - t0, records };
}

/**
 * What the Esc snapshot costs, measured as a paired comparison.
 *
 * Timing forty games with it and then forty games without it is the obvious way and
 * it does not work: a laptop throttles inside a minute, so the second block is
 * measured at a lower clock than the first and the answer comes out anywhere between
 * ×0.98 and ×3.2 depending on which block went first and how warm the room is.
 *
 * The same game is therefore played twice back to back, identical in every respect
 * but the snapshot, with the order swapped on alternate iterations. Adjacent games
 * see the same clock, and swapping the order cancels whatever the first of a pair
 * gets from a warm cache.
 */
function timeSnapshotCost(games: number): {
  fast: { ms: number; records: GameRecord[] };
  slow: { ms: number; records: GameRecord[] };
} {
  const fast = { ms: 0, records: [] as GameRecord[] };
  const slow = { ms: 0, records: [] as GameRecord[] };

  for (let i = 0; i < games; i++) {
    const options = (undoable: boolean) => ({
      p1: new RandomAgent(i * 2 + 1),
      p2: new RandomAgent(i * 2 + 2),
      seed: 1000 + i,
      startingPlayer: (i % 2 === 0 ? 'p1' : 'p2') as 'p1' | 'p2',
      undoable,
    });
    const run = (into: typeof fast, undoable: boolean) => {
      const t = performance.now();
      into.records.push(playGame(options(undoable)));
      into.ms += performance.now() - t;
    };

    if (i % 2 === 0) {
      run(fast, false);
      run(slow, true);
    } else {
      run(slow, true);
      run(fast, false);
    }
  }
  return { fast, slow };
}

/**
 * A state from the middle of a real game, for the micro-benchmarks.
 *
 * Timing them against an opening hand would flatter every one of them: the whole
 * point of the numbers is what they cost with a board, a graveyard and a stack.
 */
function midGameState(): { state: GameState; seat: PlayerId } {
  let captured: GameState | null = null;
  let seat: PlayerId = 'p1';
  playGame({
    p1: new RandomAgent(11),
    p2: new RandomAgent(12),
    seed: 424242,
    onDecision: (game, who, kind) => {
      if (captured) return;
      if (kind !== 'priority') return;
      // Wait for a position with something in it.
      if (game.state.turn < 5) return;
      if (game.state.zones[who].battlefield.length < 3) return;
      captured = JSON.parse(JSON.stringify(game.state)) as GameState;
      seat = who;
    },
  });
  if (!captured) throw new Error('No mid-game position was reached — the driver is broken');
  return { state: captured, seat };
}

export function bench(games = 40): BenchResult {
  // Branching factors, gathered over real random games.
  const priority: number[] = [];
  const choices: number[] = [];
  for (let i = 0; i < Math.max(4, Math.floor(games / 4)); i++) {
    playGame({
      p1: new RandomAgent(i + 1),
      p2: new RandomAgent(i + 101),
      seed: 7000 + i,
      onDecision: (game, seat, kind) => {
        if (kind === 'priority') {
          // Passing is always available, and tapping a land for mana on its own is
          // never a real option, so the honest count is "the things worth
          // considering, plus pass".
          const actions = enumerateLegalActions(game.state, seat).filter(
            (a) => !a.isManaAbility,
          );
          priority.push(actions.length + 1);
          return;
        }
        const pc = game.state.pendingChoice;
        if (!pc) return;
        switch (pc.kind) {
          case 'chooseCards':
            choices.push(pc.options.filter((o) => !o.disabledReason).length);
            break;
          case 'chooseTargets':
            choices.push(pc.candidates.length);
            break;
          case 'chooseMode':
            choices.push(pc.modes.filter((m) => m.enabled).length);
            break;
          case 'declareAttackers':
            choices.push(pc.candidates.length);
            break;
          case 'orderTriggers':
            choices.push(pc.triggers.length);
            break;
          default:
            choices.push(2);
        }
      },
    });
  }

  const { fast, slow } = timeSnapshotCost(games);
  const heur = timeRun(Math.max(4, Math.floor(games / 2)), false, true);

  const fastTotals = totals(fast.records);
  const slowTotals = totals(slow.records);

  const { state, seat } = midGameState();
  const view = redact(state, seat);
  // Typed as the interface, so what is timed is the call an arena actually makes.
  const agent: Agent = new HeuristicAgent();

  const stringifyUs = microseconds(60, () => JSON.stringify(state));
  const cloneUs = microseconds(60, () => JSON.parse(JSON.stringify(state)) as GameState);
  const redactUs = microseconds(200, () => redact(state, seat));
  const legalActionsUs = microseconds(400, () => enumerateLegalActions(state, seat));
  const heuristicActUs = microseconds(400, () => agent.act(view, 50));

  const stateBytes = JSON.stringify(state).length;
  const viewBytes = JSON.stringify(view).length;
  const recordBytes = JSON.stringify(fast.records[0]).length;

  return {
    games,
    randomMsPerGame: fast.ms / games,
    randomGamesPerSecond: (games * 1000) / fast.ms,
    undoableMsPerGame: slow.ms / games,
    snapshotSpeedup: slow.ms / fast.ms,
    heuristicMsPerGame: heur.ms / heur.records.length,
    heuristicGamesPerSecond: (heur.records.length * 1000) / heur.ms,

    decisionsPerGame: fastTotals.decisions / games,
    turnsPerGame: fastTotals.turns / games,
    decisionUs: (fast.ms * 1000) / fastTotals.decisions,
    undoableDecisionUs: (slow.ms * 1000) / slowTotals.decisions,

    stringifyUs,
    cloneUs,
    redactUs,
    legalActionsUs,
    heuristicActUs,

    stateBytes,
    viewBytes,
    recordBytes,
    recordRatio: (stateBytes * (fastTotals.decisions / games)) / recordBytes,

    priorityBranching: stats(priority),
    choiceBranching: stats(choices),
  };
}

export interface ParallelPoint {
  threads: number;
  /** Wall clock for a fixed amount of work, including getting the workers up. */
  gamesPerSecond: number;
  /** Throughput relative to a single thread. */
  speedup: number;
}

/**
 * How much the machine actually gains from more threads.
 *
 * Games are perfectly independent and share nothing, so the textbook answer is
 * "×cores" — and on the laptop this was written on the real answer is closer to ×2,
 * because the workload is allocation-bound and memory bandwidth is not a thing more
 * threads give you more of. Printing cores × single-core throughput would overstate
 * the self-play budget by a factor of five, and the self-play budget is what decides
 * whether stage 4 is a week or a season. So it is measured.
 */
export async function measureParallelism(
  threadCounts: number[],
  pairs = 40,
): Promise<ParallelPoint[]> {
  /*
   * Each count is measured twice, once up the list and once back down it, and the
   * better sample is kept.
   *
   * Two things make this harder to measure than it looks, and both of them produce
   * the same wrong answer — that threads do not help at all.
   *
   * A laptop under sustained load throttles, so a single pass measures the clock
   * sliding downwards as much as it measures parallelism, and whichever count went
   * first wins. Sweeping in both directions gives every count an early sample and a
   * late one, and the drift only ever goes one way.
   *
   * And a worker has to boot: under a TypeScript loader that is most of a second
   * each, and several at once compete for the same cores. Eighty games is enough
   * that start-up is a fraction of the sample rather than the whole of it — which is
   * also the honest reason a short arena run sees less benefit than a long one.
   *
   * Treat the shape of the curve as the finding and the exact numbers as weather.
   */
  const best = new Map<number, number>();
  const sweep = [...threadCounts, ...[...threadCounts].reverse()];
  for (const threads of sweep) {
    const result = await runSeries({
      a: 'heuristic',
      b: 'random',
      pairs,
      seed: 31415,
      workers: threads,
    });
    best.set(threads, Math.max(best.get(threads) ?? 0, result.gamesPerSecond));
  }

  const single = best.get(threadCounts[0]) ?? 0;
  return threadCounts.map((threads) => {
    const rate = best.get(threads) ?? 0;
    return { threads, gamesPerSecond: rate, speedup: single > 0 ? rate / single : 1 };
  });
}

export function formatParallelism(points: ParallelPoint[], pairs: number): string {
  const best = points.reduce((a, b) => (b.gamesPerSecond > a.gamesPerSecond ? b : a));
  return [
    `Threads, over ${pairs * 2} games each — start-up included, which is the point`,
    ...points.map(
      (p) =>
        `  ${String(p.threads).padStart(2)} thread${p.threads === 1 ? ' ' : 's'}  ` +
        `${p.gamesPerSecond.toFixed(1).padStart(6)} games/s   ×${p.speedup.toFixed(2)}`,
    ),
    `  best here: ${best.threads} threads — ${gamesPerDay(best.gamesPerSecond).toLocaleString(
      'en-US',
    )} games/day sustained`,
    '',
    '  A worker costs most of a second to start under a TypeScript loader, and several',
    '  starting at once compete for the same cores — so a short run barely gains and a',
    '  long one gains properly. The number to trust for a real run is the one every',
    '  `npm run ai:arena` prints at the end of itself.',
  ].join('\n');
}

export function formatBench(b: BenchResult): string {
  const us = (x: number) => `${x.toFixed(1)} µs`;
  const ms = (x: number) => `${x.toFixed(1)} ms`;
  const kb = (x: number) => `${(x / 1024).toFixed(1)} KB`;
  const s = (x: Stats) =>
    `mean ${x.mean.toFixed(2)}, median ${x.median}, p95 ${x.p95}, max ${x.max}  (n=${x.n})`;

  return [
    `Throughput — ${b.games} games per configuration, one core`,
    `  random game                 ${ms(b.randomMsPerGame)}   (${b.randomGamesPerSecond.toFixed(1)} games/s)`,
    `  random game, Esc kept on    ${ms(b.undoableMsPerGame)}   (${(1000 / b.undoableMsPerGame).toFixed(1)} games/s)`,
    `  turning the snapshot off is worth  ×${b.snapshotSpeedup.toFixed(2)}`,
    `  heuristic game              ${ms(b.heuristicMsPerGame)}   (${b.heuristicGamesPerSecond.toFixed(1)} games/s)`,
    ``,
    `Cost of one engine decision`,
    `  with the Esc snapshot       ${us(b.undoableDecisionUs)}`,
    `  without it                  ${us(b.decisionUs)}`,
    `  decisions per game          ${b.decisionsPerGame.toFixed(0)}`,
    `  turns per game              ${b.turnsPerGame.toFixed(1)}`,
    ``,
    `Where the time goes, on a mid-game position`,
    `  JSON.stringify(state)       ${us(b.stringifyUs)}    (this is the Esc snapshot)`,
    `  state clone (JSON round trip) ${us(b.cloneUs)}  ${
      b.cloneUs > b.decisionUs
        ? '← more than a whole decision: rules out MCTS that clones per node'
        : ''
    }`,
    `  redact(state, seat)         ${us(b.redactUs)}`,
    `  enumerateLegalActions       ${us(b.legalActionsUs)}`,
    `  heuristic act()             ${us(b.heuristicActUs)}`,
    ``,
    `Sizes`,
    `  full state                  ${kb(b.stateBytes)}`,
    `  redacted view               ${kb(b.viewBytes)}`,
    `  whole game as (seed, log)   ${kb(b.recordBytes)}   — ${b.recordRatio.toFixed(0)}× smaller than storing its states`,
    ``,
    `Branching factor`,
    `  holding priority            ${s(b.priorityBranching)}`,
    `  answering a question        ${s(b.choiceBranching)}`,
  ].join('\n');
}

/** Games per day at a given rate, which is the unit self-play budgets come in. */
export function gamesPerDay(gamesPerSecond: number): number {
  return Math.round(gamesPerSecond * 60 * 60 * 24);
}
