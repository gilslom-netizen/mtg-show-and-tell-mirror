import type { CostSymbol, IID, ManaKind, ManaPool, PaymentPlan } from './types.js';

/**
 * Cost parsing and the payment solver.
 *
 * The solver is a real backtracking search rather than greedy tapping. That is not
 * over-engineering for this manabase: a drafted Abrupt Decay costs {B}{G} while every
 * green source (Breeding Pool, Hedge Maze) and every black source (Watery Grave,
 * Undercity Sewers) also makes blue, and Atraxa wants four different colours out of
 * the same duals. A greedy tapper strands the player. See DESIGN.md 9.3.
 */

export const MANA_KINDS: ManaKind[] = ['W', 'U', 'B', 'R', 'G', 'C'];

/** What a Phyrexian symbol costs when it is not paid with mana. CR 107.4f. */
export const PHYREXIAN_LIFE = 2;

export function emptyPool(): ManaPool {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

export function clonePool(p: ManaPool): ManaPool {
  return { W: p.W, U: p.U, B: p.B, R: p.R, G: p.G, C: p.C };
}

export function poolTotal(p: ManaPool): number {
  return p.W + p.U + p.B + p.R + p.G + p.C;
}

export function poolIsEmpty(p: ManaPool): boolean {
  return poolTotal(p) === 0;
}

export function addToPool(p: ManaPool, kind: ManaKind, n = 1): void {
  p[kind] += n;
}

export function parseCost(cost: string | null): CostSymbol[] {
  if (!cost) return [];
  const out: CostSymbol[] = [];
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
    const s = m[1];
    if (/^\d+$/.test(s)) {
      out.push({ t: 'generic', n: Number(s) });
    } else if (/^\d+\/[WUBRG]$/.test(s)) {
      const [n, c] = s.split('/');
      out.push({ t: 'hybridGeneric', n: Number(n), c: c as never });
    } else if (/^[WUBRG]\/[WUBRG]$/.test(s)) {
      const [a, b] = s.split('/');
      out.push({ t: 'hybridColor', a: a as never, b: b as never });
    } else if (/^[WUBRG]\/P$/.test(s)) {
      // {U/P}: that colour, or two life. Its mana value is 1 either way, which is
      // counted in oracle.ts rather than here.
      out.push({ t: 'phyrexian', c: s[0] as never });
    } else if (/^[WUBRG]$/.test(s)) {
      out.push({ t: 'colored', c: s as never });
    } else if (s === 'C') {
      // Treat {C} as a generic-1 that only colourless can pay. Not present in this pool.
      out.push({ t: 'generic', n: 1 });
    } else {
      throw new Error(`Unsupported mana symbol {${s}}`);
    }
  }
  return out;
}

export function costToString(symbols: CostSymbol[]): string {
  return symbols
    .map((s) => {
      switch (s.t) {
        case 'generic':
          return `{${s.n}}`;
        case 'colored':
          return `{${s.c}}`;
        case 'hybridColor':
          return `{${s.a}/${s.b}}`;
        case 'hybridGeneric':
          return `{${s.n}/${s.c}}`;
      }
    })
    .join('');
}

export function genericPortion(symbols: CostSymbol[]): number {
  return symbols.reduce((n, s) => n + (s.t === 'generic' ? s.n : 0), 0);
}

/**
 * Reduce the generic part of a cost by `n` (Delve, and any future cost reducer).
 * Colored and hybrid symbols are untouched — Dig Through Time still needs {U}{U}.
 */
export function reduceGeneric(symbols: CostSymbol[], n: number): CostSymbol[] {
  let left = n;
  const out: CostSymbol[] = [];
  for (const s of symbols) {
    if (s.t === 'generic' && left > 0) {
      const take = Math.min(left, s.n);
      left -= take;
      if (s.n - take > 0) out.push({ t: 'generic', n: s.n - take });
    } else {
      out.push(s);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

export interface ManaSource {
  iid: IID;
  /** The kinds this source could produce if tapped now. */
  produces: ManaKind[];
  /**
   * Soft preference: sources flagged `reserved` are only used when there is no
   * solution without them (e.g. Mistrise Village while its ability is still unused).
   */
  reserved?: boolean;
}

interface Slot {
  /** Kinds that can pay this slot. */
  accepts: ManaKind[];
}

/**
 * Turn a cost into the list of mana it needs, once every either/or in it has been
 * decided. `hybridChoice` picks the coloured half of each {2/B}; `payWithLife`
 * picks life over mana for each Phyrexian symbol, and those symbols then need no
 * mana at all — the life is reported back instead.
 */
function slotsFor(
  symbols: CostSymbol[],
  hybridChoice: boolean[],
  payWithLife: boolean[] = [],
): { slots: Slot[]; life: number } | null {
  const slots: Slot[] = [];
  let hybridIndex = 0;
  let phyrexianIndex = 0;
  let life = 0;
  for (const s of symbols) {
    switch (s.t) {
      case 'generic':
        for (let i = 0; i < s.n; i++) slots.push({ accepts: MANA_KINDS });
        break;
      case 'colored':
        slots.push({ accepts: [s.c] });
        break;
      case 'hybridColor':
        slots.push({ accepts: [s.a, s.b] });
        break;
      case 'hybridGeneric': {
        const payColored = hybridChoice[hybridIndex++];
        if (payColored) slots.push({ accepts: [s.c] });
        else for (let i = 0; i < s.n; i++) slots.push({ accepts: MANA_KINDS });
        break;
      }
      case 'phyrexian': {
        if (payWithLife[phyrexianIndex++]) life += PHYREXIAN_LIFE;
        else slots.push({ accepts: [s.c] });
        break;
      }
    }
  }
  return { slots, life };
}

function countSymbols(symbols: CostSymbol[], t: CostSymbol['t']): number {
  return symbols.filter((s) => s.t === t).length;
}

interface SolveAttempt {
  fromPool: ManaPool;
  taps: { iid: IID; produce: ManaKind }[];
}

function sourceSignature(s: ManaSource): string {
  return [...s.produces].sort().join('');
}

function trySolveSlots(
  slots: Slot[],
  pool: ManaPool,
  sources: ManaSource[],
): SolveAttempt | null {
  // Only the restricted slots need searching. Generic slots accept anything, so
  // once every coloured requirement is placed they are just a counting problem —
  // permuting them is what made a naive solver take seconds on a ten-mana spell.
  const restricted = slots
    .filter((s) => s.accepts.length < MANA_KINDS.length)
    .sort((a, b) => a.accepts.length - b.accepts.length);
  const genericCount = slots.length - restricted.length;

  const remainingPool = clonePool(pool);
  const used = new Set<IID>();
  const taps: { iid: IID; produce: ManaKind }[] = [];
  const fromPool = emptyPool();

  const finish = (): boolean => {
    const poolLeft = poolTotal(remainingPool);
    const free = sources.filter((s) => !used.has(s.iid));
    if (poolLeft + free.length < genericCount) return false;

    // Only commit once the count is known to work, so there is nothing to undo.
    let need = genericCount;
    for (const k of MANA_KINDS) {
      while (need > 0 && remainingPool[k] > 0) {
        remainingPool[k]--;
        fromPool[k]++;
        need--;
      }
    }
    // Spend the least flexible remaining sources on generic first.
    for (const src of [...free].sort((a, b) => a.produces.length - b.produces.length)) {
      if (need === 0) break;
      used.add(src.iid);
      taps.push({ iid: src.iid, produce: src.produces[0] });
      need--;
    }
    return need === 0;
  };

  const recurse = (i: number): boolean => {
    if (i >= restricted.length) return finish();
    const slot = restricted[i];

    // 1. Floating mana first — it drains at end of phase, so it is free to use.
    for (const kind of slot.accepts) {
      if (remainingPool[kind] > 0) {
        remainingPool[kind]--;
        fromPool[kind]++;
        if (recurse(i + 1)) return true;
        fromPool[kind]--;
        remainingPool[kind]++;
      }
    }

    // 2. Then tap sources, least flexible first so the flexible ones survive for
    //    later slots. Sources producing the same set are interchangeable, so only
    //    one of each kind is tried.
    const candidates = sources
      .filter((s) => !used.has(s.iid) && s.produces.some((k) => slot.accepts.includes(k)))
      .sort((a, b) => a.produces.length - b.produces.length);

    const tried = new Set<string>();
    for (const src of candidates) {
      const sig = sourceSignature(src);
      if (tried.has(sig)) continue;
      tried.add(sig);
      for (const kind of src.produces) {
        if (!slot.accepts.includes(kind)) continue;
        used.add(src.iid);
        taps.push({ iid: src.iid, produce: kind });
        if (recurse(i + 1)) return true;
        taps.pop();
        used.delete(src.iid);
      }
    }
    return false;
  };

  if (!recurse(0)) return null;
  return { fromPool, taps };
}

/**
 * Find a way to pay `symbols` from the floating pool plus untapped sources.
 * Returns null when the cost cannot be paid.
 */
export function solvePayment(
  symbols: CostSymbol[],
  pool: ManaPool,
  sources: ManaSource[],
  /**
   * The payer's life total, for Phyrexian symbols. Left at zero, a Phyrexian
   * symbol can only be paid with mana — which is the right default for any caller
   * that does not know whose life it would be spending.
   */
  life = 0,
): PaymentPlan | null {
  const hybridCount = countSymbols(symbols, 'hybridGeneric');
  const phyrexianCount = countSymbols(symbols, 'phyrexian');

  // Enumerate hybrid-generic choices. Paying the coloured half is cheaper in total
  // mana, so try "all coloured" first and walk towards "all generic".
  const combos: boolean[][] = [];
  for (let mask = (1 << hybridCount) - 1; mask >= 0; mask--) {
    const choice: boolean[] = [];
    for (let i = 0; i < hybridCount; i++) choice.push(Boolean(mask & (1 << i)));
    combos.push(choice);
  }
  if (hybridCount === 0) combos.push([]);

  /*
   * Enumerate Phyrexian choices, fewest life payments first.
   *
   * Life is a real cost and mana on the battlefield is not — an untapped Island is
   * worth nothing at the end of the turn — so a Probe cast off an Island should
   * cost the Island, not two life. Only when the mana is not there does paying
   * life come into it. CR 118.4: you may only pay life you have.
   */
  const lifeCombos: boolean[][] = [];
  for (let mask = 0; mask < 1 << phyrexianCount; mask++) {
    const choice: boolean[] = [];
    for (let i = 0; i < phyrexianCount; i++) choice.push(Boolean(mask & (1 << i)));
    if (choice.filter(Boolean).length * PHYREXIAN_LIFE <= life) lifeCombos.push(choice);
  }
  lifeCombos.sort((a, b) => a.filter(Boolean).length - b.filter(Boolean).length);
  if (phyrexianCount === 0) lifeCombos.push([]);

  // Two passes: without reserved sources, then with them.
  const passes: ManaSource[][] = [sources.filter((s) => !s.reserved), sources];

  for (const available of passes) {
    for (const payWithLife of lifeCombos) {
      for (const choice of combos) {
        const built = slotsFor(symbols, choice, payWithLife);
        if (!built) continue;
        const { slots, life: lifeCost } = built;
        if (slots.length === 0) return { fromPool: emptyPool(), taps: [], life: lifeCost };
        const attempt = trySolveSlots(slots, pool, available);
        if (attempt) return { fromPool: attempt.fromPool, taps: attempt.taps, life: lifeCost };
      }
    }
  }
  return null;
}

export function canPay(
  symbols: CostSymbol[],
  pool: ManaPool,
  sources: ManaSource[],
  life = 0,
): boolean {
  return solvePayment(symbols, pool, sources, life) !== null;
}
