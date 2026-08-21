import { battlefield, manaValueOfCard } from '../state.js';
import type { CardScript } from '../script-types.js';
import type { TargetRef } from '../types.js';

/** The two ways this deck fights over the stack. */

/**
 * Mana Drain.
 *
 * Two details from the official rulings that are easy to get wrong:
 *  - If the target spell has become an illegal target, Mana Drain does not resolve
 *    at all and you get no mana. That is handled by the engine's fizzle check.
 *  - If the target is still legal but simply cannot be countered (Veil of Summer,
 *    Mistrise Village, Hullbreaker Horror), Mana Drain still resolves and you DO
 *    add the mana. The counter fails; the ritual does not.
 */
export const manaDrain: CardScript = {
  oracleId: 'mana_drain',
  targets: [
    {
      prompt: 'Counter target spell',
      candidates: (state, controller): TargetRef[] =>
        state.stack
          .map((iid) => state.cards[iid])
          .filter((c) => c && !c.isAbility && c.controller !== controller)
          .map((c) => ({ kind: 'spell', iid: c.iid })),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind !== 'spell') return;
    const spell = ctx.card(t.iid);
    if (!spell || spell.zone !== 'stack') return;

    // Snapshot the mana value before the spell can leave the stack. Delve does not
    // reduce mana value, so a Dig Through Time cast for {U}{U} is still worth 8.
    const mv = manaValueOfCard(spell);

    ctx.counterSpell(t.iid);
    ctx.addDelayedMana(ctx.controller, mv);
    ctx.log(`will add ${mv} colorless mana at the beginning of their next main phase`);
  },
};

/**
 * Veil of Summer — three effects, and the middle one behaves differently from the
 * other two with respect to timing:
 *  - the draw is conditional on what the opponent has already cast this turn;
 *  - "spells you control can't be countered this turn" also covers spells you cast
 *    LATER this turn;
 *  - the hexproof list is locked in right now, so permanents that arrive afterwards
 *    are not protected.
 */
export const veilOfSummer: CardScript = {
  oracleId: 'veil_of_summer',
  *resolve(ctx) {
    const opp = ctx.opponent;
    const castBlueOrBlack = ctx.state.players[opp].spellsCastThisTurn.some(
      (s) => s.colors.includes('U') || s.colors.includes('B'),
    );
    if (castBlueOrBlack) {
      // A real draw, so it can trigger an opposing Orcish Bowmasters.
      ctx.draw(ctx.controller, 1);
    }

    ctx.addEffect({
      kind: 'cantBeCountered',
      controller: ctx.controller,
      scope: 'allThisTurn',
      expires: 'endOfTurn',
    });

    const protectedIids = battlefield(ctx.state, ctx.controller).map((c) => c.iid);
    ctx.addEffect({
      kind: 'grantAbility',
      ability: 'hexproofFromBlue',
      players: [ctx.controller],
      iids: protectedIids,
      expires: 'endOfTurn',
    });
    ctx.addEffect({
      kind: 'grantAbility',
      ability: 'hexproofFromBlack',
      players: [ctx.controller],
      iids: protectedIids,
      expires: 'endOfTurn',
    });
    ctx.log("Spells you control can't be countered this turn; you and your permanents gain hexproof from blue and from black");
  },
};
