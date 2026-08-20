import type { RngState } from './types';

/**
 * xoshiro128** — small, fast, and good enough for shuffling a 60 card deck.
 *
 * The state lives inside GameState so that a game is fully determined by
 * (seed, action log). That is what makes replays, undo and the golden-replay
 * regression tests possible. Nothing in the engine may call Math.random().
 */

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export function seedRng(seed: number): RngState {
  // splitmix32 to spread a single integer seed across the four words.
  let z = seed >>> 0;
  const next = () => {
    z = (z + 0x9e3779b9) >>> 0;
    let t = z;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
    return (t ^ (t >>> 15)) >>> 0;
  };
  return { s0: next(), s1: next(), s2: next(), s3: next() };
}

/** Returns a uint32 and advances the state in place. */
export function nextUint32(rng: RngState): number {
  const result = (Math.imul(rotl(Math.imul(rng.s1, 5) >>> 0, 7), 9) >>> 0) >>> 0;
  const t = (rng.s1 << 9) >>> 0;

  rng.s2 = (rng.s2 ^ rng.s0) >>> 0;
  rng.s3 = (rng.s3 ^ rng.s1) >>> 0;
  rng.s1 = (rng.s1 ^ rng.s2) >>> 0;
  rng.s0 = (rng.s0 ^ rng.s3) >>> 0;
  rng.s2 = (rng.s2 ^ t) >>> 0;
  rng.s3 = rotl(rng.s3, 11);

  return result;
}

/** Uniform integer in [0, n). */
export function nextInt(rng: RngState, n: number): number {
  if (n <= 1) return 0;
  // Rejection sampling keeps the distribution uniform for any n.
  const limit = Math.floor(0x100000000 / n) * n;
  let r = nextUint32(rng);
  while (r >= limit) r = nextUint32(rng);
  return r % n;
}

/** Fisher-Yates, in place. */
export function shuffleArray<T>(rng: RngState, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}
