import { cardsIn, currentFace } from '../state.js';
import type { CardScript, Ctx, Eff } from '../script-types.js';
import type { CardInstance, GameState, PlayerId, TargetRef } from '../types.js';

/**
 * The spells you can cast without paying for them.
 *
 * "Rather than pay this spell's mana cost" is not a discount, it is a different
 * cost, and a hand that can pay it plays a different game: Force of Negation on
 * turn one off no land at all, Commandeer taking the Show and Tell that was about
 * to end the game. The engine offers both costs side by side rather than picking
 * one, because which is right depends entirely on what the rest of the hand was
 * for.
 *
 * They are together here because they share machinery, not colour. What makes them
 * one family is that each is a decision about a resource other than mana — cards in
 * hand, or a promise to pay later.
 */

/** Blue cards in hand, never counting the spell being cast — it is on the stack. */
function blueInHand(state: GameState, player: PlayerId, self: CardInstance): CardInstance[] {
  return cardsIn(state, player, 'hand').filter(
    (c) => c.iid !== self.iid && currentFace(c).colors.includes('U'),
  );
}

function noncreatureSpells(state: GameState): TargetRef[] {
  return state.stack
    .map((iid) => state.cards[iid])
    .filter((c) => c && !c.isAbility && !currentFace(c).types.includes('Creature'))
    .map((c): TargetRef => ({ kind: 'spell', iid: c.iid }));
}

/** Exile that many blue cards from hand, or report that it did not happen. */
function* exileBlue(ctx: Ctx, n: number): Eff<boolean> {
  const blue = blueInHand(ctx.state, ctx.controller, ctx.self).map((c) => c.iid);
  if (blue.length < n) return false;
  const picked = yield* ctx.chooseCards({
    player: ctx.controller,
    cards: blue,
    min: n,
    max: n,
    prompt: `Exile ${n === 1 ? 'a blue card' : `${n} blue cards`} from your hand`,
    from: 'hand',
  });
  if (picked.length < n) return false;
  for (const iid of picked) yield* ctx.moveTo(iid, 'exile');
  return true;
}

/**
 * Commandeer.
 *
 * Taking a spell is not the same as countering it: the Show and Tell still
 * resolves, and it resolves for you — so in this mirror it is the difference
 * between both players getting a combo permanent and only one of them doing it.
 *
 * Control changes; ownership does not. That is why the card ends up in its owner's
 * graveyard afterwards, and why an Omniscience taken this way was never yours.
 */
export const commandeer: CardScript = {
  oracleId: 'commandeer',
  altCost: {
    label: 'exile two blue cards',
    available: (state, controller, self) => blueInHand(state, controller, self).length >= 2,
    pay: (ctx) => exileBlue(ctx, 2),
  },
  targets: [
    {
      prompt: 'Gain control of target noncreature spell',
      // Either player's. Taking your own spell back is legal and pointless; the
      // rules do not stop you and neither does this.
      candidates: (state) => noncreatureSpells(state),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind !== 'spell') return;
    if (!ctx.gainControlOfSpell(t.iid, ctx.controller)) return;

    // "You may choose new targets for it" — only worth asking when it has any.
    const spell = ctx.card(t.iid);
    if (!spell?.targets?.length) return;
    const change = yield* ctx.yesNo(
      ctx.controller,
      `Choose new targets for ${currentFace(spell).name}?`,
      { yes: 'Choose new targets', no: 'Leave them' },
    );
    if (change) yield* ctx.chooseNewTargetsFor(t.iid, ctx.controller);
  },
};

/**
 * Force of Negation.
 *
 * "If it's not your turn" is the whole card: it is free exactly when you are the
 * one being attacked, which is the turn this deck loses on. The exile clause
 * matters more here than it reads — Dig Through Time delves graveyards and Mystic
 * Sanctuary buys instants back out of them, so a countered spell that stays dead is
 * worth more than one that does not.
 */
export const forceOfNegation: CardScript = {
  oracleId: 'force_of_negation',
  altCost: {
    label: 'exile a blue card',
    available: (state, controller, self) =>
      state.activePlayer !== controller && blueInHand(state, controller, self).length >= 1,
    pay: (ctx) => exileBlue(ctx, 1),
  },
  targets: [
    {
      prompt: 'Counter target noncreature spell',
      candidates: (state, controller) =>
        noncreatureSpells(state).filter(
          (t) => t.kind === 'spell' && state.cards[t.iid]?.controller !== controller,
        ),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind !== 'spell') return;
    ctx.counterSpell(t.iid, { exile: true });
  },
};

/**
 * Mindbreak Trap.
 *
 * Free once the opponent has cast three spells in a turn, which in a format where
 * an Omniscience makes everything cost nothing is not a rare condition — it is what
 * the losing turn looks like from the other side of the table. "Any number of
 * target spells" is the point of it: exiling one of the four spells already on the
 * stack would just be a worse Mana Drain.
 */
export const mindbreakTrap: CardScript = {
  oracleId: 'mindbreak_trap',
  altCost: {
    label: 'free — they have cast three spells',
    available: (state, controller) =>
      state.players[controller === 'p1' ? 'p2' : 'p1'].spellsCastThisTurnCount >= 3,
    // {0} is a cost that is always payable: nothing to ask, nothing to spend.
    pay: function* () {
      return true;
    },
  },
  targets: [
    {
      prompt: 'Exile any number of target spells',
      count: 'any',
      candidates: (state) =>
        state.stack
          .map((iid) => state.cards[iid])
          .filter((c) => c && !c.isAbility)
          .map((c): TargetRef => ({ kind: 'spell', iid: c.iid })),
    },
  ],
  *resolve(ctx) {
    for (const t of ctx.targets) {
      if (t.kind !== 'spell') continue;
      const spell = ctx.card(t.iid);
      if (!spell || spell.zone !== 'stack') continue;
      // Exiling is not countering, so "can't be countered" does not stop it — which
      // is exactly why this card sits in a cube alongside Veil of Summer.
      ctx.log(`exiles ${currentFace(spell).name}`);
      yield* ctx.moveTo(t.iid, 'exile');
    }
  },
};

/**
 * Pact of Negation.
 *
 * Free now, {3}{U}{U} at the beginning of your next upkeep, and you lose the game
 * if you cannot pay. The bill is the card: it counters anything for nothing on the
 * turn that matters, and then asks whether there is going to be a next turn at all.
 *
 * The debt lives on the game state rather than on the card, because by the time it
 * comes due the Pact has been in the graveyard for a turn — see DelayedTrigger.
 */
export const pactOfNegation: CardScript = {
  oracleId: 'pact_of_negation',
  targets: [
    {
      prompt: 'Counter target spell',
      candidates: (state, controller) =>
        state.stack
          .map((iid) => state.cards[iid])
          .filter((c) => c && !c.isAbility && c.controller !== controller)
          .map((c): TargetRef => ({ kind: 'spell', iid: c.iid })),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind !== 'spell') return;
    ctx.counterSpell(t.iid);
    /*
     * The debt is incurred on resolution, and it is incurred even when the counter
     * did nothing — a Pact pointed at a Hullbreaker Horror still has to be paid for.
     * Nothing about the promise is conditional on it having worked.
     */
    ctx.addDelayedPayment(ctx.controller, '{3}{U}{U}');
    ctx.log('must pay {3}{U}{U} at the beginning of their next upkeep, or lose the game');
  },
};
