import type { CardScript, Eff } from '../script-types.js';
import type { TokenSpec } from '../types.js';

/**
 * Scripts for the tokens the pool creates.
 *
 * A token has no oracle entry, so it cannot be looked up in the registry by an
 * oracle id the way a card is. `TokenSpec.scriptId` names its script instead, and
 * `scriptIdOf` is what every ability lookup goes through — so a token with a
 * script gets triggers, activated abilities and statics on exactly the same terms
 * as a printed permanent.
 *
 * Keeping the specs here as well as the scripts is deliberate: a token's type
 * line and its abilities are one card, and the Clue is the standing proof of what
 * happens when they live apart. It was created as an artifact, drawn as a 0/0
 * creature, and had no ability at all, because three different files each knew
 * one third of it.
 */

function* nothing(): Eff {
  // A resolution with no choices in it still has to be a generator.
}

/** The id a Clue token is created under. */
export const CLUE = 'token_clue';

/**
 * Clue — "{2}, Sacrifice this artifact: Draw a card."
 *
 * The sacrifice is part of the cost, which is why it is `cost.sacrificeSelf`
 * rather than the first line of the resolution: the card is drawn even if the
 * ability is countered, and the Clue is gone whether it resolves or not.
 */
export const clueToken: CardScript = {
  oracleId: CLUE,
  abilities: [
    {
      kind: 'activated',
      text: '{2}, Sacrifice this artifact: Draw a card.',
      cost: { mana: '{2}', sacrificeSelf: true },
      timing: 'instant',
      *resolve(ctx) {
        ctx.draw(ctx.controller, 1);
        yield* nothing();
      },
    },
  ],
};

/** The spec every Clue is created from, so investigate always makes the same one. */
export const CLUE_TOKEN: TokenSpec = {
  name: 'Clue',
  types: ['Artifact'],
  subtypes: ['Clue'],
  colors: [],
  scriptId: CLUE,
  text: '{2}, Sacrifice this artifact: Draw a card.',
};

export const TOKEN_SCRIPTS: CardScript[] = [clueToken];
