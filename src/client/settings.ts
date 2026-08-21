import type { OracleId } from '@engine/types';

/**
 * Client-side comfort settings.
 *
 * None of this lives in the engine: auto-passing here means the client sends a real
 * pass intent, so the action log stays complete and replays are unaffected.
 */

export type StopMode = 'always' | 'ifIHaveAnswer' | 'never';

export interface StopSettings {
  /** Stop in my own main phase whenever I have something to do. */
  myMainPhase: boolean;
  /** Stop when an opposing spell is on the stack. */
  opponentSpellOnStack: StopMode;
  /** Stop in the opponent's end step. */
  opponentEndStep: StopMode;
  /** Stop before combat steps. */
  combat: boolean;
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

export interface Settings {
  stops: StopSettings;
  triggers: TriggerPolicy;
  /** Hold priority automatically while an Omniscience is out. */
  autoHoldUnderOmniscience: boolean;
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
    combat: true,
    opponentUpkeep: false,
  },
  triggers: {
    hullbreaker: 'ask',
    bowmasters: 'ifUnambiguous',
    rememberTriggerOrder: true,
  },
  autoHoldUnderOmniscience: true,
  warnOnFloatingMana: true,
  confirmLifePaymentBelow: 6,
  autoTapMana: true,
  animationMs: 180,
  showCardArt: true,
  autoPassDelayMs: [150, 400],
};

const KEY = 'satm.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Merge so a new setting added later still gets its default.
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      stops: { ...DEFAULT_SETTINGS.stops, ...(parsed.stops ?? {}) },
      triggers: { ...DEFAULT_SETTINGS.triggers, ...(parsed.triggers ?? {}) },
    };
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
