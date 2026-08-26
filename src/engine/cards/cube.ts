import { frontFace } from '../oracle.js';
import type { CardScript } from '../script-types.js';
import type { PlayerId, TargetRef } from '../types.js';

/**
 * Cards that exist only in the drafted cube.
 *
 * Nothing here is in the shared sixty, so none of it runs in a normal game — but a
 * drafted deck is a real deck, and a card in it that does nothing when it resolves
 * is worse than a card that is not in the pool at all.
 */

/**
 * Jace's Erasure, as this format plays it: mills two rather than one.
 *
 * The erratum is the entire card. A trigger that mills one card per draw does not
 * threaten a sixty card library inside the twelve turns these games last, so at
 * one it was a card you would never draft; at two, a hand that draws four cards in
 * a turn takes eight off the top, and mill becomes a real second way to win.
 *
 * The "you may" is folded into the target rather than asked separately after it.
 * CR 601.2c puts the target on the stack and leaves the choice for resolution, so
 * strictly this decides one step early — but it is the same three outcomes (mill
 * them, mill yourself, mill nobody) expressed in one question instead of two, and
 * this trigger fires on every single card you draw. Two dialogs per draw is not a
 * more faithful card, it is an unplayable one.
 */
export const jacesErasure: CardScript = {
  oracleId: 'jaces_erasure',
  abilities: [
    {
      kind: 'triggered',
      label: 'Target player mills two cards',
      trigger: (ev, self) => ev.t === 'draw' && ev.player === self.controller,
      targets: [
        {
          prompt: 'Target player mills two cards — or no target to decline',
          optional: true,
          candidates: (): TargetRef[] => [
            { kind: 'player', id: 'p1' },
            { kind: 'player', id: 'p2' },
          ],
        },
      ],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (!t || t.kind !== 'player') return;
        const player = t.id as PlayerId;
        // Top of library first, exactly as the zone stores it.
        const top = ctx.library(player).slice(0, 2);
        if (top.length === 0) return;
        ctx.log(
          `${frontFace('jaces_erasure').name}: ${player} mills ${top.length}`,
          top.map((c) => c.iid),
        );
        for (const c of top) yield* ctx.moveTo(c.iid, 'graveyard');
      },
    },
  ],
};
