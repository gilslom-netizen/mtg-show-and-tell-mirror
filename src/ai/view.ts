import { faceOf, frontFace, ORACLE } from '../engine/oracle.js';
import type { CardView, PlayerView } from '../engine/redact.js';
import type { IID, OracleFace, OracleId, PlayerId } from '../engine/types.js';

/**
 * Reading a `PlayerView`.
 *
 * Every agent works from the redacted view, which is a deliberately awkward shape to
 * reason about: zones are id lists, card identities live in a side table, and some
 * ids in that table are tokens with no oracle entry at all. Rather than have each
 * agent rediscover that, this file turns a view into the handful of facts a decision
 * actually needs, once per decision.
 *
 * Nothing here reaches past the view. If a fact is not derivable from it, an agent
 * does not get to know it.
 */

/**
 * Card characteristics, or null for a token.
 *
 * Tokens carry an `oracleId` of `army_token` that the oracle database has never
 * heard of, so `oracle()` throws on them. Every lookup in the AI goes through here
 * so that an Army on the battlefield is a missing face rather than a crash — the
 * token's own power and toughness are already on the `CardView`.
 */
export function faceOfView(card: CardView | undefined): OracleFace | null {
  if (!card || card.isToken) return null;
  if (!ORACLE[card.oracleId]) return null;
  return faceOf(card.oracleId, card.face);
}

/** The front face of a card in hand, library or graveyard (CR 712.8a). */
export function handFace(oracleId: OracleId): OracleFace | null {
  return ORACLE[oracleId] ? frontFace(oracleId) : null;
}

export function isLandCard(oracleId: OracleId): boolean {
  return handFace(oracleId)?.types.includes('Land') ?? false;
}

/**
 * Whether this card can be played as a land — either it is one, or it is a modal
 * DFC whose back face is. Waterlogged Teachings is the only one in the mirror and it
 * matters twice: it is a land source when counting a hand, and it is not a legal
 * Show and Tell pick.
 */
export function isLandSource(oracleId: OracleId): boolean {
  if (isLandCard(oracleId)) return true;
  const card = ORACLE[oracleId];
  return Boolean(card?.faces?.[1]?.types.includes('Land'));
}

export function producesMana(card: CardView): boolean {
  return (faceOfView(card)?.producedMana.length ?? 0) > 0;
}

export interface StackObject {
  iid: IID;
  oracleId: OracleId;
  controller: PlayerId;
  isAbility: boolean;
}

/** Everything an agent needs about the position, derived from the view once. */
export interface Read {
  view: PlayerView;
  me: PlayerId;
  opp: PlayerId;
  myLife: number;
  oppLife: number;

  /** My hand, in order, with identities. */
  hand: { iid: IID; oracleId: OracleId }[];
  /** How many of each card I am holding — the duplicate penalty needs this. */
  handCounts: Map<OracleId, number>;
  /** Cards in hand that could be played as a land. */
  landsInHand: number;

  myPermanents: CardView[];
  oppPermanents: CardView[];
  /** My lands, whether or not they are tapped. */
  myLands: CardView[];
  /** Untapped permanents of mine that produce mana — how much I could spend. */
  openMana: number;

  myCreatures: CardView[];
  oppCreatures: CardView[];

  omniMine: boolean;
  omniTheirs: boolean;
  horrorMine: boolean;

  /** My graveyard size — Delve fuel for Dig Through Time. */
  myGraveyard: number;

  /**
   * The whole stack, bottom first — so the last entry is what resolves next.
   *
   * Who is on top is a different question from who is on the stack, and the two
   * were being confused. A spell of theirs buried under four of mine is not a
   * decision I am facing; the thing about to resolve is.
   */
  stack: StackObject[];
  /** Spells (never abilities) on the stack, split by who cast them. */
  oppSpells: StackObject[];
  mySpells: StackObject[];
  /**
   * Everything of mine on the stack, triggers included.
   *
   * The distinction from `mySpells` matters: a Hullbreaker Horror trigger or an
   * Orcish Bowmasters ping is not a spell, and it is still something that has to
   * finish before the next decision is worth making.
   */
  myStack: StackObject[];

  isMyTurn: boolean;
  sorceryTiming: boolean;
  turn: number;
}

function stackObjects(view: PlayerView): StackObject[] {
  const out: StackObject[] = [];
  for (const iid of view.stack) {
    const c = view.cards[iid];
    if (!c) continue;
    out.push({
      iid,
      oracleId: c.oracleId,
      controller: c.controller,
      isAbility: Boolean(c.isAbility),
    });
  }
  return out;
}

export function read(view: PlayerView): Read {
  const me = view.viewer;
  const opp: PlayerId = me === 'p1' ? 'p2' : 'p1';

  const hand = view.hand
    .map((iid) => ({ iid, oracleId: view.cards[iid]?.oracleId }))
    .filter((c): c is { iid: IID; oracleId: OracleId } => Boolean(c.oracleId));

  const handCounts = new Map<OracleId, number>();
  for (const c of hand) handCounts.set(c.oracleId, (handCounts.get(c.oracleId) ?? 0) + 1);

  const permsOf = (p: PlayerId) =>
    view.battlefield[p].map((iid) => view.cards[iid]).filter((c): c is CardView => Boolean(c));
  const myPermanents = permsOf(me);
  const oppPermanents = permsOf(opp);

  const isCreature = (c: CardView) =>
    c.isToken ? true : (faceOfView(c)?.types.includes('Creature') ?? false);
  const isLand = (c: CardView) => faceOfView(c)?.types.includes('Land') ?? false;

  const stack = stackObjects(view);

  return {
    view,
    me,
    opp,
    myLife: view.players[me].life,
    oppLife: view.players[opp].life,

    hand,
    handCounts,
    landsInHand: hand.filter((c) => isLandSource(c.oracleId)).length,

    myPermanents,
    oppPermanents,
    myLands: myPermanents.filter(isLand),
    openMana: myPermanents.filter((c) => !c.tapped && producesMana(c)).length,

    myCreatures: myPermanents.filter(isCreature),
    oppCreatures: oppPermanents.filter(isCreature),

    omniMine: myPermanents.some((c) => c.oracleId === 'omniscience'),
    omniTheirs: oppPermanents.some((c) => c.oracleId === 'omniscience'),
    horrorMine: myPermanents.some((c) => c.oracleId === 'hullbreaker_horror'),

    myGraveyard: view.players[me].graveyardCount,

    stack,
    oppSpells: stack.filter((o) => !o.isAbility && o.controller === opp),
    mySpells: stack.filter((o) => !o.isAbility && o.controller === me),
    myStack: stack.filter((o) => o.controller === me),

    isMyTurn: view.activePlayer === me,
    sorceryTiming:
      view.activePlayer === me &&
      (view.phase === 'precombat_main' || view.phase === 'postcombat_main') &&
      view.stack.length === 0,
    turn: view.turn,
  };
}

/** Power and toughness as the view reports them, tokens included. */
export function statsOf(card: CardView): { power: number; toughness: number } {
  return { power: card.power ?? 0, toughness: card.toughness ?? 0 };
}

/** How much damage it still takes to kill this creature. */
export function remainingToughness(card: CardView): number {
  return Math.max(0, (card.toughness ?? 0) - card.damage);
}
