import { frontFace } from '../oracle.js';
import type { CardScript, Ctx, Eff } from '../script-types.js';
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
/**
 * Peek and Gitaxian Probe share their whole text: look at a hand, draw a card.
 * The look is a real reveal to the caster only — presented as a zero-pick card
 * choice, because that is the one primitive whose options the redactor already
 * shows to exactly the player who was asked and nobody else.
 */
function* lookAtTheirHand(ctx: Ctx): Eff {
  const t = ctx.targets[0];
  if (!t || t.kind !== 'player') return;
  const player = t.id as PlayerId;
  const hand = ctx.hand(player);
  ctx.log(`looks at ${player === ctx.controller ? 'their own' : "the opponent's"} hand`);
  if (player === ctx.controller || hand.length === 0) return;
  yield* ctx.chooseCards({
    player: ctx.controller,
    cards: hand.map((c) => c.iid),
    min: 0,
    max: 0,
    prompt: 'Their hand — press Confirm when you have seen enough',
    from: 'hand',
  });
}

const TARGET_A_PLAYER = [
  {
    prompt: 'Look at target player’s hand',
    candidates: (): TargetRef[] => [
      { kind: 'player', id: 'p1' },
      { kind: 'player', id: 'p2' },
    ],
  },
];

export const peek: CardScript = {
  oracleId: 'peek',
  targets: TARGET_A_PLAYER,
  *resolve(ctx) {
    yield* lookAtTheirHand(ctx);
    ctx.draw(ctx.controller, 1);
  },
};

export const gitaxianProbe: CardScript = {
  oracleId: 'gitaxian_probe',
  targets: TARGET_A_PLAYER,
  *resolve(ctx) {
    yield* lookAtTheirHand(ctx);
    ctx.draw(ctx.controller, 1);
  },
};

/**
 * Eternal Witness — the errata version, {2}{G}. "You may return target card
 * from your graveyard to your hand": the target is chosen as the trigger goes
 * on the stack, and declining is choosing no target.
 */
export const eternalWitness: CardScript = {
  oracleId: 'eternal_witness',
  abilities: [
    {
      kind: 'triggered',
      label: 'Return a card from your graveyard to your hand',
      trigger: (ev, self) => ev.t === 'entersBattlefield' && ev.iid === self.iid,
      targets: [
        {
          prompt: 'Return target card from your graveyard to your hand — or no target',
          optional: true,
          candidates: (state, controller): TargetRef[] =>
            state.zones[controller].graveyard.map((iid) => ({
              kind: 'card',
              iid,
              zone: 'graveyard',
            })),
        },
      ],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (!t || t.kind !== 'card') return;
        const card = ctx.card(t.iid);
        if (!card || card.zone !== 'graveyard') return;
        ctx.log(`returns ${frontFace(card.oracleId).name} to hand`);
        yield* ctx.moveTo(t.iid, 'hand');
      },
    },
  ],
};

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
