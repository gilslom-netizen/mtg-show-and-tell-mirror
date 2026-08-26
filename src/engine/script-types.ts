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
  /** Combat damage, as opposed to a ping. Psychic Frog only draws off combat. */
  combat?: boolean;
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
  counterSpell(iid: IID, opts?: { exile?: boolean; toLibraryTop?: boolean }): boolean;
  /**
   * Offer a player the chance to pay a cost, and report whether they did.
   *
   * The prompt is skipped when they could not pay it anyway: a question with
   * one available answer is just a slower way of saying no.
   */
  payOrDecline(player: PlayerId, cost: string, prompt: string): Eff<boolean>;
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
  /** Copy a spell on the stack; the copy ceases to exist when it leaves. */
  copySpell(iid: IID, controller: PlayerId, opts?: { mayRetarget?: boolean }): Eff<IID | null>;
  /** Attach an aura to a permanent. */
  attachTo(auraIid: IID, hostIid: IID): void;
  /** Put the top card of a library onto the battlefield face down as a 2/2. */
  manifest(player: PlayerId, iid: IID): Eff;
  /** A card leaves the battlefield for its owner's graveyard, as a sacrifice. */
  sacrifice(iid: IID): Eff;
  /** Mill: N off the top of a library into its graveyard. */
  mill(player: PlayerId, n: number): Eff;
  /** Sacrifice this permanent at the beginning of the next end step. */
  sacrificeAtNextEndStep(player: PlayerId, iid: IID): void;
  /** Ask a player to name a card from a list of names. */
  chooseName(player: PlayerId, names: string[], prompt: string): Eff<string | null>;
  /** Ask a player to choose a colour of mana. */
  chooseColour(player: PlayerId, prompt: string): Eff<ManaKind | null>;
  /** Chrome Mox: record which exiled card this artifact taps for. */
  setImprint(auraIid: IID, cardIid: IID): void;
  /** Record a choice a permanent locked in as it entered (a colour, a mode). */
  setNamedChoice(iid: IID, choice: string): void;
  /** Untap a permanent. */
  untap(iid: IID): void;
  /** Turn a transforming permanent over to its other face. */
  transform(iid: IID): void;
  /** Marks a permanent as entering tapped, from inside an asEnters replacement. */
  enterTapped(): void;

  // --- generator actions ---------------------------------------------------
  moveTo(iid: IID, zone: ZoneName, opts?: { position?: 'top' | 'bottom' }): Eff;
  /**
   * `controller` matters more than it looks: Reanimate puts their creature onto
   * the battlefield under *your* control, and Stronghold Gambit puts each card
   * back under its own owner's.
   */
  moveToBattlefield(
    iid: IID,
    opts?: { tapped?: boolean; face?: 'front' | 'back'; controller?: PlayerId },
  ): Eff;
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
  /**
   * A loyalty ability: the signed change to this planeswalker's loyalty.
   * Implies sorcery timing and once per turn per permanent (CR 606.3, 118.6).
   */
  loyalty?: number;
  /** Discard this many cards as part of the cost (Psychic Frog). */
  discard?: number;
  /** Exile this many cards from your graveyard as part of the cost. */
  exileFromGraveyard?: number;
  /**
   * A -X loyalty ability: the player chooses X, up to the loyalty available.
   * The chosen value reaches the script as `ctx.context.x`.
   */
  loyaltyX?: boolean;
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
  /** Chrome Mox: the colours come from the imprinted card, not the printing. */
  fromImprint?: boolean;
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
  /**
   * Kicker: an optional extra cost offered as a second way to cast. The engine
   * pays base+kicker and sets `kicked` on the instance; the script reads it.
   */
  kicker?: { cost: string; label: string };
  /**
   * A non-mana additional cost (Bitter Triumph's discard-or-life, Abhorrent
   * Oculus's exile six). `canPay` gates the cast being offered at all; `pay`
   * runs after targets, alongside the mana payment. Returning false backs out.
   */
  additionalCost?: {
    label: string;
    canPay: (state: GameState, controller: PlayerId) => boolean;
    pay: (ctx: Ctx) => Eff<boolean>;
  };
  /**
   * A modal spell. Modes and their targets are chosen as the spell goes on the
   * stack (CR 601.2b), so the opponent sees what is coming before deciding how
   * to respond — the same reason Hullbreaker's trigger has `onStack`.
   *
   * `ctx.chosenModes` holds the picks on resolution, and the targets of every
   * chosen mode are concatenated into `ctx.targets` in mode order.
   */
  modes?: {
    min: number;
    max: number;
    prompt: string;
    options: {
      text: string;
      /** Whether this mode can be chosen at all right now. */
      enabled?: (state: GameState, controller: PlayerId, self: CardInstance) => boolean;
      targets?: TargetDef[];
    }[];
  };
  /** Split second: while this is on the stack, nobody casts or activates. */
  splitSecond?: boolean;
  /**
   * Generic mana this spell costs less to cast right now (Mystical Dispute's
   * {2} off against a blue spell). Applied to the generic portion only, which
   * is what a cost reduction can reach (CR 601.2f).
   */
  costReduction?: (state: GameState, controller: PlayerId, self: CardInstance) => number;
  /** Storm: copy for each spell cast before it this turn. */
  storm?: boolean;
  /**
   * An aura. `enchant` filters legal targets; on resolution the permanent
   * attaches to its chosen target. SBA kill it when the target is gone.
   */
  enchant?: {
    prompt: string;
    candidates: (state: GameState, controller: PlayerId) => TargetRef[];
  };
  /** A saga: how many chapters before it is sacrificed. Uses 'lore' counters. */
  saga?: { chapters: number };
  /** Cumulative upkeep cost per age counter, as a mana string ('{1}'). */
  cumulativeUpkeep?: string;
  /**
   * Static power/toughness contribution, recomputed live. Self-buffs (delirium)
   * get `self`; an aura's grant to what it enchants uses `enchanted`.
   */
  staticPt?: {
    self?: (state: GameState, card: CardInstance) => { power: number; toughness: number };
    enchanted?: { power: number; toughness: number };
  };
  /** Escape: cast from the graveyard for this cost plus exiling others. */
  escape?: { cost: string; exile: number };
  /** Keywords this permanent has right now, beyond the printed ones. */
  grantsKeywords?: (state: GameState, card: CardInstance) => string[];
  /**
   * Continuous rules changes a permanent makes while it is on the battlefield.
   *
   * These are re-derived wherever the rule is asked rather than granted once as
   * an effect, because they have to stop the instant the permanent leaves — a
   * Lier that dies mid-turn must not still be turning off counterspells.
   */
  staticRules?: {
    /** Lier: nothing can be countered while this is out. */
    spellsCantBeCountered?: boolean;
    /** Cards in a graveyard this permanent lets you cast with flashback. */
    graveyardFlashbackFor?: (state: GameState, card: CardInstance) => IID[];
    /** Cards on top of a library this permanent lets you play. */
    playFromLibraryTop?: (state: GameState, card: CardInstance) => IID[];
    /** Cards in a graveyard this permanent lets you play (Glacierwood Sultai). */
    playFromGraveyard?: (state: GameState, card: CardInstance) => IID[];
  };
  /**
   * Utopia Sprawl: tapping the enchanted land for mana adds one more of the
   * colour chosen as this entered. A triggered mana ability, so it never uses
   * the stack (CR 605.1b) — the engine folds it into tapForMana.
   */
  enchantedTapBonus?: boolean;
  resolve?: (ctx: Ctx) => Eff;
  /** Replacement effect applied as the permanent enters (shocklands, conditional tapped). */
  asEnters?: (ctx: Ctx) => Eff;
  abilities?: Ability[];
}
