import { currentFace } from '../state.js';
import type { CardScript } from '../script-types.js';

/** Search effects. All of them shuffle afterwards, which resets any known top of library. */

export const demonicTutor: CardScript = {
  oracleId: 'demonic_tutor',
  *resolve(ctx) {
    const found = yield* ctx.searchZone({
      player: ctx.controller,
      cards: ctx.library(ctx.controller).map((c) => c.iid),
      prompt: 'Search your library for a card',
      optional: true,
    });
    if (found !== null) yield* ctx.moveTo(found, 'hand');
    ctx.shuffleLibrary(ctx.controller);
  },
};

/**
 * Waterlogged Teachings // Inundated Archive.
 *
 * The front face finds "an instant card OR a card with flash", which in this deck
 * also reaches Hullbreaker Horror and Orcish Bowmasters — both have flash.
 *
 * The back face is a tapped dual land. Note that while this card is in hand,
 * library or graveyard it is an Instant and nothing else (CR 712.8a), so it is not
 * a legal Show and Tell choice and Atraxa can only take it as an instant.
 */
export const waterloggedTeachings: CardScript = {
  oracleId: 'waterlogged_teachings',
  *asEnters(ctx) {
    // Only the land face ever reaches the battlefield, and it always enters tapped.
    if (ctx.self.face === 'back') ctx.enterTapped();
  },
  *resolve(ctx) {
    const found = yield* ctx.searchZone({
      player: ctx.controller,
      cards: ctx.library(ctx.controller).map((c) => c.iid),
      filter: (c) => {
        const f = currentFace(c);
        return f.types.includes('Instant') || f.keywords.includes('Flash');
      },
      prompt: 'Search for an instant card or a card with flash',
      optional: true,
    });
    if (found !== null) {
      const card = ctx.card(found);
      // "reveal it" — this is public information.
      if (card) ctx.log(`reveals ${currentFace(card).name}`, [found]);
      yield* ctx.moveTo(found, 'hand');
    }
    ctx.shuffleLibrary(ctx.controller);
  },
};
