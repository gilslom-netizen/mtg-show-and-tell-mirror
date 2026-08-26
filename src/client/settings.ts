import type { OracleId } from '@engine/types';

/**
 * Client-side comfort settings.
 *
 * None of this lives in the engine: auto-passing here means the client sends a real
 * pass intent, so the action log stays complete and replays are unaffected.
 */

export type StopMode = 'always' | 'ifIHaveAnswer' | 'never';

/**
 * When to stop in combat.
 *
 * 'ifRelevant' is the one worth explaining. This deck wins by resolving a spell,
 * not by attacking, so most turns nobody has a creature and every combat step is
 * three rounds of priority spent pressing pass. Under this setting the client
 * only stops in combat when combat can actually do something — the active player
 * has a creature that could attack, or attackers have already been declared.
 */
export type CombatStopMode = 'always' | 'ifRelevant' | 'never';

export interface StopSettings {
  /** Stop in my own main phase whenever I have something to do. */
  myMainPhase: boolean;
  /** Stop when an opposing spell is on the stack. */
  opponentSpellOnStack: StopMode;
  /** Stop in the opponent's end step. */
  opponentEndStep: StopMode;
  /** Stop before combat steps. */
  combat: CombatStopMode;
  /** Stop when the opponent's turn begins, before they untap. */
  opponentUpkeep: boolean;
}

export type HullbreakerPolicy =
  | 'ask'
  | 'none'
  | 'bounceOpposingSpell'
  | 'bounceBest';

export type BowmastersPolicy = 'ask' | 'opponentFace' | 'ifUnambiguous';

export interface TriggerPolicy {
  hullbreaker: HullbreakerPolicy;
  bowmasters: BowmastersPolicy;
  /** Repeat the previous ordering when the same set of triggers comes up again. */
  rememberTriggerOrder: boolean;
}

/**
 * Where the dividers between the parts of the table have been dragged to.
 *
 * `null` means "work it out from the content", which is the right answer until
 * a player says otherwise — an empty opponent board should not be holding back
 * space your own permanents could use.
 */
export interface LayoutSettings {
  /** Width of the stack/log panel, in pixels. */
  sideWidth: number;
  /** Share of the table given to the opponent's half, 0–1, or null for automatic. */
  fieldSplit: number | null;
  /** Height of the hand, in pixels, or null to size it from the cards. */
  handHeight: number | null;
}

export interface Settings {
  stops: StopSettings;
  layout: LayoutSettings;
  triggers: TriggerPolicy;
  /*
   * There is deliberately no "hold priority for me" setting of any kind.
   *
   * Holding priority is for answering the opponent. A client that does it on your
   * own spells turns every cast of a combo turn into a click you did not ask for,
   * and makes the board look like it has stopped. `H` holds priority at the moment
   * you actually want to chain, and that is the only way it ever happens.
   */
  /** Warn before letting floating mana drain away. */
  warnOnFloatingMana: boolean;
  /** Ask before paying life below this total. */
  confirmLifePaymentBelow: number;
  /** Auto-tap lands when casting instead of asking. */
  autoTapMana: boolean;
  /** Animation duration in ms. 0 disables animation entirely. */
  animationMs: number;
  /** Show card art from Scryfall, or fall back to rendered text cards. */
  showCardArt: boolean;
  /**
   * How large cards are drawn, as a multiplier on the responsive base size.
   * Screens and eyesight differ far too much for one number to be right.
   */
  cardScale: number;
  /** Delay range used before an auto-pass, so timing does not leak information. */
  autoPassDelayMs: [number, number];
}

export const DEFAULT_SETTINGS: Settings = {
  stops: {
    myMainPhase: true,
    // The big one for this deck: only stop when Mana Drain, Veil, Bowmasters or
    // Hullbreaker could actually be cast.
    opponentSpellOnStack: 'ifIHaveAnswer',
    opponentEndStep: 'ifIHaveAnswer',
    combat: 'ifRelevant',
    opponentUpkeep: false,
  },
  layout: {
    sideWidth: 260,
    fieldSplit: null,
    handHeight: null,
  },
  triggers: {
    hullbreaker: 'ask',
    bowmasters: 'ifUnambiguous',
    rememberTriggerOrder: true,
  },
  warnOnFloatingMana: true,
  confirmLifePaymentBelow: 6,
  autoTapMana: true,
  animationMs: 180,
  showCardArt: true,
  cardScale: 1,
  autoPassDelayMs: [150, 400],
};

const KEY = 'satm.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Merge so a new setting added later still gets its default.
    const merged: Settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      stops: { ...DEFAULT_SETTINGS.stops, ...(parsed.stops ?? {}) },
      layout: { ...DEFAULT_SETTINGS.layout, ...(parsed.layout ?? {}) },
      triggers: { ...DEFAULT_SETTINGS.triggers, ...(parsed.triggers ?? {}) },
    };
    // The combat stop used to be a checkbox. A stored `true` meant "stop at every
    // combat step", which is now spelled 'always'; a stored `false` meant 'never'.
    const stored = (parsed.stops as { combat?: unknown } | undefined)?.combat;
    if (typeof stored === 'boolean') merged.stops.combat = stored ? 'always' : 'never';
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // A private window with storage disabled is not a reason to break the game.
  }
}

/** Cards whose triggers the policy bar controls. */
export const POLICY_CARDS: OracleId[] = ['hullbreaker_horror', 'orcish_bowmasters'];
