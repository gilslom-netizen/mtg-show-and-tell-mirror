import { frontFace } from '../oracle.js';
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
 * Assemble the Team — "search the top third of your library, rounded up".
 * The searchable subset shrinks as the game goes on, so it is computed at resolution.
 */
export const assembleTheTeam: CardScript = {
  oracleId: 'assemble_the_team',
  *resolve(ctx) {
    const lib = ctx.library(ctx.controller);
    const n = Math.ceil(lib.length / 3);
    if (n > 0) {
      const found = yield* ctx.searchZone({
        player: ctx.controller,
        cards: lib.slice(0, n).map((c) => c.iid),
        prompt: `Search the top ${n} card${n === 1 ? '' : 's'} of your library (top third, rounded up)`,
        optional: true,
      });
      if (found !== null) yield* ctx.moveTo(found, 'hand');
    }
    // The shuffle happens whether or not anything was found.
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
        const f = frontFace(c.oracleId);
        return f.types.includes('Instant') || f.keywords.includes('Flash');
      },
      prompt: 'Search for an instant card or a card with flash',
      optional: true,
    });
    if (found !== null) {
      const card = ctx.card(found);
      // "reveal it" — this is public information.
      if (card) ctx.log(`reveals ${frontFace(card.oracleId).name}`, [found]);
      yield* ctx.moveTo(found, 'hand');
    }
    ctx.shuffleLibrary(ctx.controller);
  },
};
