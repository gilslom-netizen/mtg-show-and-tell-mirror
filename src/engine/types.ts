/**
 * Core data model for the Show and Tell mirror engine.
 *
 * Design rules that the rest of the engine depends on:
 *  - `GameState` is plain JSON-serialisable data. No class instances, no functions,
 *    no Map/Set. This is what makes snapshots, undo, replay and redaction cheap.
 *  - All randomness flows through `state.rng`. Never call Math.random().
 *  - Zones are ordered arrays of instance ids. `library[0]` is the top of the library.
 */

/**
 * Omit that distributes over a union. Plain `Omit<Union, K>` collapses the union to
 * its shared keys, which would silently erase every per-variant field.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ChoiceRequestDraft = DistributiveOmit<ChoiceRequest, 'id'>;
export type ActiveEffectDraft = DistributiveOmit<ActiveEffect, 'id'>;

export type PlayerId = 'p1' | 'p2';
export type IID = number;
export type OracleId = string;

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];

export type CardType =
  | 'Artifact'
  | 'Battle'
  | 'Creature'
  | 'Enchantment'
  | 'Instant'
  | 'Land'
  | 'Planeswalker'
  | 'Sorcery';

/** The eight types Atraxa's trigger cares about, in a stable display order. */
export const ATRAXA_TYPES: CardType[] = [
  'Artifact',
  'Battle',
  'Creature',
  'Enchantment',
  'Instant',
  'Land',
  'Planeswalker',
  'Sorcery',
];

export type ZoneName = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack';

// ---------------------------------------------------------------------------
// Oracle (static card data — never stored in GameState)
// ---------------------------------------------------------------------------

export interface OracleFace {
  name: string;
  manaCost: string | null;
  mv: number;
  typeLine: string;
  types: CardType[];
  subtypes: string[];
  supertypes: string[];
  colors: Color[];
  oracleText: string;
  power: string | null;
  toughness: string | null;
  keywords: string[];
  producedMana: Color[];
  imageUri: string | null;
}

export interface OracleCard extends OracleFace {
  oracleId: OracleId;
  layout: 'normal' | 'modal_dfc';
  /** Present only for modal DFCs. faces[0] is the front face. */
  faces: OracleFace[] | null;
}

// ---------------------------------------------------------------------------
// Mana
// ---------------------------------------------------------------------------

export type CostSymbol =
  | { t: 'generic'; n: number }
  | { t: 'colored'; c: Color }
  | { t: 'hybridColor'; a: Color; b: Color } // {U/B}
  | { t: 'hybridGeneric'; n: number; c: Color }; // {2/B}

export interface ManaPool {
  W: number;
  U: number;
  B: number;
  R: number;
  G: number;
  C: number;
}

export type ManaKind = keyof ManaPool;

export interface PaymentPlan {
  /** Mana taken from the floating pool. */
  fromPool: ManaPool;
  /** Lands (or other sources) to tap, with the colour each one produces. */
  taps: { iid: IID; produce: ManaKind }[];
}

// ---------------------------------------------------------------------------
// Cards in play
// ---------------------------------------------------------------------------

export interface CardInstance {
  iid: IID;
  oracleId: OracleId;
  owner: PlayerId;
  controller: PlayerId;
  zone: ZoneName;

  tapped: boolean;
  /** True while the creature has not been continuously controlled since your turn began. */
  summoningSick: boolean;
  damage: number;
  deathtouched: boolean;
  counters: Record<string, number>;

  /**
   * For modal DFCs: which face this object currently has.
   * CR 712.8a — in any zone other than battlefield/stack a modal DFC has only its
   * front face characteristics, so this is 'front' everywhere except a played back face.
   */
  face: 'front' | 'back';

  isToken: boolean;
  /** Token characteristics; only set when isToken is true. */
  token?: TokenSpec;

  // --- stack-object fields (only meaningful while zone === 'stack') ---
  targets?: TargetRef[];
  chosenModes?: number[];
  /** Set when cast via Omniscience. Affects delve prompts and the UI. */
  castForFree?: boolean;
  /** Cards exiled to Delve while casting. */
  delved?: IID[];
  /** Mana value snapshotted when the spell was put on the stack (LKI for Mana Drain). */
  stackMv?: number;
  /** True if this stack object is a copy of an ability rather than a card. */
  isAbility?: boolean;
  abilitySource?: IID;
  abilityIndex?: number;
  abilityContext?: Record<string, unknown>;
  /** Human readable label for ability stack objects. */
  abilityLabel?: string;

  /** Combat damage this attacker has already assigned, used for multi-blocker ordering. */
  combatDamageAssigned?: number;
  /** True while this creature is attacking. */
  attacking?: boolean;
}

export interface TokenSpec {
  name: string;
  types: CardType[];
  subtypes: string[];
  colors: Color[];
  power: number;
  toughness: number;
}

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

export type TargetRef =
  | { kind: 'player'; id: PlayerId }
  | { kind: 'permanent'; iid: IID }
  | { kind: 'spell'; iid: IID }
  /** A card in a non-battlefield zone; `zone` is checked again on resolution. */
  | { kind: 'card'; iid: IID; zone: ZoneName };

export type TargetKind = 'player' | 'permanent' | 'spell' | 'card' | 'anyTarget';

export interface TargetSpec {
  kind: TargetKind;
  /** Filter evaluated against the candidate. */
  filter?: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// Turn structure
// ---------------------------------------------------------------------------

export type Phase = 'beginning' | 'precombat_main' | 'combat' | 'postcombat_main' | 'ending';

export type Step =
  | 'untap'
  | 'upkeep'
  | 'draw'
  | 'main'
  | 'begin_combat'
  | 'declare_attackers'
  | 'declare_blockers'
  | 'combat_damage'
  | 'end_of_combat'
  | 'end_step'
  | 'cleanup';

export interface StepRef {
  phase: Phase;
  step: Step;
}

/** The full turn in order. Single combat damage step — nothing in this pool has first strike. */
export const TURN_SEQUENCE: StepRef[] = [
  { phase: 'beginning', step: 'untap' },
  { phase: 'beginning', step: 'upkeep' },
  { phase: 'beginning', step: 'draw' },
  { phase: 'precombat_main', step: 'main' },
  { phase: 'combat', step: 'begin_combat' },
  { phase: 'combat', step: 'declare_attackers' },
  { phase: 'combat', step: 'declare_blockers' },
  { phase: 'combat', step: 'combat_damage' },
  { phase: 'combat', step: 'end_of_combat' },
  { phase: 'postcombat_main', step: 'main' },
  { phase: 'ending', step: 'end_step' },
  { phase: 'ending', step: 'cleanup' },
];

// ---------------------------------------------------------------------------
// Continuous effects
// ---------------------------------------------------------------------------

export type EffectExpiry = 'endOfTurn' | 'permanent';

export type ActiveEffect =
  | {
      kind: 'grantAbility';
      id: number;
      ability: 'hexproofFromBlue' | 'hexproofFromBlack';
      /**
       * Locked in when the effect was created. Veil of Summer says "you and permanents
       * you control", which is evaluated once on resolution — later permanents are NOT
       * protected. See DESIGN.md 8.
       */
      players: PlayerId[];
      iids: IID[];
      expires: EffectExpiry;
    }
  | {
      kind: 'cantBeCountered';
      id: number;
      controller: PlayerId;
      /** 'allThisTurn' = Veil of Summer, 'nextSpell' = Mistrise Village. */
      scope: 'allThisTurn' | 'nextSpell';
      consumed?: boolean;
      expires: EffectExpiry;
    }
  | {
      kind: 'castAsThoughFlash';
      id: number;
      controller: PlayerId;
      expires: EffectExpiry;
    };

export interface DelayedTrigger {
  id: number;
  kind: 'manaDrain';
  controller: PlayerId;
  amount: number;
  /** Fires at the beginning of this player's next main phase. */
  armedOnTurn: number;
}

export interface PendingTrigger {
  id: number;
  sourceIid: IID;
  controller: PlayerId;
  abilityIndex: number;
  label: string;
  /** Information captured at trigger time (LKI). */
  context: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

export interface CombatState {
  attackers: IID[];
  /** blockerIid -> attackerIid */
  blocks: Record<IID, IID>;
  /** attackerIid -> ordered blocker list (damage assignment order) */
  damageOrder: Record<IID, IID[]>;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export interface TurnLogEntry {
  iid: IID;
  oracleId: OracleId;
  colors: Color[];
  mv: number;
}

export interface PlayerState {
  id: PlayerId;
  life: number;
  landDropsUsed: number;
  landDropsAllowed: number;
  manaPool: ManaPool;
  /** Reset at the start of each turn. Needed by Veil of Summer. */
  spellsCastThisTurn: TurnLogEntry[];
  /** Reset at the start of each turn. Drives the Omniscience cast counter in the UI. */
  spellsCastThisTurnCount: number;
  /** Reset when the draw step begins. Drives the Orcish Bowmasters exception. */
  drawsThisDrawStep: number;
  /** Set when a draw was attempted from an empty library — SBA turns this into a loss. */
  triedToDrawFromEmpty: boolean;
  hasLost: boolean;
  lostReason?: 'life' | 'deckOut' | 'concede';
  /** Mulligan bookkeeping. */
  mulligansTaken: number;
  keptHand: boolean;
}

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

export interface ChoiceOptionCard {
  iid: IID;
  /** Set when the option is shown but not selectable, with the reason why. */
  disabledReason?: string;
}

/** Which card produced a prompt, so the client can apply a per-card auto-policy. */
export interface ChoiceSource {
  iid: IID;
  oracleId: OracleId;
}

export type ChoiceRequest =
  | {
      kind: 'chooseCards';
      id: string;
      source?: ChoiceSource;
      player: PlayerId;
      /** Candidate cards, in the order they should be displayed. */
      options: ChoiceOptionCard[];
      min: number;
      max: number;
      /** When true the response order is meaningful (Brainstorm's "in any order"). */
      ordered: boolean;
      prompt: string;
      /** Where the cards currently live — the UI reveals them from here. */
      from: ZoneName;
      /** True if every player may see these cards (Atraxa's reveal). */
      publicReveal?: boolean;
      /**
       * This question can be put back in the queue and asked again later.
       *
       * Atraxa asks about one card type at a time, and the right answer to
       * "take an instant?" often depends on what the creature and land slots
       * turn out to hold. Deferring moves on to the other types and comes back
       * to this one afterwards; the text describes what "later" means here.
       */
      deferrable?: string;
    }
  | {
      kind: 'chooseTargets';
      id: string;
      source?: ChoiceSource;
      player: PlayerId;
      candidates: TargetRef[];
      count: number;
      optional: boolean;
      prompt: string;
    }
  | {
      kind: 'chooseMode';
      id: string;
      source?: ChoiceSource;
      player: PlayerId;
      modes: { index: number; text: string; enabled: boolean; disabledReason?: string }[];
      min: number;
      max: number;
      prompt: string;
    }
  | {
      kind: 'yesNo';
      id: string;
      source?: ChoiceSource;
      player: PlayerId;
      prompt: string;
      yesLabel?: string;
      noLabel?: string;
    }
  | {
      kind: 'orderTriggers';
      id: string;
      source?: ChoiceSource;
      player: PlayerId;
      triggers: { id: number; label: string; sourceIid: IID }[];
      prompt: string;
    }
  | {
      kind: 'distributeDamage';
      id: string;
      source?: ChoiceSource;
      player: PlayerId;
      attacker: IID;
      blockers: IID[];
      total: number;
      prompt: string;
    }
  | {
      kind: 'declareAttackers';
      id: string;
      source?: ChoiceSource;
      player: PlayerId;
      candidates: IID[];
      prompt: string;
    }
  | {
      kind: 'declareBlockers';
      id: string;
      source?: ChoiceSource;
      player: PlayerId;
      attackers: IID[];
      blockers: IID[];
      prompt: string;
    }
  | {
      /**
       * Keep or mulligan — asked of both players at once.
       *
       * Asking them in turn was correct and felt broken: after you mulliganed,
       * your next hand only arrived once the opponent had also decided, with
       * nothing on screen to say so. Each player answers independently and the
       * round resolves when both have.
       */
      kind: 'mulligan';
      id: string;
      source?: ChoiceSource;
      player: null;
      awaiting: PlayerId[];
      lockedIn: PlayerId[];
      hands: Record<PlayerId, { handSize: number; mulligansTaken: number }>;
      prompt: string;
    }
  | {
      /**
       * The primitive that defines this format. Both players answer in secret;
       * neither response is revealed until both have locked in.
       * See DESIGN.md 7.3.
       */
      kind: 'simultaneousSecret';
      id: string;
      source?: ChoiceSource;
      player: null;
      awaiting: PlayerId[];
      requests: Record<PlayerId, { options: ChoiceOptionCard[]; prompt: string }>;
      lockedIn: PlayerId[];
      prompt: string;
    };

export type ChoiceResponse =
  | {
      kind: 'cards';
      iids: IID[];
      /** Ask me again after the other questions — only for a deferrable choice. */
      deferred?: boolean;
    }
  | { kind: 'targets'; targets: TargetRef[] }
  | { kind: 'modes'; modes: number[] }
  | { kind: 'yesNo'; value: boolean }
  /** One mulligan round: what each player decided. */
  | { kind: 'mulliganRound'; keep: Partial<Record<PlayerId, boolean>> }
  | { kind: 'order'; ids: number[] }
  | { kind: 'damage'; assignment: Record<IID, number> }
  | { kind: 'attackers'; iids: IID[] }
  | { kind: 'blockers'; blocks: { blocker: IID; attacker: IID }[] }
  | { kind: 'secret'; iid: IID | null };

// ---------------------------------------------------------------------------
// Events (for animation, logging and tests)
// ---------------------------------------------------------------------------

export type GameEvent =
  /**
   * `firstOfDrawStep` is captured here rather than recomputed later, because the
   * Orcish Bowmasters exception ("except the first one they draw in each of their
   * draw steps") has to be evaluated at the moment of the draw.
   */
  | { t: 'draw'; player: PlayerId; iid: IID | null; firstOfDrawStep: boolean }
  /**
   * `position` is carried so the client can maintain an honest "known top of
   * library" tracker from information the player legitimately saw.
   */
  | {
      t: 'zoneChange';
      iid: IID;
      from: ZoneName;
      to: ZoneName;
      owner: PlayerId;
      position?: 'top' | 'bottom';
    }
  | { t: 'spellCast'; iid: IID; controller: PlayerId; free: boolean }
  | { t: 'spellResolved'; iid: IID }
  | { t: 'spellCountered'; iid: IID; by: IID | null }
  | { t: 'spellFizzled'; iid: IID }
  | { t: 'abilityTriggered'; sourceIid: IID; label: string; controller: PlayerId }
  | { t: 'entersBattlefield'; iid: IID; controller: PlayerId }
  | { t: 'leavesBattlefield'; iid: IID; controller: PlayerId }
  | { t: 'damage'; sourceIid: IID | null; target: TargetRef; amount: number; deathtouch: boolean }
  | { t: 'lifeChange'; player: PlayerId; delta: number; total: number }
  | { t: 'shuffle'; player: PlayerId }
  /** Someone locked in half of a shared choice; the other player's view changed. */
  | { t: 'choiceProgress' }
  | { t: 'tapped'; iid: IID }
  | { t: 'untapped'; iid: IID }
  | { t: 'counterAdded'; iid: IID; kind: string; n: number }
  | { t: 'tokenCreated'; iid: IID; controller: PlayerId }
  | { t: 'stepChange'; phase: Phase; step: Step; turn: number; activePlayer: PlayerId }
  | { t: 'manaAdded'; player: PlayerId; pool: ManaPool }
  | { t: 'manaEmptied'; player: PlayerId }
  | { t: 'gameOver'; winner: PlayerId | 'draw'; reason: string }
  | { t: 'log'; text: string; player?: PlayerId };

export interface LogEntry {
  seq: number;
  turn: number;
  text: string;
  player?: PlayerId;
  /** Cards this line refers to, so the UI can highlight them on hover. */
  iids: IID[];
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

export type GamePhaseKind = 'mulligan' | 'playing' | 'over';

export interface GameState {
  gameId: string;
  rng: RngState;
  mode: GamePhaseKind;

  turn: number;
  activePlayer: PlayerId;
  /** Who was on the play — they skip their first draw step. */
  startingPlayer: PlayerId;
  phase: Phase;
  step: Step;
  /** Index into TURN_SEQUENCE. */
  stepIndex: number;
  /** False until this step's turn-based actions have run. */
  stepInitialized: boolean;

  cards: Record<IID, CardInstance>;
  nextIid: IID;
  zones: Record<PlayerId, Record<Exclude<ZoneName, 'stack'>, IID[]>>;
  /** Shared zone. Last element is the top of the stack. */
  stack: IID[];

  players: Record<PlayerId, PlayerState>;

  priorityPlayer: PlayerId | null;
  /** Players who have passed since the last time something happened. */
  passed: PlayerId[];

  pendingTriggers: PendingTrigger[];
  effects: ActiveEffect[];
  delayed: DelayedTrigger[];
  nextEffectId: number;

  pendingChoice: ChoiceRequest | null;
  /** Responses collected for a simultaneousSecret choice, hidden until everyone locks in. */
  secretResponses: Partial<Record<PlayerId, IID | null>>;
  /** Keep/mulligan answers for the round in progress. */
  mulliganResponses: Partial<Record<PlayerId, boolean>>;

  combat: CombatState | null;
  /** Set while a spell is being cast, so triggers know. */
  castingIid: IID | null;

  winner: PlayerId | 'draw' | null;
  endReason: string | null;

  log: LogEntry[];
  nextLogSeq: number;
}
