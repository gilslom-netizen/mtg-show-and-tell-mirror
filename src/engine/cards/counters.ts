import { currentFace } from '../state.js';
import type { CardScript, Ctx, Eff } from '../script-types.js';
import type { CardInstance, GameState, TargetRef } from '../types.js';

/**
 * The cube's counterspells.
 *
 * They are one file because they are one card with eight settings: what may be
 * targeted, what the controller may pay to save it, and where the countered
 * spell ends up. Writing them apart would have hidden how much they share —
 * writing them together makes the differences the only thing you read.
 */

/**
 * Spells on the stack — anyone's.
 *
 * "Counter target spell" means target spell. Not one of these cards says "you
 * don't control", and countering your own is a real play: Mana Drain on your own
 * seven-drop for the mana, Memory Lapse to put your own card back on top,
 * Reprieve to save something from a worse fate than a bounce. The list used to
 * be the opponent's spells only, so none of that could be chosen at all.
 *
 * Hullbreaker Horror keeps its restriction, because Hullbreaker Horror is the
 * one that actually prints it.
 *
 * The one spell left out is the one doing the targeting. Countering yourself is
 * legal and worth nothing, and offering it costs a great deal: with it in the
 * list every counterspell has two candidates instead of one, so the game stops
 * to ask a question it used to answer for you — and Pyroblast's "counter target
 * spell" mode became castable off an empty stack, pointing at itself.
 */
function spellsOnStack(
  state: GameState,
  self: CardInstance | null,
  filter: (c: CardInstance) => boolean = () => true,
): TargetRef[] {
  return state.stack
    .map((iid) => state.cards[iid])
    .filter((c) => c && !c.isAbility && c.iid !== self?.iid && filter(c))
    .map((c): TargetRef => ({ kind: 'spell', iid: c.iid }));
}

const isNoncreature = (c: CardInstance) => !currentFace(c).types.includes('Creature');
const isInstantOrSorcery = (c: CardInstance) => {
  const t = currentFace(c).types;
  return t.includes('Instant') || t.includes('Sorcery');
};
const isBlue = (c: CardInstance) => currentFace(c).colors.includes('U');

/**
 * "Counter unless its controller pays {N}."
 *
 * The tax is a real decision made by the spell's controller, so it is asked of
 * them rather than assumed either way — and it is asked only when they could
 * actually pay, because a prompt with one answer is just a slower counterspell.
 */
function* counterUnlessPaid(ctx: Ctx, amount: number): Eff {
  const t = ctx.targets[0];
  if (!t || t.kind !== 'spell') return;
  const spell = ctx.card(t.iid);
  if (!spell || spell.zone !== 'stack') return;
  const owner = spell.controller;
  const paid = yield* ctx.payOrDecline(owner, `{${amount}}`, `Pay {${amount}} to save ${currentFace(spell).name}?`);
  if (paid) {
    ctx.log(`${currentFace(spell).name} is paid for`);
    return;
  }
  ctx.counterSpell(t.iid);
}

function counterTargets(
  prompt: string,
  filter?: (c: CardInstance) => boolean,
): CardScript['targets'] {
  return [{ prompt, candidates: (state, _c, self) => spellsOnStack(state, self, filter) }];
}

export const spellPierce: CardScript = {
  oracleId: 'spell_pierce',
  targets: counterTargets('Counter target noncreature spell unless its controller pays {2}', isNoncreature),
  *resolve(ctx) {
    yield* counterUnlessPaid(ctx, 2);
  },
};

export const miscast: CardScript = {
  oracleId: 'miscast',
  targets: counterTargets(
    'Counter target instant or sorcery spell unless its controller pays {1}',
    isInstantOrSorcery,
  ),
  *resolve(ctx) {
    yield* counterUnlessPaid(ctx, 1);
  },
};

export const flusterstorm: CardScript = {
  oracleId: 'flusterstorm',
  storm: true,
  targets: counterTargets(
    'Counter target instant or sorcery spell unless its controller pays {1}',
    isInstantOrSorcery,
  ),
  *resolve(ctx) {
    yield* counterUnlessPaid(ctx, 1);
  },
};

/**
 * Mystical Dispute — {2} cheaper against a blue spell, which in a format where
 * nearly everything is blue makes it a one-mana counter that reads as three.
 * The reduction is a cast-time question, so it lives on `costReduction`.
 */
export const mysticalDispute: CardScript = {
  oracleId: 'mystical_dispute',
  // "if it targets a blue spell" — whoever cast it. Your own blue spell is a
  // legal target now, so it earns the discount the same way theirs does.
  costReduction: (state, _c, self) => (spellsOnStack(state, self, isBlue).length > 0 ? 2 : 0),
  targets: counterTargets('Counter target spell unless its controller pays {3}'),
  *resolve(ctx) {
    yield* counterUnlessPaid(ctx, 3);
  },
};

export const dovinsVeto: CardScript = {
  oracleId: 'dovins_veto',
  cantBeCountered: true,
  targets: counterTargets('Counter target noncreature spell', isNoncreature),
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (t && t.kind === 'spell') ctx.counterSpell(t.iid);
    yield* nothing();
  },
};

/**
 * Memory Lapse: countered, but put on top of the library instead of into the
 * graveyard. Not a Time Walk — they draw it again — which is why it is a
 * counterspell you play in a deck that wins before they untap.
 */
export const memoryLapse: CardScript = {
  oracleId: 'memory_lapse',
  targets: counterTargets('Counter target spell'),
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind !== 'spell') return;
    const spell = ctx.card(t.iid);
    if (!spell || spell.zone !== 'stack') return;
    if (!ctx.counterSpell(t.iid, { toLibraryTop: true })) return;
    ctx.log(`${currentFace(spell).name} goes on top of its owner's library`);
    yield* nothing();
  },
};

/**
 * Pyroblast — "counter target spell if it's blue" or "destroy target permanent
 * if it's blue". Modal, and the mode decides what may be targeted, so the
 * targets are chosen per mode as the spell goes on the stack.
 */
export const pyroblast: CardScript = {
  oracleId: 'pyroblast',
  modes: {
    min: 1,
    max: 1,
    prompt: 'Choose one',
    options: [
      {
        text: "Counter target spell if it's blue",
        targets: [
          {
            prompt: 'Counter target spell',
            candidates: (state, _c, self) => spellsOnStack(state, self),
          },
        ],
      },
      {
        text: "Destroy target permanent if it's blue",
        targets: [
          {
            prompt: 'Destroy target permanent',
            candidates: (state): TargetRef[] =>
              [...state.zones.p1.battlefield, ...state.zones.p2.battlefield].map((iid) => ({
                kind: 'permanent',
                iid,
              })),
          },
        ],
      },
    ],
  },
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind === 'player') return;
    const card = ctx.card(t.iid);
    if (!card) return;
    // "if it's blue" is a condition on the effect, checked on resolution: a
    // Pyroblast pointed at a red spell resolves and does precisely nothing.
    if (!currentFace(card).colors.includes('U')) {
      ctx.log(`${currentFace(card).name} is not blue — nothing happens`);
      return;
    }
    if (t.kind === 'spell') ctx.counterSpell(t.iid);
    else yield* ctx.moveTo(t.iid, 'graveyard');
  },
};

/**
 * Narset's Reversal: copy it, then hand the original back. The copy resolves
 * first because it goes on top — so the spell happens for you and they get the
 * card back to cast again.
 */
export const narsetsReversal: CardScript = {
  oracleId: 'narsets_reversal',
  targets: [
    {
      prompt: 'Copy target instant or sorcery spell, then return it to its owner’s hand',
      candidates: (state): TargetRef[] =>
        state.stack
          .map((iid) => state.cards[iid])
          .filter((c) => c && !c.isAbility && !c.isCopy && isInstantOrSorcery(c))
          .map((c): TargetRef => ({ kind: 'spell', iid: c.iid })),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind !== 'spell') return;
    const spell = ctx.card(t.iid);
    if (!spell || spell.zone !== 'stack') return;
    yield* ctx.copySpell(t.iid, ctx.controller, { mayRetarget: true });
    ctx.log(`returns ${currentFace(spell).name} to its owner's hand`);
    yield* ctx.moveTo(t.iid, 'hand');
  },
};

/**
 * Reprieve — not a counter at all: the spell goes back to hand, so it dodges
 * "can't be countered" entirely and buys exactly one turn.
 */
export const reprieve: CardScript = {
  oracleId: 'reprieve',
  targets: counterTargets('Return target spell to its owner’s hand'),
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (t && t.kind === 'spell') {
      const spell = ctx.card(t.iid);
      if (spell && spell.zone === 'stack') {
        ctx.log(`returns ${currentFace(spell).name} to its owner's hand`);
        yield* ctx.moveTo(t.iid, 'hand');
      }
    }
    ctx.draw(ctx.controller, 1);
  },
};

/**
 * Mindbreak Trap's sibling in spirit: exile the spells rather than counter
 * them. Kept with the counters because that is where a player looks for it.
 */
export const orimsChant: CardScript = {
  oracleId: 'orims_chant',
  kicker: { cost: '{W}', label: 'kicked' },
  targets: [
    {
      prompt: 'Target player can’t cast spells this turn',
      candidates: (): TargetRef[] => [
        { kind: 'player', id: 'p1' },
        { kind: 'player', id: 'p2' },
      ],
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (t && t.kind === 'player') {
      ctx.addEffect({ kind: 'cantCastSpells', player: t.id, expires: 'endOfTurn' });
      ctx.log(`${t.id} cannot cast spells this turn`);
    }
    if (ctx.self.kicked) {
      ctx.addEffect({ kind: 'creaturesCantAttack', expires: 'endOfTurn' });
      ctx.log('creatures cannot attack this turn');
    }
    yield* nothing();
  },
};

function* nothing(): Eff {
  // A resolve() that asks no questions still has to be a generator.
}

export const COUNTER_SCRIPTS: CardScript[] = [
  spellPierce,
  miscast,
  flusterstorm,
  mysticalDispute,
  dovinsVeto,
  memoryLapse,
  pyroblast,
  narsetsReversal,
  reprieve,
  orimsChant,
];
