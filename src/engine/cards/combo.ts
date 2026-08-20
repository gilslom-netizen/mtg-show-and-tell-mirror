import { frontFace, oracle } from '../oracle';
import type { CardScript } from '../script-types';
import type { CardInstance, IID, PlayerId } from '../types';

/**
 * The two cards the format is built around.
 */

const SHOW_AND_TELL_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Land'] as const;

function showAndTellLegality(card: CardInstance): string | undefined {
  const f = frontFace(card.oracleId);
  if (SHOW_AND_TELL_TYPES.some((t) => f.types.includes(t))) return undefined;

  const full = oracle(card.oracleId);
  if (full.layout === 'modal_dfc') {
    // The trap this format lives on: Waterlogged Teachings looks like a land because
    // its back face is one, but Show and Tell says "put onto the battlefield" without
    // playing it, so only the front face counts (CR 712.8a).
    return `In hand this is only its front face (${f.typeLine}) — the land back face does not count`;
  }
  return `Show and Tell can only put artifacts, creatures, enchantments and lands onto the battlefield`;
}

export const showAndTell: CardScript = {
  oracleId: 'show_and_tell',
  *resolve(ctx) {
    // Both players decide in secret. Nothing is revealed until both have locked in,
    // and then the cards enter the battlefield at the same time. See DESIGN.md 7.3.
    const picks = yield* ctx.simultaneousSecret({
      prompt: 'Show and Tell',
      optionsFor: (p: PlayerId) =>
        ctx.hand(p).map((c) => ({ iid: c.iid, disabledReason: showAndTellLegality(c) })),
      promptFor: () =>
        'You may put an artifact, creature, enchantment, or land card from your hand onto the battlefield',
    });

    const entries: { iid: IID }[] = [];
    for (const p of ['p1', 'p2'] as PlayerId[]) {
      const iid = picks[p];
      if (iid === null) {
        ctx.log('puts nothing onto the battlefield');
        continue;
      }
      const card = ctx.card(iid);
      // Guard against the card having left the hand somehow.
      if (!card || card.zone !== 'hand') continue;
      entries.push({ iid });
    }
    if (entries.length === 0) return;

    yield* ctx.moveSimultaneouslyToBattlefield(entries);
  },
};

/**
 * Omniscience is a static ability the rest of the engine reads directly:
 * `enumerateLegalActions` offers a free cast for every spell in hand while an
 * Omniscience is on the battlefield, and the permission disappears the instant the
 * enchantment does. Timing restrictions still apply, which is why this deck plays
 * Borne Upon a Wind.
 */
export const omniscience: CardScript = {
  oracleId: 'omniscience',
  abilities: [
    {
      kind: 'static',
      text: 'You may cast spells from your hand without paying their mana costs.',
      effect: 'castWithoutPayingManaCost',
    },
  ],
};
