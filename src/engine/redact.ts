import { enumerateLegalActions, type LegalAction } from './game.js';
import { currentFace } from './state.js';
import type {
  ActiveEffect,
  CardInstance,
  CardType,
  ChoiceRequest,
  GameEvent,
  CombatState,
  GameState,
  IID,
  LogEntry,
  ManaPool,
  OracleId,
  Phase,
  PlayerId,
  Step,
  TargetRef,
  ZoneName,
} from './types.js';

/**
 * Turning the authoritative state into what one player is allowed to see.
 *
 * The rule this file lives by: build the view from scratch, field by field.
 * Never spread GameState and delete the secrets — a `delete` that is forgotten
 * when a new field is added is exactly how hidden information leaks, and in this
 * format knowing the top of the opponent's library or their Show and Tell pick is
 * the whole game.
 */

export interface CardView {
  iid: IID;
  oracleId: OracleId;
  owner: PlayerId;
  controller: PlayerId;
  zone: ZoneName;
  tapped: boolean;
  summoningSick: boolean;
  damage: number;
  counters: Record<string, number>;
  face: 'front' | 'back';
  isToken: boolean;
  tokenName?: string;
  /**
   * A token's printed line and reminder text.
   *
   * Sent because the client has no oracle entry to look a token up in and was
   * therefore inventing one — every token was drawn as `Token Creature`, which
   * is how a Clue came to show a type it does not have and a 0/0 it does not
   * have either. A token on the battlefield is public to both players, so there
   * is nothing here to redact.
   */
  tokenTypeLine?: string;
  tokenTypes?: CardType[];
  tokenText?: string;
  power?: number;
  toughness?: number;
  attacking?: boolean;
  /** Stack objects. */
  isAbility?: boolean;
  abilityLabel?: string;
  abilitySource?: IID;
  /**
   * Which of the source's abilities this stack object is.
   *
   * Public: the ability is on the stack with its text showing, so nothing is
   * being leaked — and the search's rebuild needs it, because a card with three
   * activated abilities cannot be reconstructed from the label alone.
   */
  abilityIndex?: number;
  /** The source's name, so the stack reads right even when the card is hidden. */
  abilitySourceName?: string;
  targets?: TargetRef[];
  castForFree?: boolean;
}

export interface PlayerPublicView {
  id: PlayerId;
  life: number;
  handCount: number;
  libraryCount: number;
  graveyardCount: number;
  exileCount: number;
  manaPool: ManaPool;
  landDropsUsed: number;
  landDropsAllowed: number;
  spellsCastThisTurnCount: number;
  hasLost: boolean;
  mulligansTaken: number;
}

/** A pending choice with every trace of the other player's hidden information gone. */
export type ChoiceView =
  | Exclude<ChoiceRequest, { kind: 'simultaneousSecret' } | { kind: 'mulligan' }>
  | {
      kind: 'mulligan';
      id: string;
      prompt: string;
      /** This viewer's own count — the opponent's is public and shown separately. */
      mulligansTaken: number;
      opponentMulligansTaken: number;
      opponentHandSize: number;
      /** Both players answer at once, so each side needs to see where the other is. */
      iHaveDecided: boolean;
      opponentDecided: boolean;
    }
  | {
      kind: 'simultaneousSecret';
      id: string;
      prompt: string;
      /** Only ever this viewer's own options. */
      myOptions: { iid: IID; disabledReason?: string }[];
      myPrompt: string;
      /** Whether each side has committed — but never what they committed to. */
      opponentLockedIn: boolean;
      iHaveLockedIn: boolean;
    };

export interface PlayerView {
  gameId: string;
  viewer: PlayerId;
  mode: GameState['mode'];
  turn: number;
  activePlayer: PlayerId;
  /**
   * Who was on the play. Public information - it decided the first draw step -
   * and a playtest showed the cost of hiding it: a player who did not know he
   * was second read his own (perfectly legal) first draw as a bug.
   */
  startingPlayer: PlayerId;
  phase: Phase;
  step: Step;
  priorityPlayer: PlayerId | null;
  passed: PlayerId[];
  winner: PlayerId | 'draw' | null;
  endReason: string | null;

  players: Record<PlayerId, PlayerPublicView>;
  /** Your hand, in order. */
  hand: IID[];
  /** Card objects for everything you are allowed to see. */
  cards: Record<IID, CardView>;
  battlefield: Record<PlayerId, IID[]>;
  graveyard: Record<PlayerId, IID[]>;
  exile: Record<PlayerId, IID[]>;
  stack: IID[];

  combat: CombatState | null;
  effects: ActiveEffect[];
  delayedMana: { controller: PlayerId; amount: number }[];
  /**
   * Pacts that come due at their controller's next upkeep. Public: the spell
   * resolved in the open, and forgetting one loses the game on the spot.
   */
  pacts: { controller: PlayerId; cost: string }[];

  choice: ChoiceView | null;
  /** True when a choice is pending but it belongs to the other player. */
  waitingOnOpponentChoice: boolean;

  log: LogEntry[];
  legalActions: LegalAction[];
  /** Convenience flag for the client's Omniscience mode. */
  omniscienceActive: boolean;
}

function viewCard(state: GameState, c: CardInstance): CardView {
  const face = currentFace(c);
  const out: CardView = {
    iid: c.iid,
    oracleId: c.oracleId,
    owner: c.owner,
    controller: c.controller,
    zone: c.zone,
    tapped: c.tapped,
    summoningSick: c.summoningSick,
    damage: c.damage,
    counters: { ...c.counters },
    face: c.face,
    isToken: c.isToken,
  };
  if (c.isToken && c.token) {
    out.tokenName = c.token.name;
    out.tokenTypeLine = face.typeLine;
    out.tokenTypes = face.types;
    if (face.oracleText) out.tokenText = face.oracleText;
  }
  if (face.power !== null) {
    out.power = (Number(face.power) || 0) + (c.counters['+1/+1'] ?? 0);
    out.toughness = (Number(face.toughness) || 0) + (c.counters['+1/+1'] ?? 0);
  }
  if (c.attacking) out.attacking = true;
  if (c.isAbility) {
    out.isAbility = true;
    out.abilityLabel = c.abilityLabel;
    out.abilitySource = c.abilitySource;
    out.abilityIndex = c.abilityIndex;
    /*
     * The name of whatever put this on the stack, carried on the ability itself.
     *
     * Both players watched the trigger happen, so the name is not a secret — but
     * the source card can be somewhere private by the time the trigger resolves.
     * A Hullbreaker Horror is allowed to bounce itself, and then its own trigger
     * is on the stack pointing at a card sitting in its owner's hand. Handing out
     * the card object to say "Hullbreaker Horror: return target…" put a card in
     * the opponent's hand on their opponent's screen; the name alone does not.
     */
    const src = c.abilitySource !== undefined ? state.cards[c.abilitySource] : undefined;
    if (src) out.abilitySourceName = src.isToken ? (src.token?.name ?? 'Token') : currentFace(src).name;
  }
  if (c.targets) out.targets = c.targets;
  if (c.castForFree) out.castForFree = true;
  return out;
}

/** Which card ids this viewer is entitled to see the identity of. */
function visibleIids(state: GameState, viewer: PlayerId): Set<IID> {
  const out = new Set<IID>();
  const add = (ids: IID[]) => ids.forEach((i) => out.add(i));

  for (const p of ['p1', 'p2'] as PlayerId[]) {
    add(state.zones[p].battlefield);
    add(state.zones[p].graveyard);
    add(state.zones[p].exile);
  }
  add(state.stack);
  add(state.zones[viewer].hand);

  // Cards a pending choice legitimately shows this player (a search, a surveil,
  // Atraxa's public reveal).
  const pc = state.pendingChoice;
  if (pc) {
    if (pc.kind === 'chooseCards' && (pc.player === viewer || pc.publicReveal)) {
      add(pc.options.map((o) => o.iid));
    }
    if (pc.kind === 'simultaneousSecret') {
      add(pc.requests[viewer].options.map((o) => o.iid));
    }
  }

  /*
   * Ability stack objects reference their source, which may have left the
   * battlefield — the graveyard and exile are public, so those are fine to show.
   * A source that has gone somewhere private is not: see `abilitySourceName`.
   */
  for (const iid of state.stack) {
    const c = state.cards[iid];
    if (c?.abilitySource === undefined) continue;
    const src = state.cards[c.abilitySource];
    if (src && src.zone !== 'hand' && src.zone !== 'library') out.add(c.abilitySource);
  }
  return out;
}

function redactChoice(state: GameState, viewer: PlayerId): ChoiceView | null {
  const pc = state.pendingChoice;
  if (!pc) return null;

  if (pc.kind === 'simultaneousSecret') {
    const opponent: PlayerId = viewer === 'p1' ? 'p2' : 'p1';
    return {
      kind: 'simultaneousSecret',
      id: pc.id,
      prompt: pc.prompt,
      // Only this player's own options. Sending pc.requests wholesale would hand
      // over the opponent's entire hand.
      myOptions: pc.requests[viewer].options.map((o) => ({
        iid: o.iid,
        disabledReason: o.disabledReason,
      })),
      myPrompt: pc.requests[viewer].prompt,
      opponentLockedIn: pc.lockedIn.includes(opponent),
      iHaveLockedIn: pc.lockedIn.includes(viewer),
    };
  }

  if (pc.kind === 'mulligan') {
    const opponent: PlayerId = viewer === 'p1' ? 'p2' : 'p1';
    // What each player decided stays hidden until the round resolves — otherwise
    // the second to answer would know whether they are facing a fresh seven.
    return {
      kind: 'mulligan',
      id: pc.id,
      prompt: pc.prompt,
      mulligansTaken: pc.hands[viewer].mulligansTaken,
      opponentMulligansTaken: pc.hands[opponent].mulligansTaken,
      opponentHandSize: pc.hands[opponent].handSize,
      iHaveDecided: pc.lockedIn.includes(viewer),
      opponentDecided: pc.lockedIn.includes(opponent),
    };
  }

  if (pc.player !== viewer) return null;
  return pc;
}

/**
 * Events are as leaky as state: a `draw` event carries the id of the card that was
 * drawn, and a zoneChange in or out of a hand or library identifies a hidden card.
 * They go through the same filter before they are sent anywhere.
 */
export function redactEvents(
  state: GameState,
  viewer: PlayerId,
  events: GameEvent[],
): GameEvent[] {
  const visible = visibleIids(state, viewer);
  const out: GameEvent[] = [];
  for (const ev of events) {
    if (ev.t === 'draw') {
      out.push(ev.player === viewer ? ev : { ...ev, iid: null });
      continue;
    }
    if (ev.t === 'zoneChange') {
      const privateZone = (z: ZoneName) => z === 'library' || z === 'hand';
      const hidden = privateZone(ev.from) || privateZone(ev.to);
      // Keep it only when the viewer may know which card moved.
      if (hidden && ev.owner !== viewer && !visible.has(ev.iid)) continue;
      out.push(ev);
      continue;
    }
    out.push(ev);
  }
  return out;
}

export function redact(state: GameState, viewer: PlayerId): PlayerView {
  const visible = visibleIids(state, viewer);
  const cards: Record<IID, CardView> = {};
  for (const iid of visible) {
    const c = state.cards[iid];
    if (c) cards[iid] = viewCard(state, c);
  }

  const publicOf = (p: PlayerId): PlayerPublicView => {
    const ps = state.players[p];
    return {
      id: p,
      life: ps.life,
      handCount: state.zones[p].hand.length,
      // Counts only. The order of a library is never sent to anyone, not even to
      // its owner — the client learns the top from reveal events instead.
      libraryCount: state.zones[p].library.length,
      graveyardCount: state.zones[p].graveyard.length,
      exileCount: state.zones[p].exile.length,
      manaPool: { ...ps.manaPool },
      landDropsUsed: ps.landDropsUsed,
      landDropsAllowed: ps.landDropsAllowed,
      spellsCastThisTurnCount: ps.spellsCastThisTurnCount,
      hasLost: ps.hasLost,
      mulligansTaken: ps.mulligansTaken,
    };
  };

  const choice = redactChoice(state, viewer);

  return {
    gameId: state.gameId,
    viewer,
    mode: state.mode,
    turn: state.turn,
    activePlayer: state.activePlayer,
    startingPlayer: state.startingPlayer,
    phase: state.phase,
    step: state.step,
    priorityPlayer: state.priorityPlayer,
    passed: [...state.passed],
    winner: state.winner,
    endReason: state.endReason,

    players: { p1: publicOf('p1'), p2: publicOf('p2') },
    hand: [...state.zones[viewer].hand],
    cards,
    battlefield: {
      p1: [...state.zones.p1.battlefield],
      p2: [...state.zones.p2.battlefield],
    },
    graveyard: {
      p1: [...state.zones.p1.graveyard],
      p2: [...state.zones.p2.graveyard],
    },
    exile: { p1: [...state.zones.p1.exile], p2: [...state.zones.p2.exile] },
    stack: [...state.stack],

    combat: state.combat ? JSON.parse(JSON.stringify(state.combat)) : null,
    effects: JSON.parse(JSON.stringify(state.effects)),
    delayedMana: state.delayed
      .filter((d) => d.kind === 'manaDrain')
      .map((d) => ({ controller: d.controller, amount: d.amount })),
    pacts: state.delayed
      .filter((d) => d.kind === 'pact')
      .map((d) => ({ controller: d.controller, cost: d.cost })),

    choice,
    waitingOnOpponentChoice: state.pendingChoice !== null && choice === null,

    log: state.log.slice(-200),
    legalActions: enumerateLegalActions(state, viewer),
    omniscienceActive: state.zones[viewer].battlefield.some(
      (iid) => state.cards[iid]?.oracleId === 'omniscience',
    ),
  };
}
