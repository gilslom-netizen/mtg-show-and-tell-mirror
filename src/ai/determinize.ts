import { MAINDECK } from '../engine/deck.js';
import { Game } from '../engine/game.js';
import { redact, type CardView, type PlayerView } from '../engine/redact.js';
import { nextInt, type RngState } from '../engine/rng.js';
import { makeCard, makePlayerState, otherPlayer } from '../engine/state.js';
import { oracle } from '../engine/oracle.js';
import {
  TURN_SEQUENCE,
  type CardInstance,
  type DelayedTrigger,
  type GameState,
  type IID,
  type OracleId,
  type PlayerId,
} from '../engine/types.js';

/**
 * Turning "what I can see" back into "a game I can play out".
 *
 * This is the piece stage 2 stands on, and the reason it is possible at all is §2.1:
 * both players are known to be running the same sixty cards. So the hidden
 * information is not a distribution over decks — the thing that makes most card games
 * hard — it is a distribution over *arrangements of a known multiset*. Subtract
 * everything visible from the decklist and what is left is exactly what is in the
 * opponent's hand and the two libraries. Dealing it out at random is not an estimate
 * of their hand; it is a uniform sample from the set their hand provably belongs to.
 *
 * The awkward half is that a `PlayerView` is deliberately lossy — it is built to
 * *withhold*, not to round-trip — so a handful of engine fields have to be recovered
 * or reasoned about rather than read. Every one of those is written down below, and
 * `faithful()` is the runtime check that they added up: rebuild, redact the rebuild,
 * and compare against the view it came from. An agent that fails that check does not
 * search the position. It is cheap — one redact — and it means a reconstruction bug
 * degrades into "played the heuristic move" rather than into "searched a game that
 * was not this one".
 */

/** What could not be reconstructed, when something could not be. */
export type DeterminizeFailure =
  | 'card-counts'
  | 'unknown-card'
  | 'pending-choice'
  | 'not-mirror-deck';

export interface DeterminizeResult {
  state: GameState | null;
  failure: DeterminizeFailure | null;
}

/** The mirror decklist as a flat multiset of oracle ids. */
function deckList(): OracleId[] {
  const out: OracleId[] = [];
  for (const entry of MAINDECK) {
    for (let i = 0; i < entry.count; i++) out.push(entry.oracleId);
  }
  return out;
}

const DECK = deckList();

function removeOne(pool: OracleId[], id: OracleId): boolean {
  const i = pool.indexOf(id);
  if (i < 0) return false;
  pool.splice(i, 1);
  return true;
}

function shuffle(rng: RngState, arr: OracleId[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * A card object rebuilt from what the view showed of it.
 *
 * Four `CardInstance` fields have no counterpart in a `CardView`, and each is
 * recoverable because of *when* an agent is asked to act:
 *
 *  - `deathtouched` is set while combat damage is being dealt and cleared by the
 *    next state-based-action pass. Nobody holds priority in between.
 *  - `combatDamageAssigned` lives inside the same window.
 *  - `delved` matters only while a spell is being cast, and casting is finished
 *    before anyone gets priority again.
 *  - `stackMv` is the mana value snapshotted at cast time, which for everything in
 *    this deck is the printed one. It differs only for a card whose cost changed on
 *    the stack, and nothing here does that.
 */
function rebuildCard(view: CardView): CardInstance {
  const card: CardInstance = {
    iid: view.iid,
    oracleId: view.oracleId,
    owner: view.owner,
    controller: view.controller,
    zone: view.zone,
    tapped: view.tapped,
    summoningSick: view.summoningSick,
    damage: view.damage,
    deathtouched: false,
    counters: { ...view.counters },
    face: view.face,
    isToken: view.isToken,
  };

  if (view.isToken) {
    // The only token this deck makes is the Orcish Bowmasters Army, whose whole
    // identity beyond its counters is its name and its zero base stats.
    card.token = {
      name: view.tokenName ?? 'Army',
      types: ['Creature'],
      subtypes: ['Orc', 'Army'],
      colors: ['B'],
      power: 0,
      toughness: 0,
    };
  }

  if (view.targets) card.targets = view.targets;
  if (view.castForFree) card.castForFree = true;
  if (view.attacking) card.attacking = true;

  if (view.zone === 'stack') {
    if (view.isAbility) {
      card.isAbility = true;
      card.abilitySource = view.abilitySource;
      card.abilityLabel = view.abilityLabel;
      /*
       * Carried on the view rather than assumed to be zero. It used to be
       * assumed, guarded by a test asserting no card had two abilities — true of
       * the maindeck, and false the moment the cube arrived (Deathrite Shaman
       * has three). The index is public anyway: the ability is on the stack with
       * its text showing.
       */
      card.abilityIndex = view.abilityIndex ?? 0;
      card.abilityContext = {};
      /*
       * Hullbreaker Horror is the only modal ability here, and its mode is written
       * all over its target: mode 0 returns a spell, mode 1 returns a permanent.
       */
      if (view.oracleId === 'hullbreaker_horror') {
        const target = view.targets?.[0];
        card.chosenModes =
          target === undefined ? [] : [target.kind === 'spell' ? 0 : 1];
      }
    } else {
      card.stackMv = oracle(view.oracleId).mv;
    }
  }
  return card;
}

/**
 * The cards nobody can see: for each player, everything of theirs not on a
 * battlefield, in a graveyard, in exile, on the stack, or in my own hand.
 *
 * This is the arithmetic §2.1 is about, and it is exact rather than estimated. It is
 * separate from `determinize` because it is useful on its own: working out what the
 * opponent might be holding does not require a playable board, and the Show and Tell
 * choice needs the first without being able to have the second.
 */
export function unseenCards(view: PlayerView): Record<PlayerId, OracleId[]> | null {
  const unseen: Record<PlayerId, OracleId[]> = { p1: [...DECK], p2: [...DECK] };
  for (const card of Object.values(view.cards)) {
    // A token was never in a deck, and an ability on the stack is a copy of a card
    // rather than the card — neither is a card its owner has spent.
    if (card.isToken || card.isAbility) continue;
    if (!removeOne(unseen[card.owner], card.oracleId)) return null;
  }
  return unseen;
}

/** A hand the opponent could be holding, drawn uniformly from the ones they could. */
export function sampleOpponentHand(view: PlayerView, rng: RngState): OracleId[] | null {
  const unseen = unseenCards(view);
  if (!unseen) return null;
  const opp = otherPlayer(view.viewer);
  const theirs = unseen[opp];
  const handCount = view.players[opp].handCount;
  if (theirs.length < handCount) return null;
  shuffle(rng, theirs);
  return theirs.slice(0, handCount);
}

/**
 * Build a full game state from one player's view, inventing a hand for the opponent
 * and an order for both libraries.
 *
 * Only ever called at a priority window: a pending choice means the engine is
 * part-way through resolving something, and a generator suspended inside a card
 * script is not a thing any amount of state can stand in for.
 */
export function determinize(view: PlayerView, rng: RngState): DeterminizeResult {
  if (view.choice !== null || view.waitingOnOpponentChoice) {
    return { state: null, failure: 'pending-choice' };
  }

  const me = view.viewer;
  const opp = otherPlayer(me);

  const unseen = unseenCards(view);
  if (!unseen) return { state: null, failure: 'not-mirror-deck' };

  const cards: Record<IID, CardInstance> = {};
  let maxIid = 0;
  for (const cardView of Object.values(view.cards)) {
    const card = rebuildCard(cardView);
    cards[card.iid] = card;
    maxIid = Math.max(maxIid, card.iid);
  }

  const zones: GameState['zones'] = {
    p1: { library: [], hand: [], battlefield: [], graveyard: [], exile: [] },
    p2: { library: [], hand: [], battlefield: [], graveyard: [], exile: [] },
  };
  for (const p of ['p1', 'p2'] as PlayerId[]) {
    zones[p].battlefield = [...view.battlefield[p]];
    zones[p].graveyard = [...view.graveyard[p]];
    zones[p].exile = [...view.exile[p]];
  }
  zones[me].hand = [...view.hand];

  // Everything of mine that is left over is my library, in an order I do not know.
  const myLibrary = unseen[me];
  if (myLibrary.length !== view.players[me].libraryCount) {
    return { state: null, failure: 'card-counts' };
  }

  // Everything of theirs is split between a hand of a known size and the rest.
  const theirs = unseen[opp];
  if (theirs.length !== view.players[opp].handCount + view.players[opp].libraryCount) {
    return { state: null, failure: 'card-counts' };
  }

  shuffle(rng, myLibrary);
  shuffle(rng, theirs);

  let nextIid = maxIid + 1;
  const deal = (ids: OracleId[], owner: PlayerId, zone: 'hand' | 'library') => {
    for (const oracleId of ids) {
      const iid = nextIid++;
      cards[iid] = makeCard(iid, oracleId, owner, zone);
      zones[owner][zone].push(iid);
    }
  };
  deal(myLibrary, me, 'library');
  deal(theirs.slice(0, view.players[opp].handCount), opp, 'hand');
  deal(theirs.slice(view.players[opp].handCount), opp, 'library');

  const stepIndex = TURN_SEQUENCE.findIndex(
    (s) => s.phase === view.phase && s.step === view.step,
  );
  if (stepIndex < 0) return { state: null, failure: 'unknown-card' };

  const delayed: DelayedTrigger[] = [
    ...view.delayedMana.map((d, i): DelayedTrigger => ({
      id: 100000 + i,
      kind: 'manaDrain',
      controller: d.controller,
      amount: d.amount,
      // Never read: the delayed trigger fires for whoever is active, whenever that is.
      armedOnTurn: view.turn,
    })),
    // A pact is public and can end the game on its own, so a search that dropped it
    // would be searching a position where nobody ever has to pay.
    ...view.pacts.map((d, i): DelayedTrigger => ({
      id: 200000 + i,
      kind: 'pact',
      controller: d.controller,
      cost: d.cost,
      sourceIid: -1,
      armedOnTurn: view.turn,
    })),
  ];

  const state: GameState = {
    gameId: view.gameId,
    rng: { s0: rng.s0, s1: rng.s1, s2: rng.s2, s3: rng.s3 },
    mode: view.mode,
    turn: view.turn,
    activePlayer: view.activePlayer,
    /*
     * Turns alternate from turn one, so whoever is active on an odd turn is whoever
     * started. The only thing this decides is the skipped first draw step, and by
     * the time anyone is searching, that has long since happened either way.
     */
    startingPlayer: view.turn % 2 === 1 ? view.activePlayer : otherPlayer(view.activePlayer),
    phase: view.phase,
    step: view.step,
    stepIndex,
    // Priority is only ever handed out after the step's turn-based actions have run.
    stepInitialized: true,

    cards,
    nextIid,
    zones,
    stack: [...view.stack],

    players: {
      p1: rebuildPlayer(view, 'p1'),
      p2: rebuildPlayer(view, 'p2'),
    },

    priorityPlayer: view.priorityPlayer,
    passed: [...view.passed],

    // Triggers are put on the stack before priority is handed out, so at a priority
    // window there is never one waiting.
    pendingTriggers: [],
    effects: JSON.parse(JSON.stringify(view.effects)) as GameState['effects'],
    delayed,
    nextEffectId: 200000,

    pendingChoice: null,
    secretResponses: {},
    mulliganResponses: {},

    combat: view.combat ? (JSON.parse(JSON.stringify(view.combat)) as GameState['combat']) : null,
    // Set only while a spell is being cast, which is finished before priority moves.
    castingIid: null,

    winner: view.winner,
    endReason: view.endReason,

    log: [],
    nextLogSeq: 1,
    // A rebuilt position starts its own id sequence; nothing outside this search
    // ever sees the choices it raises, so where it starts does not matter.
    choiceSeq: 0,
  };

  return { state, failure: null };
}

function rebuildPlayer(view: PlayerView, p: PlayerId): GameState['players']['p1'] {
  const pub = view.players[p];
  const player = makePlayerState(p);
  player.life = pub.life;
  player.landDropsUsed = pub.landDropsUsed;
  player.landDropsAllowed = pub.landDropsAllowed;
  player.manaPool = { ...pub.manaPool };
  player.spellsCastThisTurnCount = pub.spellsCastThisTurnCount;
  player.hasLost = pub.hasLost;
  player.mulligansTaken = pub.mulligansTaken;
  player.keptHand = true;
  player.triedToDrawFromEmpty = false;

  /*
   * `spellsCastThisTurn` is a list of what was cast, and the view carries only how
   * many. One card reads it: Veil of Summer, which asks whether the opponent has
   * cast a blue or a black spell this turn. In a deck where every spell but Veil of
   * Summer itself is blue or black, "they cast something" and "they cast something
   * blue" are the same question, so a count is enough to answer it.
   */
  player.spellsCastThisTurn = Array.from({ length: pub.spellsCastThisTurnCount }, () => ({
    iid: 0,
    oracleId: 'brainstorm',
    colors: ['U' as const],
    mv: 1,
  }));

  /*
   * Orcish Bowmasters ignores the first draw of each draw step, so this matters only
   * during a draw step — and by the time anyone holds priority there, the turn-based
   * draw has happened.
   */
  player.drawsThisDrawStep = view.step === 'draw' && view.activePlayer === p ? 1 : 0;
  return player;
}

/**
 * Does this reconstruction look, to its viewer, exactly like the view it was built
 * from?
 *
 * The one check that matters, and the reason the agent can be trusted with a
 * reconstruction at all: redact the rebuild and compare. Anything the viewer could
 * legitimately notice — a life total, a tapped land, which actions are legal — has to
 * come back identical. What is deliberately excluded is what could not possibly
 * match: the log, which is not rebuilt, and the hidden information, which is the
 * whole point of the exercise.
 */
export function faithful(view: PlayerView, state: GameState): boolean {
  const rebuilt = redact(state, view.viewer);
  return canonical(rebuilt) === canonical(view);
}

function canonical(view: PlayerView): string {
  return JSON.stringify({
    turn: view.turn,
    activePlayer: view.activePlayer,
    phase: view.phase,
    step: view.step,
    priorityPlayer: view.priorityPlayer,
    passed: view.passed,
    winner: view.winner,
    players: view.players,
    hand: view.hand,
    cards: view.cards,
    battlefield: view.battlefield,
    graveyard: view.graveyard,
    exile: view.exile,
    stack: view.stack,
    combat: view.combat,
    effects: view.effects,
    delayedMana: view.delayedMana,
    pacts: view.pacts,
    omniscienceActive: view.omniscienceActive,
    // The strongest line of the lot: two positions that offer the same player the
    // same set of legal actions are the same position as far as a search cares.
    legalActions: view.legalActions,
  });
}

/**
 * A determinized position, ready to be played out — or null when the view could not
 * be faithfully rebuilt, which is the agent's signal to stop searching and think
 * with something that does not need a state.
 */
export function determinizedGame(view: PlayerView, rng: RngState): Game | null {
  const { state } = determinize(view, rng);
  if (!state) return null;
  if (!faithful(view, state)) return null;
  const game = new Game(state);
  // A rollout has no Esc, and the snapshot for it is half the cost of a decision.
  game.undoable = false;
  return game;
}
