import { isProtectedFrom } from '../effects';
import { frontFace } from '../oracle';
import { battlefield, cardName, isType } from '../state';
import type { CardScript } from '../script-types';
import { ATRAXA_TYPES, type IID, type PlayerId, type TargetRef } from '../types';

/**
 * The three creatures. Two of them have flash, which is why Waterlogged Teachings
 * can find them.
 */

export const atraxaGrandUnifier: CardScript = {
  oracleId: 'atraxa_grand_unifier',
  abilities: [
    {
      kind: 'triggered',
      label: 'Reveal the top ten cards and take one of each card type',
      trigger: (ev, self) => ev.t === 'entersBattlefield' && ev.iid === self.iid,
      *resolve(ctx) {
        const top = ctx.library(ctx.controller).slice(0, 10).map((c) => c.iid);
        if (top.length === 0) return;
        ctx.log(`reveals the top ${top.length} card${top.length === 1 ? '' : 's'}`, top);

        const picked: IID[] = [];
        for (const type of ATRAXA_TYPES) {
          const available = top.filter((iid) => {
            if (picked.includes(iid)) return false;
            const c = ctx.card(iid);
            // Cards in the library show only their front face, so an MDFC like
            // Waterlogged Teachings is available as an instant and never as a land.
            return c ? frontFace(c.oracleId).types.includes(type) : false;
          });
          if (available.length === 0) continue;

          const choice = yield* ctx.chooseCards({
            player: ctx.controller,
            cards: available,
            min: 0,
            max: 1,
            prompt: `You may put ${
              /^[AEIOU]/.test(type) ? 'an' : 'a'
            } ${type.toLowerCase()} card into your hand`,
            from: 'library',
            publicReveal: true,
          });
          if (choice.length > 0) picked.push(choice[0]);
        }

        // These go to hand, they are not drawn — no Orcish Bowmasters triggers.
        for (const iid of picked) yield* ctx.moveTo(iid, 'hand');
        ctx.bottomInRandomOrder(top.filter((iid) => !picked.includes(iid)));
      },
    },
  ],
};

export const hullbreakerHorror: CardScript = {
  oracleId: 'hullbreaker_horror',
  cantBeCountered: true,
  abilities: [
    {
      kind: 'triggered',
      label: 'Choose up to one — bounce a spell or a nonland permanent',
      // Only its controller's casts. Casting the Horror itself does not trigger it,
      // because it is not on the battlefield yet.
      trigger: (ev, self) => ev.t === 'spellCast' && ev.controller === self.controller,
      *onStack(ctx) {
        const state = ctx.state;

        const spellTargets: TargetRef[] = state.stack
          .map((iid) => ctx.card(iid))
          .filter((c) => c && !c.isAbility && c.controller !== ctx.controller)
          .map((c) => ({ kind: 'spell', iid: c!.iid }) as TargetRef);

        const permTargets: TargetRef[] = battlefield(state)
          .filter((c) => !isType(c, 'Land'))
          .map((c) => ({ kind: 'permanent', iid: c.iid }) as TargetRef)
          // Veil of Summer stops this half — the Horror is a blue source.
          .filter((t) => !isProtectedFrom(state, t, ctx.self.iid, ctx.controller));

        const modes = [
          {
            index: 0,
            text: "Return target spell you don't control to its owner's hand",
            enabled: spellTargets.length > 0,
            disabledReason: 'No spell you do not control is on the stack',
          },
          {
            index: 1,
            text: "Return target nonland permanent to its owner's hand",
            enabled: permTargets.length > 0,
            disabledReason: 'No legal nonland permanent',
          },
        ];
        if (!modes.some((m) => m.enabled)) return { modes: [], targets: [] };

        const chosen = yield* ctx.chooseMode({
          player: ctx.controller,
          modes,
          min: 0,
          max: 1,
          prompt: 'Hullbreaker Horror — choose up to one',
        });
        if (chosen.length === 0) return { modes: [], targets: [] };

        const pool = chosen[0] === 0 ? spellTargets : permTargets;
        if (pool.length === 1) return { modes: chosen, targets: pool };
        const picked = yield* ctx.chooseTargets({
          player: ctx.controller,
          candidates: pool,
          count: 1,
          prompt: chosen[0] === 0 ? 'Choose a spell to bounce' : 'Choose a permanent to bounce',
        });
        return { modes: chosen, targets: picked };
      },
      *resolve(ctx) {
        if (ctx.chosenModes.length === 0) return;
        const t = ctx.targets[0];
        if (!t) return;
        if (t.kind === 'spell') {
          const spell = ctx.card(t.iid);
          if (!spell || spell.zone !== 'stack') return;
          // Bouncing is not countering, so "can't be countered" does not stop it.
          // That is how the mirror gets through Veil of Summer and Mistrise Village.
          const i = ctx.state.stack.indexOf(t.iid);
          if (i >= 0) ctx.state.stack.splice(i, 1);
          ctx.log(`returns ${cardName(spell)} from the stack to its owner's hand`, [t.iid]);
          yield* ctx.moveTo(t.iid, 'hand');
        } else if (t.kind === 'permanent') {
          const perm = ctx.card(t.iid);
          if (!perm || perm.zone !== 'battlefield') return;
          // cardName, not frontFace: the target may be an Army token with no oracle entry.
          ctx.log(`returns ${cardName(perm)} to its owner's hand`, [t.iid]);
          yield* ctx.moveTo(t.iid, 'hand');
        }
      },
    },
  ],
};

export const orcishBowmasters: CardScript = {
  oracleId: 'orcish_bowmasters',
  abilities: [
    {
      kind: 'triggered',
      label: 'Deal 1 damage to any target, then amass Orcs 1',
      trigger: (ev, self) => {
        if (ev.t === 'entersBattlefield' && ev.iid === self.iid) return true;
        if (ev.t !== 'draw') return false;
        if (ev.player === self.controller) return false;
        // "...except the first one they draw in each of their draw steps."
        return !ev.firstOfDrawStep;
      },
      targets: [
        {
          prompt: 'Choose any target for 1 damage',
          candidates: (state, controller, self): TargetRef[] => {
            const out: TargetRef[] = [
              { kind: 'player', id: 'p1' },
              { kind: 'player', id: 'p2' },
            ];
            for (const c of battlefield(state)) {
              if (isType(c, 'Creature') || isType(c, 'Planeswalker') || isType(c, 'Battle')) {
                out.push({ kind: 'permanent', iid: c.iid });
              }
            }
            // Bowmasters is a black source, so Veil of Summer turns these off. If
            // nothing legal is left the whole trigger is removed and the amass does
            // not happen either.
            return out.filter((t) => !isProtectedFrom(state, t, self.iid, controller));
          },
        },
      ],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (t) {
          ctx.dealDamage({ sourceIid: ctx.self.iid, target: t, amount: 1 });
        }
        yield* ctx.amass(ctx.controller, 'Orc', 1);
      },
    },
  ],
};

/** Convenience for the UI: does this player control an Army token? */
export function armyOf(state: Parameters<typeof battlefield>[0], player: PlayerId) {
  return battlefield(state, player).find((c) => c.token?.subtypes.includes('Army'));
}
