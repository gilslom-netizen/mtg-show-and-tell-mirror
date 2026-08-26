import type {
  ActiveEffectDraft,
  ChoiceSource,
  CardInstance,
  ChoiceRequest,
  ChoiceResponse,
  GameEvent,
  GameState,
  IID,
  ManaKind,
  OracleId,
  PlayerId,
  TargetRef,
  TokenSpec,
  ZoneName,
} from './types.js';

/**
 * A resolution step. Card scripts are generators so that a multi-choice resolution
 * (Atraxa: reveal ten, then pick one of each type, then bottom the rest) reads in the
 * same order as the card text instead of becoming a state machine. See DESIGN.md 7.1.
 */
export type Eff<R = void> = Generator<ChoiceRequest, R, ChoiceResponse>;

export interface ChooseCardsOpts {
  player: PlayerId;
  /** Candidate cards. Order is the display order. */
  cards: IID[];
  min: number;
  max: number;
  /** True when the response order matters (Brainstorm puts them back "in any order"). */
  ordered?: boolean;
  prompt: string;
  from: ZoneName;
  /** Both players may look (Atraxa's reveal). */
  publicReveal?: boolean;
  /** Cards to display greyed out with a reason, for teaching and clarity. */
  disabled?: { iid: IID; reason: string }[];
  /**
   * Offer to postpone this question, with this label on the button. The caller
   * is responsible for asking it again — see Atraxa.
   */
  deferrable?: string;
  /** Filled in automatically by the engine. */
  source?: ChoiceSource;
}

export interface ChooseTargetsOpts {
  player: PlayerId;
  candidates: TargetRef[];
  count: number;
  optional?: boolean;
  prompt: string;
}

export interface SearchOpts {
  player: PlayerId;
  /** The searchable subset — a card that only searches part of the library passes that part. */
  cards: IID[];
  filter?: (c: CardInstance) => boolean;
  prompt: string;
  /** Search may always fail to find (CR 701.19c). */
  optional?: boolean;
  /** Shown greyed out so the player can see what was in the subset but not legal. */
  showIneligible?: boolean;
}

export interface DamageOpts {
  sourceIid: IID | null;
  target: TargetRef;
  amount: number;
  deathtouch?: boolean;
  lifelink?: boolean;
  lifelinkTo?: PlayerId;
}

/** Everything a card script can do. Implemented by Game. */
export interface Ctx {
  readonly state: GameState;
  /** The spell or the source of the ability being resolved. */
  readonly self: CardInstance;
  readonly controller: PlayerId;
  readonly opponent: PlayerId;
  readonly targets: TargetRef[];
  readonly chosenModes: number[];
  /** Information captured when a trigger fired (LKI). */
  readonly context: Record<string, unknown>;

  // --- queries -------------------------------------------------------------
  hand(p: PlayerId): CardInstance[];
  library(p: PlayerId): CardInstance[];
  graveyard(p: PlayerId): CardInstance[];
  exile(p: PlayerId): CardInstance[];
  battlefieldOf(p?: PlayerId): CardInstance[];
  card(iid: IID): CardInstance | undefined;

  // --- immediate actions ---------------------------------------------------
  draw(p: PlayerId, n?: number): void;
  gainLife(p: PlayerId, n: number): void;
  loseLife(p: PlayerId, n: number): void;
  dealDamage(opts: DamageOpts): void;
  addCounters(iid: IID, kind: string, n: number): void;
  shuffleLibrary(p: PlayerId): void;
  createToken(p: PlayerId, spec: TokenSpec): CardInstance;
  addEffect(e: ActiveEffectDraft): void;
  addManaToPool(p: PlayerId, kind: ManaKind, n: number): void;
  emit(events: GameEvent[]): void;
  log(text: string, iids?: IID[]): void;
  /**
   * Returns false when the spell could not be countered. `exile` puts it in exile
   * instead of the graveyard, which is Force of Negation's second sentence.
   */
  counterSpell(iid: IID, opts?: { exile?: boolean }): boolean;
  /** Mana Drain's delayed trigger: mana at the beginning of your next main phase. */
  addDelayedMana(player: PlayerId, amount: number): void;
  /**
   * A pact: pay this at the beginning of your next upkeep, or lose the game.
   * It outlives the card that made it — see DelayedTrigger.
   */
  addDelayedPayment(player: PlayerId, cost: string): void;
  /**
   * Take over a spell on the stack. It resolves for its new controller, and a
   * permanent enters under them; the card still goes to its owner's graveyard.
   * Returns false when it is no longer a spell on the stack.
   */
  gainControlOfSpell(iid: IID, player: PlayerId): boolean;
  /**
   * "You may choose new targets for it." Re-asks the spell's own target
   * definitions, as this player, and applies the answer. Returns false when the
   * spell has no targets to change or none of them could be chosen legally.
   */
  chooseNewTargetsFor(iid: IID, chooser: PlayerId): Eff<boolean>;
  /** Marks a permanent as entering tapped, from inside an asEnters replacement. */
  enterTapped(): void;

  // --- generator actions ---------------------------------------------------
  moveTo(iid: IID, zone: ZoneName, opts?: { position?: 'top' | 'bottom' }): Eff;
  moveToBattlefield(iid: IID, opts?: { tapped?: boolean; face?: 'front' | 'back' }): Eff;
  /** Several cards enter at once — required by Show and Tell. */
  moveSimultaneouslyToBattlefield(entries: { iid: IID; tapped?: boolean }[]): Eff;
  /** Bottom several cards in a random order (Atraxa, Planar Genesis). */
  bottomInRandomOrder(iids: IID[]): void;

  chooseCards(opts: ChooseCardsOpts): Eff<IID[]>;
  /** As `chooseCards`, but reports a postponement instead of swallowing it. */
  chooseCardsOrDefer(opts: ChooseCardsOpts): Eff<{ iids: IID[]; deferred: boolean }>;
  chooseTargets(opts: ChooseTargetsOpts): Eff<TargetRef[]>;
  chooseMode(opts: {
    player: PlayerId;
    modes: { index: number; text: string; enabled: boolean; disabledReason?: string }[];
    min: number;
    max: number;
    prompt: string;
  }): Eff<number[]>;
  yesNo(player: PlayerId, prompt: string, labels?: { yes: string; no: string }): Eff<boolean>;
  searchZone(opts: SearchOpts): Eff<IID | null>;
  surveil(player: PlayerId, n: number): Eff;
  amass(player: PlayerId, subtype: string, n: number): Eff;

  /**
   * Both players choose in secret; nothing is revealed until both lock in.
   * The primitive that makes Show and Tell work. See DESIGN.md 7.3.
   */
  simultaneousSecret(opts: {
    prompt: string;
    optionsFor: (p: PlayerId) => { iid: IID; disabledReason?: string }[];
    promptFor: (p: PlayerId) => string;
  }): Eff<Record<PlayerId, IID | null>>;
}

export interface ActivationCost {
  tap?: boolean;
  life?: number;
  sacrificeSelf?: boolean;
  mana?: string;
}

export interface TargetDef {
  prompt: string;
  optional?: boolean;
  /**
   * How many to choose. 'any' is "any number of target …" — Mindbreak Trap, where
   * exiling one of the four spells they just cast is not the card.
   */
  count?: number | 'any';
  candidates: (state: GameState, controller: PlayerId, self: CardInstance) => TargetRef[];
}

export interface TriggeredAbility {
  kind: 'triggered';
  label: string;
  /**
   * Return false for no trigger, true for one trigger, or a context object that is
   * captured now and handed to resolve() later.
   */
  trigger: (
    ev: GameEvent,
    self: CardInstance,
    state: GameState,
  ) => boolean | Record<string, unknown>;
  targets?: TargetDef[];
  /**
   * Choose modes (and any mode-dependent targets) as the ability is put on the
   * stack — CR 601.2b. Hullbreaker Horror needs this: the opponent must be able to
   * see which spell is being bounced before they decide how to respond.
   * Return null to remove the ability from the stack.
   */
  onStack?: (ctx: Ctx) => Eff<{ modes?: number[]; targets?: TargetRef[] } | null>;
  resolve: (ctx: Ctx) => Eff;
}

export interface ActivatedAbility {
  kind: 'activated';
  text: string;
  cost: ActivationCost;
  /** Sorcery-speed restriction, if any. */
  timing?: 'instant' | 'sorcery';
  targets?: TargetDef[];
  /** Mana abilities do not use the stack and cannot be responded to. */
  isManaAbility?: boolean;
  canActivate?: (state: GameState, self: CardInstance) => boolean;
  resolve: (ctx: Ctx) => Eff;
}

export interface ManaAbility {
  kind: 'mana';
  produces: ManaKind[];
}

export interface StaticAbility {
  kind: 'static';
  text: string;
  /** Recognised by the engine directly. */
  effect: 'castWithoutPayingManaCost';
}

export type Ability = TriggeredAbility | ActivatedAbility | ManaAbility | StaticAbility;

/**
 * "You may … rather than pay this spell's mana cost."
 *
 * A real alternative cost, not a discount: it replaces the mana cost entirely, and
 * it is offered alongside the normal cast rather than instead of it — a Commandeer
 * with seven lands out can be paid for either way, and which one you want depends
 * on what else is in your hand.
 *
 * Timing follows CR 601.2: `available` is asked before the cast is offered, so an
 * unpayable alternative never appears; `pay` runs after targets are chosen, in the
 * same place the mana payment would have been, so exiling the two blue cards
 * happens knowing what the spell is pointed at.
 */
export interface AlternativeCost {
  /** Completes the button: `Cast Commandeer (exile two blue cards)`. */
  label: string;
  /** Whether it could be paid right now. Checked before the cast is offered. */
  available: (state: GameState, controller: PlayerId, self: CardInstance) => boolean;
  /**
   * Pay it. Returning false puts the spell back in hand, exactly as an unpayable
   * mana cost does — the player is allowed to change their mind halfway through.
   */
  pay: (ctx: Ctx) => Eff<boolean>;
}

export interface CardScript {
  oracleId: OracleId;
  /** Overrides the timing derived from the type line and Flash. */
  timing?: 'instant' | 'sorcery';
  cantBeCountered?: boolean;
  hasDelve?: boolean;
  targets?: TargetDef[];
  /** Extra legality check when casting (beyond timing and cost). */
  canCast?: (state: GameState, controller: PlayerId, self: CardInstance) => boolean;
  /** "You may … rather than pay this spell's mana cost." */
  altCost?: AlternativeCost;
  resolve?: (ctx: Ctx) => Eff;
  /** Replacement effect applied as the permanent enters (shocklands, conditional tapped). */
  asEnters?: (ctx: Ctx) => Eff;
  abilities?: Ability[];
}
