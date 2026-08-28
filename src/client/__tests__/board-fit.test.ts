import { describe, expect, it } from 'vitest';
import { fitScale, type FitRow } from '../Board';

/**
 * Seeing the whole board.
 *
 * A playtester reported that he could not see his opponent's lands, and the
 * arithmetic said why before any code was read: at the default size one row of
 * permanents plus one row of lands wants 260px, and half of a 720px window is
 * 209px. The board did not fit before a single card was played, and what fell
 * off was whichever row came last — the lands on their side, the creatures on
 * yours. Meanwhile each row was using about two thirds of its width.
 *
 * So the board is scaled to the room it has, and the wasted width is what pays
 * for it: smaller cards fit more per line, so fewer lines are needed.
 */

/** Card sizes at full size, as the CSS derives them. */
const CARD_W = 112;
const CARD_H = CARD_W * 1.396;
const LAND_W = CARD_W * 0.66;
const LAND_H = LAND_W * 1.396;

const board = (lands: number, spells: number): FitRow[] =>
  [
    { n: lands, w: LAND_W, h: LAND_H, gap: 6 },
    { n: spells, w: CARD_W, h: CARD_H, gap: 6 },
  ].filter((r) => r.n > 0);

/** What the chosen scale actually needs, by the same rules the browser lays out by. */
function heightNeeded(availW: number, rows: FitRow[], fit: number): number {
  return rows.reduce((total, row) => {
    const w = row.w * fit;
    const perLine = Math.max(1, Math.floor((availW + row.gap) / (w + row.gap)));
    return total + Math.ceil(row.n / perLine) * row.h * fit;
  }, 0);
}

describe('scaling the board to the space it has', () => {
  /** Widths and heights a half actually gets, from a 1280x720 up to a 2560x1440. */
  const widths = [700, 850, 966, 1200, 1600, 2200];
  const rooms = [120, 160, 200, 260, 340, 480, 640];
  const boards: [number, number][] = [
    [0, 1],
    [2, 1],
    [4, 3],
    [6, 4],
    [8, 6],
    [10, 8],
    [12, 5],
    [16, 10],
  ];

  it('never chooses a scale that leaves a card off the bottom', () => {
    const failures: string[] = [];
    for (const availW of widths) {
      for (const room of rooms) {
        for (const [lands, spells] of boards) {
          const rows = board(lands, spells);
          const fit = fitScale(availW, room, rows);
          const needed = heightNeeded(availW, rows, fit);
          // The floor is allowed to overflow — below it cards stop being
          // readable and scrolling is the better answer — but nothing above it.
          // eslint-disable-next-line no-empty
          if (needed > room && fit > 0.46) {
            failures.push(`w=${availW} room=${room} ${lands}L/${spells}S fit=${fit} needs=${Math.round(needed)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('picks the largest scale that fits, not just any that does', () => {
    const rows = board(6, 4);
    const availW = 966;
    const room = 260;
    const fit = fitScale(availW, room, rows);
    expect(heightNeeded(availW, rows, fit)).toBeLessThanOrEqual(room);
    // Anything larger would not have fitted, or the choice was too cautious.
    const bigger = [1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58, 0.52].filter((f) => f > fit);
    for (const f of bigger) expect(heightNeeded(availW, rows, f)).toBeGreaterThan(room);
  });

  /**
   * The case from the report: a board that used to be cut in half now fits,
   * because the width it was wasting pays for the height it was short of.
   */
  it('fits the board that was being cut off', () => {
    const rows = board(8, 6);
    const availW = 966;
    // A 209px half, less its padding (26), the player bar (33) and two gaps (16).
    const room = 209 - 26 - 33 - 16;
    const fit = fitScale(availW, room, rows);
    expect(heightNeeded(availW, rows, fit)).toBeLessThanOrEqual(room);
    expect(fit).toBeGreaterThanOrEqual(0.46);
  });

  it('leaves a roomy board at full size rather than shrinking for no reason', () => {
    expect(fitScale(1600, 640, board(6, 4))).toBe(1);
    expect(fitScale(966, 400, board(2, 2))).toBe(1);
  });

  it('is unchanged by an empty board', () => {
    expect(fitScale(966, 200, [])).toBe(1);
    expect(fitScale(0, 0, board(4, 4))).toBe(1);
  });
});
