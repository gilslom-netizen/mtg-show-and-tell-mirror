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
} from './types';

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
  /** The searchable subset. Assemble the Team passes only the top third. */
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
  /** Returns false when the spell could not be countered. */
  counterSpell(iid: IID): boolean;
  /** Mana Drain's delayed trigger: mana at the beginning of your next main phase. */
  addDelayedMana(player: PlayerId, amount: number): void;
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

export interface CardScript {
  oracleId: OracleId;
  /** Overrides the timing derived from the type line and Flash. */
  timing?: 'instant' | 'sorcery';
  cantBeCountered?: boolean;
  hasDelve?: boolean;
  targets?: TargetDef[];
  /** Extra legality check when casting (beyond timing and cost). */
  canCast?: (state: GameState, controller: PlayerId, self: CardInstance) => boolean;
  resolve?: (ctx: Ctx) => Eff;
  /** Replacement effect applied as the permanent enters (shocklands, conditional tapped). */
  asEnters?: (ctx: Ctx) => Eff;
  abilities?: Ability[];
}
