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
  type ZoneName,
  TURN_SEQUENCE,
} from './types.js';

/** Pure helpers over GameState. Nothing here yields choices or runs the turn loop. */

export function otherPlayer(p: PlayerId): PlayerId {
  return p === 'p1' ? 'p2' : 'p1';
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
  deck: DeckEntry[];
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
  };

  for (const player of ['p1', 'p2'] as PlayerId[]) {
    for (const entry of opts.deck) {
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
function homeList(state: GameState, card: CardInstance): IID[] {
  if (card.zone === 'stack') return state.stack;
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
    const list = state.zones[card.owner][to];
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
export function currentFace(card: CardInstance): OracleFace {
  if (card.isToken && card.token) {
    return {
      name: card.token.name,
      manaCost: null,
      mv: 0,
      typeLine: `Token Creature — ${card.token.subtypes.join(' ')}`,
      types: card.token.types,
      subtypes: card.token.subtypes,
      supertypes: [],
      colors: card.token.colors,
      oracleText: '',
      power: String(card.token.power),
      toughness: String(card.token.toughness),
      keywords: [],
      producedMana: [],
      imageUri: null,
    };
  }
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

export function hasKeyword(card: CardInstance, kw: string): boolean {
  return currentFace(card).keywords.includes(kw);
}

/** Mana value as seen on the stack, used by Mana Drain (LKI). */
export function manaValueOfCard(card: CardInstance): number {
  if (card.stackMv !== undefined) return card.stackMv;
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
