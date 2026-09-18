import { describe, expect, it } from 'vitest';
import { MIN_FIT, fitScale, heightOfRows, unwrappingRow, type FitRow } from '../Board';

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
 *
 * Both of the things that wasted the room are gone now. Lands are no longer a
 * second row — a half is one row of permanents, so a board wraps once where it
 * used to wrap twice — and a half with room left over grows into it instead of
 * holding an empty band under the player bar.
 */

/** Card sizes at full size, as the CSS derives them. */
const CARD_W = 112;
const CARD_H = CARD_W * 1.396;

/** One half's board: every permanent it controls, on one row. */
const board = (lands: number, spells: number): FitRow[] =>
  lands + spells > 0 ? [{ n: lands + spells, w: CARD_W, h: CARD_H, gap: 6 }] : [];

/** What the chosen scale actually needs, by the same rules the browser lays out by. */
function heightNeeded(availW: number, rows: FitRow[], fit: number): number {
  return heightOfRows(availW, rows, fit);
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
          if (needed > room && fit > MIN_FIT) {
            failures.push(
              `w=${availW} room=${room} ${lands}L/${spells}S fit=${fit} needs=${Math.round(needed)}`,
            );
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
    const bigger = [1.3, 1.2, 1.12, 1.06, 1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58, 0.52].filter(
      (f) => f > fit,
    );
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
    expect(fit).toBeGreaterThanOrEqual(MIN_FIT);
  });

  /**
   * One row, not two.
   *
   * The screenshot that started this: five lands and two other permanents, which
   * as two rows took two lines of a very wide half to show seven cards.
   */
  it('shows a small mixed board on a single line', () => {
    const rows = board(5, 2);
    const availW = 1400;
    const fit = fitScale(availW, 400, rows);
    // One line of seven at the chosen size, not two lines of five and two.
    expect(heightNeeded(availW, rows, fit)).toBeLessThanOrEqual(CARD_H * fit);
  });

  it('grows into spare room instead of leaving an empty band', () => {
    expect(fitScale(1600, 640, board(6, 4))).toBeGreaterThan(1);
    expect(fitScale(966, 400, board(2, 2))).toBeGreaterThan(1);
    // The board that only just fits is still the board that only just fits.
    expect(fitScale(966, 160, board(8, 6))).toBeLessThan(1);
  });

  it('does not grow without limit on an almost empty board', () => {
    const fit = fitScale(2200, 900, board(0, 1));
    expect(fit).toBeLessThanOrEqual(1.3);
  });

  /**
   * The opponent's hand strip is sized off the card width, so it shrinks with
   * the board. Counted as fixed chrome it was subtracted at full size whatever
   * the fit turned out to be, which made the half above the midline — the only
   * one with a strip — shrink further than it had to and still leave a band of
   * empty table under it.
   */
  describe('a part that scales but never wraps', () => {
    it('costs its own height, scaled, on one line', () => {
      const strip = unwrappingRow(24);
      expect(heightOfRows(966, [strip], 1)).toBeCloseTo(24);
      expect(heightOfRows(966, [strip], 0.5)).toBeCloseTo(12);
      // Narrow or wide, it is still one line.
      expect(heightOfRows(120, [strip], 1)).toBeCloseTo(24);
      expect(heightOfRows(3000, [strip], 1)).toBeCloseTo(24);
    });

    it('no longer costs a shrinking half more room than it takes', () => {
      const rows = board(4, 3);
      const strip = unwrappingRow(24);
      const availW = 966;
      // A half that has to shrink, which is the case the old arithmetic got
      // wrong: the strip shrinks with it, so charging its full height is
      // charging for pixels the strip gives back.
      const room = 160;

      const asChrome = fitScale(availW, room - 24, rows);
      const asRow = fitScale(availW, room, [strip, ...rows]);
      expect(asChrome).toBeLessThan(1);
      expect(asRow).toBeGreaterThan(asChrome);
      expect(heightOfRows(availW, [strip, ...rows], asRow)).toBeLessThanOrEqual(room);
    });
  });

  it('is unchanged by an empty board', () => {
    expect(fitScale(966, 200, [])).toBe(1);
    expect(fitScale(0, 0, board(4, 4))).toBe(1);
  });
});
