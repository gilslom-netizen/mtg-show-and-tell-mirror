import { faceOf, frontFace, oracle } from './oracle.js';
import { emptyPool } from './mana.js';
import { seedRng, shuffleArray } from './rng.js';
import {
  type CardInstance,
  type CardType,
  type GameEvent,
  type GameState,
  type IID,
  type OracleFace,
  type OracleId,
  type PlayerId,
  type PlayerState,
  type TargetRef,
  type TokenSpec,
  type ZoneName,
  TURN_SEQUENCE,
} from './types.js';

/** Pure helpers over GameState. Nothing here yields choices or runs the turn loop. */

export function otherPlayer(p: PlayerId): PlayerId {
  return p === 'p1' ? 'p2' : 'p1';
}

/**
 * How many mulligans cost you nothing.
 *
 * The Commander rule, and it belongs here for the same reason it exists there: in
 * a format where one card decides the game, a hand with none of it is not a game.
 * Both players run the same sixty, so a free look costs neither of them anything
 * relative to the other — what it buys is fewer games that were over before they
 * started.
 */
export const FREE_MULLIGANS = 1;

/**
 * Cards that go to the bottom after keeping, London-style.
 *
 * One number, derived in one place, because three of them read it: the engine
 * bottoms this many, the client says so on the button, and the agent judges the
 * best `7 - this` of what it is looking at. They were three separate subtractions
 * of `mulligansTaken` before, which is exactly the shape of thing that gets fixed
 * in two places out of three.
 */
export function cardsToBottom(mulligansTaken: number): number {
  return Math.max(0, mulligansTaken - FREE_MULLIGANS);
}

/** What a hand would be worth after this many mulligans: seven, less the bottoming. */
export function handSizeAfter(mulligansTaken: number): number {
  return 7 - cardsToBottom(mulligansTaken);
}

export function makePlayerState(id: PlayerId): PlayerState {
  return {
    id,
    life: 20,
    landDropsUsed: 0,
    landDropsAllowed: 1,
    manaPool: emptyPool(),
    spellsCastThisTurn: [],
    spellsCastThisTurnCount: 0,
    drawsThisDrawStep: 0,
    drawsThisTurn: 0,
    triedToDrawFromEmpty: false,
    hasLost: false,
    mulligansTaken: 0,
    keptHand: false,
  };
}

export function makeCard(
  iid: IID,
  oracleId: OracleId,
  owner: PlayerId,
  zone: ZoneName,
): CardInstance {
  return {
    iid,
    oracleId,
    owner,
    controller: owner,
    zone,
    tapped: false,
    summoningSick: false,
    damage: 0,
    deathtouched: false,
    counters: {},
    face: 'front',
    isToken: false,
  };
}

export interface DeckEntry {
  count: number;
  oracleId: OracleId;
}

export function createGameState(opts: {
  gameId: string;
  seed: number;
  /**
   * The deck both players run, for the mirror where that is the whole point.
   * Drafted play gives each seat its own list instead — see `decks`.
   */
  deck?: DeckEntry[];
  /** Per-seat decklists. Takes precedence over `deck` when given. */
  decks?: Record<PlayerId, DeckEntry[]>;
  startingPlayer: PlayerId;
  /** Skip shuffling and opening hands — used by the test harness. */
  bare?: boolean;
}): GameState {
  const state: GameState = {
    gameId: opts.gameId,
    rng: seedRng(opts.seed),
    mode: opts.bare ? 'playing' : 'mulligan',
    turn: 1,
    activePlayer: opts.startingPlayer,
    startingPlayer: opts.startingPlayer,
    phase: 'beginning',
    step: 'untap',
    stepIndex: 0,
    stepInitialized: false,
    cards: {},
    nextIid: 1,
    zones: {
      p1: { library: [], hand: [], battlefield: [], graveyard: [], exile: [] },
      p2: { library: [], hand: [], battlefield: [], graveyard: [], exile: [] },
    },
    stack: [],
    players: { p1: makePlayerState('p1'), p2: makePlayerState('p2') },
    priorityPlayer: null,
    passed: [],
    pendingTriggers: [],
    effects: [],
    delayed: [],
    nextEffectId: 1,
    pendingChoice: null,
    secretResponses: {},
    mulliganResponses: {},
    combat: null,
    castingIid: null,
    winner: null,
    endReason: null,
    log: [],
    nextLogSeq: 1,
    choiceSeq: 0,
  };

  const deckFor = (player: PlayerId): DeckEntry[] => {
    const list = opts.decks?.[player] ?? opts.deck;
    if (!list) throw new Error(`No decklist for ${player}`);
    return list;
  };

  for (const player of ['p1', 'p2'] as PlayerId[]) {
    for (const entry of deckFor(player)) {
      for (let i = 0; i < entry.count; i++) {
        const iid = state.nextIid++;
        state.cards[iid] = makeCard(iid, entry.oracleId, player, 'library');
        state.zones[player].library.push(iid);
      }
    }
    if (!opts.bare) shuffleLibrary(state, player);
  }

  return state;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export function zoneList(state: GameState, player: PlayerId, zone: ZoneName): IID[] {
  if (zone === 'stack') return state.stack;
  return state.zones[player][zone];
}

/** The zone array a card currently lives in. Stack objects live in the shared stack. */
/**
 * The list this card is actually sitting in.
 *
 * Every zone is keyed by owner except the battlefield, which is keyed by
 * controller — because the battlefield is the one zone where the two come
 * apart. Reanimate is the plain case: their creature, your side of the table.
 * Getting this wrong put a reanimated Atraxa into the opponent's row, where it
 * blocked for them and attacked you.
 */
function homeList(state: GameState, card: CardInstance): IID[] {
  if (card.zone === 'stack') return state.stack;
  if (card.zone === 'battlefield') return state.zones[card.controller].battlefield;
  return state.zones[card.owner][card.zone];
}

export function removeFromZone(state: GameState, iid: IID): void {
  const card = state.cards[iid];
  if (!card) return;
  const list = homeList(state, card);
  const i = list.indexOf(iid);
  if (i >= 0) list.splice(i, 1);
}

export interface MoveOptions {
  /** Where in the destination to insert. 'top'/'bottom' apply to the library. */
  position?: 'top' | 'bottom';
  /** Battlefield entries can be tapped. */
  tapped?: boolean;
  /** Which face to use once on the battlefield (modal DFC back face). */
  face?: 'front' | 'back';
  controller?: PlayerId;
}

/**
 * Raw zone change. Does NOT run enter-the-battlefield replacement effects or
 * collect triggers — Game.moveTo handles that so it can yield choices.
 */
export function moveCardRaw(
  state: GameState,
  iid: IID,
  to: ZoneName,
  opts: MoveOptions = {},
): GameEvent[] {
  const card = state.cards[iid];
  const from = card.zone;
  const events: GameEvent[] = [];

  removeFromZone(state, iid);

  // A token that leaves the battlefield ceases to exist (CR 111.7).
  if (card.isToken && from === 'battlefield' && to !== 'battlefield') {
    delete state.cards[iid];
    events.push({ t: 'leavesBattlefield', iid, controller: card.controller });
    events.push({ t: 'zoneChange', iid, from, to, owner: card.owner });
    return events;
  }

  card.zone = to;
  if (opts.controller) card.controller = opts.controller;

  // Reset per-object state whenever an object changes zones — it becomes a new object.
  if (to !== 'battlefield') {
    card.attachedTo = undefined;
    card.faceDown = undefined;
    card.namedChoice = undefined;
    card.loyaltyActivatedTurn = undefined;
    card.tapped = false;
    card.damage = 0;
    card.deathtouched = false;
    card.counters = {};
    card.summoningSick = false;
    card.targets = undefined;
    card.chosenModes = undefined;
    card.castForFree = undefined;
    card.delved = undefined;
    card.stackMv = undefined;
    card.combatDamageAssigned = undefined;
  }
  if (to !== 'battlefield' && to !== 'stack') {
    // CR 712.8a — anywhere but battlefield/stack a modal DFC shows its front face.
    card.face = 'front';
  }
  if (to === 'battlefield') {
    card.tapped = Boolean(opts.tapped);
    card.damage = 0;
    card.deathtouched = false;
    card.summoningSick = true;
    if (opts.face) card.face = opts.face;
    card.controller = opts.controller ?? card.owner;
  }

  if (to === 'stack') {
    state.stack.push(iid);
  } else {
    // The battlefield belongs to whoever controls the permanent; everywhere
    // else belongs to its owner — which is why a creature you stole still goes
    // to their graveyard when it dies. See homeList.
    const list =
      to === 'battlefield'
        ? state.zones[card.controller].battlefield
        : state.zones[card.owner][to];
    if (to === 'library' && opts.position === 'top') list.unshift(iid);
    else list.push(iid);
  }

  if (from === 'battlefield') {
    events.push({ t: 'leavesBattlefield', iid, controller: card.controller });
  }
  events.push({
    t: 'zoneChange',
    iid,
    from,
    to,
    owner: card.owner,
    position: to === 'library' ? (opts.position ?? 'bottom') : undefined,
  });
  if (to === 'battlefield') {
    events.push({ t: 'entersBattlefield', iid, controller: card.controller });
  }
  return events;
}

export function shuffleLibrary(state: GameState, player: PlayerId): void {
  shuffleArray(state.rng, state.zones[player].library);
}

// ---------------------------------------------------------------------------
// Characteristics
// ---------------------------------------------------------------------------

/**
 * The face whose characteristics apply right now.
 * On the battlefield/stack a played back face uses the back face; everywhere else
 * a modal DFC is its front face (CR 712.8a).
 */
/** What a face-down permanent looks like to the rules: a 2/2 with nothing else. */
const FACE_DOWN_FACE: OracleFace = {
  name: 'Face-down creature',
  manaCost: null,
  mv: 0,
  typeLine: 'Creature',
  types: ['Creature'],
  subtypes: [],
  supertypes: [],
  colors: [],
  oracleText: '',
  power: '2',
  toughness: '2',
  keywords: [],
  producedMana: [],
  imageUri: null,
  loyalty: null,
};

/**
 * A token's characteristics, built from its spec.
 *
 * The type line is derived rather than asserted. It used to read
 * `Token Creature — <subtypes>` for every token there was, so a Clue — an
 * artifact, and the only non-creature token in the pool — announced itself as a
 * creature to anything that read the line instead of the types.
 */
export function tokenFace(spec: TokenSpec): OracleFace {
  const creature = spec.types.includes('Creature');
  const left = ['Token', ...spec.types].join(' ');
  return {
    name: spec.name,
    manaCost: null,
    mv: 0,
    typeLine: spec.subtypes.length > 0 ? `${left} — ${spec.subtypes.join(' ')}` : left,
    types: spec.types,
    subtypes: spec.subtypes,
    supertypes: [],
    colors: spec.colors,
    oracleText: spec.text ?? '',
    // CR 208.3 — only a creature has power and toughness. A null here is what
    // keeps a Clue from being drawn, buffed and killed as a 0/0.
    power: creature ? String(spec.power ?? 0) : null,
    toughness: creature ? String(spec.toughness ?? 0) : null,
    keywords: [],
    producedMana: [],
    imageUri: null,
    loyalty: null,
  };
}

/**
 * Which registry entry governs this object.
 *
 * A token carries the id of its script in its spec, because it has no oracle
 * entry of its own to be looked up under — see TokenSpec.scriptId.
 */
export function scriptIdOf(card: CardInstance): OracleId {
  /*
   * CR 708.2 — a face-down permanent has no abilities at all.
   *
   * The same guard `currentFace` uses, deliberately: those two are the only
   * things that decide what an object on the battlefield *is*, and if they ever
   * disagree the board shows a 2/2 with no text while the engine quietly plays
   * the card underneath it. That is what was happening — a manifested Orcish
   * Bowmasters kept pinging, a manifested Mystic Sanctuary kept tapping for
   * blue, because every ability lookup went to the real card. Face down is not a
   * costume.
   */
  if (card.faceDown && card.zone === 'battlefield') return FACE_DOWN_SCRIPT;
  return card.isToken ? (card.token?.scriptId ?? 'token') : card.oracleId;
}

/** A registry id nothing answers to, which is the point. */
const FACE_DOWN_SCRIPT = '';

export function currentFace(card: CardInstance): OracleFace {
  // CR 708.2 — face down on the battlefield: a 2/2 creature with no name, no
  // types beyond Creature, no abilities. The identity is still on the instance;
  // redaction decides who gets to know it.
  if (card.faceDown && card.zone === 'battlefield') return FACE_DOWN_FACE;
  if (card.isToken && card.token) return tokenFace(card.token);
  if (card.zone === 'battlefield' || card.zone === 'stack') {
    return faceOf(card.oracleId, card.face);
  }
  return frontFace(card.oracleId);
}

export function cardName(card: CardInstance): string {
  return currentFace(card).name;
}

export function isType(card: CardInstance, t: CardType): boolean {
  return currentFace(card).types.includes(t);
}

export function isPermanentCard(card: CardInstance): boolean {
  const f = currentFace(card);
  return (
    f.types.includes('Artifact') ||
    f.types.includes('Creature') ||
    f.types.includes('Enchantment') ||
    f.types.includes('Land') ||
    f.types.includes('Planeswalker') ||
    f.types.includes('Battle')
  );
}

export function hasCardSubtype(card: CardInstance, sub: string): boolean {
  return currentFace(card).subtypes.includes(sub);
}

export function basePower(card: CardInstance): number {
  const f = currentFace(card);
  return f.power === null ? 0 : Number(f.power) || 0;
}

export function baseToughness(card: CardInstance): number {
  const f = currentFace(card);
  return f.toughness === null ? 0 : Number(f.toughness) || 0;
}

export function getPower(card: CardInstance): number {
  return basePower(card) + (card.counters['+1/+1'] ?? 0);
}

export function getToughness(card: CardInstance): number {
  return baseToughness(card) + (card.counters['+1/+1'] ?? 0);
}

/**
 * Power and toughness with the whole board taken into account: counters, the
 * temporary buffs (prowess, an aura's -1/-0), a script's own static (delirium).
 *
 * Two functions on purpose: getPower stays the cheap pure-card read the arena's
 * feature extractor loops over; these are what combat and state-based actions
 * use, because a Dragon's Rage Channeler with a full graveyard genuinely is a
 * 3/3 there.
 */
export function powerOf(state: GameState, card: CardInstance): number {
  return statOf(state, card, 'power');
}

export function toughnessOf(state: GameState, card: CardInstance): number {
  return statOf(state, card, 'toughness');
}

function statOf(state: GameState, card: CardInstance, which: 'power' | 'toughness'): number {
  let n = which === 'power' ? getPower(card) : getToughness(card);
  for (const e of state.effects) {
    if (e.kind === 'ptBuff' && e.iids.includes(card.iid)) {
      n += which === 'power' ? e.power : e.toughness;
    }
  }
  // The card's own live static (delirium), by way of its script.
  const script = getScriptRef?.(scriptIdOf(card));
  const self = script?.staticPt?.self;
  if (self) n += self(state, card)[which];
  // Auras attached to this card granting a static change.
  for (const iid of state.zones[card.controller].battlefield) {
    const aura = state.cards[iid];
    if (!aura || aura.attachedTo !== card.iid) continue;
    const grant = getScriptRef?.(scriptIdOf(aura))?.staticPt?.enchanted;
    if (grant) n += grant[which];
  }
  return n;
}

/*
 * state.ts must not import the script registry (the scripts import state), so
 * the registry hands a reference in during startup. Everything degrades to the
 * plain counters-based numbers until it does — which is also what keeps the
 * arena's hot path from paying for a lookup it does not need.
 */
type ScriptLike = {
  staticPt?: {
    self?: (state: GameState, card: CardInstance) => { power: number; toughness: number };
    enchanted?: { power: number; toughness: number };
  };
};
let getScriptRef: ((id: OracleId) => ScriptLike | undefined) | null = null;
export function provideScriptLookup(fn: (id: OracleId) => ScriptLike | undefined): void {
  getScriptRef = fn;
}

export function hasKeyword(card: CardInstance, kw: string): boolean {
  return currentFace(card).keywords.includes(kw);
}

/** Mana value as seen on the stack, used by Mana Drain (LKI). */
export function manaValueOfCard(card: CardInstance): number {
  if (card.stackMv !== undefined) return card.stackMv;
  // CR 202.3b — a token has no mana cost, so its mana value is 0. It also has no
  // oracle entry to look one up in: asking for one used to throw, and any card
  // that measured the mana value of a permanent (Abrupt Decay, Council's Judgment)
  // crashed the game the moment a token was on the battlefield.
  if (card.isToken) return 0;
  return oracle(card.oracleId).mv;
}

// ---------------------------------------------------------------------------
// Battlefield queries
// ---------------------------------------------------------------------------

export function battlefield(state: GameState, player?: PlayerId): CardInstance[] {
  const players: PlayerId[] = player ? [player] : ['p1', 'p2'];
  const out: CardInstance[] = [];
  for (const p of players) {
    for (const iid of state.zones[p].battlefield) {
      const c = state.cards[iid];
      if (c) out.push(c);
    }
  }
  return out;
}

export function creaturesOf(state: GameState, player: PlayerId): CardInstance[] {
  return battlefield(state, player).filter((c) => isType(c, 'Creature'));
}

export function cardsIn(state: GameState, player: PlayerId, zone: ZoneName): CardInstance[] {
  return zoneList(state, player, zone)
    .map((iid) => state.cards[iid])
    .filter(Boolean);
}

/**
 * Counts lands with the Island subtype that this player controls, excluding `exclude`.
 * Mystic Sanctuary reads "three or more other Islands" — that is the land TYPE,
 * so Breeding Pool, Watery Grave, Hedge Maze and Undercity Sewers all count.
 */
export function countLandSubtype(
  state: GameState,
  player: PlayerId,
  subtype: string,
  exclude?: IID,
): number {
  return battlefield(state, player).filter(
    (c) => c.iid !== exclude && isType(c, 'Land') && hasCardSubtype(c, subtype),
  ).length;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export function targetExists(state: GameState, ref: TargetRef): boolean {
  switch (ref.kind) {
    case 'player':
      return !state.players[ref.id].hasLost;
    case 'permanent': {
      const c = state.cards[ref.iid];
      return Boolean(c && c.zone === 'battlefield');
    }
    case 'spell': {
      const c = state.cards[ref.iid];
      return Boolean(c && c.zone === 'stack');
    }
    case 'card': {
      const c = state.cards[ref.iid];
      return Boolean(c && c.zone === ref.zone);
    }
  }
}

export function targetLabel(state: GameState, ref: TargetRef): string {
  switch (ref.kind) {
    case 'player':
      return ref.id === 'p1' ? 'Player 1' : 'Player 2';
    default: {
      const c = state.cards[ref.iid];
      return c ? cardName(c) : '(gone)';
    }
  }
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

export function logLine(
  state: GameState,
  text: string,
  opts: { player?: PlayerId; iids?: IID[] } = {},
): void {
  state.log.push({
    seq: state.nextLogSeq++,
    turn: state.turn,
    text,
    player: opts.player,
    iids: opts.iids ?? [],
  });
  // Keep the log bounded; the UI only ever shows a window of it.
  if (state.log.length > 2000) state.log.splice(0, state.log.length - 2000);
}

// ---------------------------------------------------------------------------
// Turn helpers
// ---------------------------------------------------------------------------

export function stepAt(index: number): { phase: GameState['phase']; step: GameState['step'] } {
  const s = TURN_SEQUENCE[index % TURN_SEQUENCE.length];
  return { phase: s.phase, step: s.step };
}

export function isMainPhase(state: GameState): boolean {
  return state.phase === 'precombat_main' || state.phase === 'postcombat_main';
}

/** Sorcery timing: your main phase, empty stack, you have priority. */
export function sorcerySpeedOk(state: GameState, player: PlayerId): boolean {
  return (
    state.activePlayer === player &&
    isMainPhase(state) &&
    state.stack.length === 0 &&
    state.priorityPlayer === player
  );
}
