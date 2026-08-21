import { currentFace } from './state.js';
import type {
  ActiveEffect,
  ActiveEffectDraft,
  Color,
  GameState,
  IID,
  PlayerId,
  TargetRef,
} from './types.js';

/**
 * The small continuous-effect layer this card pool needs.
 *
 * Deliberately not a full CR 613 implementation — see DESIGN.md 8. The pool needs
 * exactly four things: +1/+1 counters (handled directly on the card), granted
 * hexproof-from-a-colour, "can't be countered", and cast-timing permission.
 */

export function addEffect(state: GameState, e: ActiveEffectDraft): ActiveEffect {
  const withId = { ...e, id: state.nextEffectId++ } as ActiveEffect;
  state.effects.push(withId);
  return withId;
}

export function clearEndOfTurnEffects(state: GameState): void {
  state.effects = state.effects.filter((e) => e.expires !== 'endOfTurn');
}

/** The colours of whatever produced a spell or ability. */
export function sourceColors(state: GameState, sourceIid: IID | null): Color[] {
  if (sourceIid === null) return [];
  const c = state.cards[sourceIid];
  if (!c) return [];
  return currentFace(c).colors;
}

/**
 * CR 702.11d — "hexproof from blue" means this can't be the target of blue spells
 * an opponent controls, or of abilities an opponent controls from blue sources.
 *
 * In this deck that is what stops an opposing Orcish Bowmasters (black source) from
 * pinging you, and an opposing Hullbreaker Horror (blue source) from bouncing your
 * permanents. It does NOT protect your spells on the stack — a spell is not "you or
 * a permanent you control" — which is the crack in Veil of Summer that the mirror
 * is played through.
 */
export function isProtectedFrom(
  state: GameState,
  ref: TargetRef,
  sourceIid: IID | null,
  sourceController: PlayerId,
): boolean {
  if (ref.kind === 'spell' || ref.kind === 'card') return false;

  const colors = sourceColors(state, sourceIid);
  if (colors.length === 0) return false;

  for (const e of state.effects) {
    if (e.kind !== 'grantAbility') continue;
    const color: Color = e.ability === 'hexproofFromBlue' ? 'U' : 'B';
    if (!colors.includes(color)) continue;

    if (ref.kind === 'player') {
      if (!e.players.includes(ref.id)) continue;
      // Only opponents are stopped; you can always target yourself.
      if (sourceController === ref.id) continue;
      return true;
    }
    if (ref.kind === 'permanent') {
      if (!e.iids.includes(ref.iid)) continue;
      const perm = state.cards[ref.iid];
      if (!perm) continue;
      if (sourceController === perm.controller) continue;
      return true;
    }
  }
  return false;
}

/**
 * Whether a spell can be countered right now.
 * Sources: the card itself (Hullbreaker Horror), Veil of Summer for the whole turn,
 * and Mistrise Village for a single spell.
 */
export function spellCantBeCountered(
  state: GameState,
  spellIid: IID,
  intrinsic: boolean,
): boolean {
  if (intrinsic) return true;
  const spell = state.cards[spellIid];
  if (!spell) return false;
  for (const e of state.effects) {
    if (e.kind !== 'cantBeCountered') continue;
    if (e.controller !== spell.controller) continue;
    if (e.scope === 'allThisTurn') return true;
    if (e.scope === 'nextSpell' && e.consumed) {
      // The shield was attached to this specific spell when it was cast.
      if ((e as { shieldedIid?: IID }).shieldedIid === spellIid) return true;
    }
  }
  return false;
}

/**
 * Mistrise Village's "the next spell you cast this turn can't be countered" attaches
 * to whichever spell is cast next, and is used up at that moment — not at end of turn.
 */
export function attachNextSpellShield(state: GameState, spellIid: IID): void {
  const spell = state.cards[spellIid];
  if (!spell) return;
  for (const e of state.effects) {
    if (e.kind !== 'cantBeCountered') continue;
    if (e.scope !== 'nextSpell' || e.consumed) continue;
    if (e.controller !== spell.controller) continue;
    e.consumed = true;
    (e as { shieldedIid?: IID }).shieldedIid = spellIid;
    return;
  }
}

export function hasUnusedNextSpellShield(state: GameState, player: PlayerId): boolean {
  return state.effects.some(
    (e) => e.kind === 'cantBeCountered' && e.scope === 'nextSpell' && !e.consumed && e.controller === player,
  );
}

/** Borne Upon a Wind: you may cast spells this turn as though they had flash. */
export function canCastAsThoughFlash(state: GameState, player: PlayerId): boolean {
  return state.effects.some((e) => e.kind === 'castAsThoughFlash' && e.controller === player);
}
