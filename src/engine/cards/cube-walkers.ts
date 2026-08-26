import { frontFace } from '../oracle.js';
import type { CardScript, Eff } from '../script-types.js';
import type { CardInstance, GameState, PlayerId, TargetRef } from '../types.js';
import { lookAtFourTakeOne } from './cube-creatures.js';

/**
 * The cube's planeswalkers.
 *
 * The engine does the parts that are the same for all of them: starting loyalty
 * on arrival, the counters as the cost, sorcery timing, one per turn, damage
 * removing loyalty, and dying at zero. What is left here is only what each one
 * actually does.
 */

const players = (): TargetRef[] => [
  { kind: 'player', id: 'p1' },
  { kind: 'player', id: 'p2' },
];

function creatures(state: GameState): TargetRef[] {
  return [...state.zones.p1.battlefield, ...state.zones.p2.battlefield]
    .map((iid) => state.cards[iid])
    .filter((c): c is CardInstance => Boolean(c) && frontFace(c.oracleId).types.includes('Creature'))
    .map((c): TargetRef => ({ kind: 'permanent', iid: c.iid }));
}

function* nothing(): Eff {
  // A resolve() that asks nothing is still a generator.
}

/**
 * Jace, the Perfected Mind. Compleated: the Phyrexian pip may be paid with two
 * life, and if it was he arrives with two fewer loyalty — which the engine
 * handles as the walker enters, reading what was actually paid.
 */
export const jaceThePerfectedMind: CardScript = {
  oracleId: 'jace_the_perfected_mind',
  abilities: [
    {
      kind: 'activated',
      text: '+1: Until your next turn, up to one target creature gets -3/-0.',
      cost: { loyalty: 1 },
      timing: 'sorcery',
      targets: [
        { prompt: 'Up to one target creature gets -3/-0', optional: true, candidates: creatures },
      ],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (!t || t.kind !== 'permanent') return;
        ctx.addEffect({
          kind: 'ptBuff',
          iids: [t.iid],
          power: -3,
          toughness: 0,
          // "Until your next turn" is a turn longer than end of turn; end of
          // turn is the closest the engine models, and it is the half that
          // matters — the creature was going to attack this turn or not at all.
          expires: 'endOfTurn',
        });
        ctx.log('gives it -3/-0');
        yield* nothing();
      },
    },
    {
      kind: 'activated',
      text: '−2: Target player mills three cards, then you draw.',
      cost: { loyalty: -2 },
      timing: 'sorcery',
      targets: [{ prompt: 'Target player mills three cards', candidates: players }],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (t && t.kind === 'player') yield* ctx.mill(t.id, 3);
        // "If a graveyard has twenty or more cards in it, you draw three."
        const big = (['p1', 'p2'] as PlayerId[]).some((p) => ctx.graveyard(p).length >= 20);
        ctx.draw(ctx.controller, big ? 3 : 1);
      },
    },
    {
      kind: 'activated',
      text: '−X: Target player mills three times X cards.',
      cost: { loyaltyX: true },
      timing: 'sorcery',
      targets: [{ prompt: 'Target player mills three times X cards', candidates: players }],
      *resolve(ctx) {
        const x = Number(ctx.context.x ?? 0);
        const t = ctx.targets[0];
        if (t && t.kind === 'player') yield* ctx.mill(t.id, x * 3);
      },
    },
  ],
};

/**
 * Narset, Parter of Veils. The static half — "each opponent can't draw more
 * than one card each turn" — lives in the engine's draw(), because a
 * replacement effect has to be where the drawing happens.
 */
export const narsetParterOfVeils: CardScript = {
  oracleId: 'narset_parter_of_veils',
  abilities: [
    {
      kind: 'activated',
      text: '−2: Look at the top four cards; you may reveal a noncreature, nonland card.',
      cost: { loyalty: -2 },
      timing: 'sorcery',
      *resolve(ctx) {
        yield* lookAtFourTakeOne(ctx);
      },
    },
  ],
};

export const ralCracklingWit: CardScript = {
  oracleId: 'ral_crackling_wit',
  abilities: [
    {
      kind: 'triggered',
      label: 'Put a loyalty counter on Ral',
      trigger: (ev, self, state) => {
        if (ev.t !== 'spellCast' || ev.controller !== self.controller) return false;
        const spell = state.cards[ev.iid];
        return Boolean(spell) && !frontFace(spell.oracleId).types.includes('Creature');
      },
      *resolve(ctx) {
        ctx.addCounters(ctx.self.iid, 'loyalty', 1);
        yield* nothing();
      },
    },
    {
      kind: 'activated',
      text: '+1: Create a 1/1 blue and red Otter with prowess.',
      cost: { loyalty: 1 },
      timing: 'sorcery',
      *resolve(ctx) {
        ctx.createToken(ctx.controller, {
          name: 'Otter',
          types: ['Creature'],
          subtypes: ['Otter'],
          colors: ['U', 'R'],
          power: 1,
          toughness: 1,
        });
        yield* nothing();
      },
    },
    {
      kind: 'activated',
      text: '−3: Draw three cards, then discard two cards.',
      cost: { loyalty: -3 },
      timing: 'sorcery',
      *resolve(ctx) {
        ctx.draw(ctx.controller, 1);
        ctx.draw(ctx.controller, 1);
        ctx.draw(ctx.controller, 1);
        const hand = ctx.hand(ctx.controller).map((c) => c.iid);
        if (hand.length === 0) return;
        const n = Math.min(2, hand.length);
        const picked = yield* ctx.chooseCards({
          player: ctx.controller,
          cards: hand,
          min: n,
          max: n,
          prompt: `Discard ${n}`,
          from: 'hand',
        });
        for (const iid of picked) yield* ctx.moveTo(iid, 'graveyard');
        ctx.log(`discards ${picked.length}`);
      },
    },
    {
      kind: 'activated',
      text: '−10: Draw three cards and get an emblem with storm.',
      cost: { loyalty: -10 },
      timing: 'sorcery',
      *resolve(ctx) {
        ctx.draw(ctx.controller, 1);
        ctx.draw(ctx.controller, 1);
        ctx.draw(ctx.controller, 1);
        ctx.addEffect({ kind: 'stormEmblem', player: ctx.controller, expires: 'permanent' });
        ctx.log('gets an emblem: your instants and sorceries have storm');
        yield* nothing();
      },
    },
  ],
};

export const tamiyoCollectorOfTales: CardScript = {
  oracleId: 'tamiyo_collector_of_tales',
  abilities: [
    {
      kind: 'activated',
      text: '+1: Name a card, reveal four, take the matches.',
      cost: { loyalty: 1 },
      timing: 'sorcery',
      *resolve(ctx) {
        // Naming from the whole card pool would be a thousand-item menu; the
        // useful set is what could actually be in the library, which is what a
        // player naming a card is choosing between anyway.
        const names = [
          ...new Set(ctx.library(ctx.controller).map((c) => frontFace(c.oracleId).name)),
        ].sort();
        const chosen = yield* ctx.chooseName(ctx.controller, names, 'Choose a nonland card name');
        if (!chosen) return;
        const top = ctx.library(ctx.controller).slice(0, 4);
        ctx.log(`names ${chosen} and reveals four`);
        for (const c of top) {
          const match = frontFace(c.oracleId).name === chosen;
          yield* ctx.moveTo(c.iid, match ? 'hand' : 'graveyard');
        }
      },
    },
    {
      kind: 'activated',
      text: '−3: Return target card from your graveyard to your hand.',
      cost: { loyalty: -3 },
      timing: 'sorcery',
      targets: [
        {
          prompt: 'Return target card from your graveyard to your hand',
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
        if (t && t.kind === 'card') yield* ctx.moveTo(t.iid, 'hand');
      },
    },
  ],
};

/**
 * Tamiyo, Inquisitive Student — a creature that transforms into a planeswalker
 * on your third draw of a turn. The engine's `drawsThisTurn` counter is what
 * makes that condition checkable at all.
 */
export const tamiyoInquisitiveStudent: CardScript = {
  oracleId: 'tamiyo_inquisitive_student',
  abilities: [
    {
      kind: 'triggered',
      label: 'Investigate',
      trigger: (ev, self) => ev.t === 'attacks' && ev.iid === self.iid,
      *resolve(ctx) {
        ctx.createToken(ctx.controller, {
          name: 'Clue',
          types: ['Artifact'],
          subtypes: ['Clue'],
          colors: [],
          power: 0,
          toughness: 0,
        });
        ctx.log('investigates');
        yield* nothing();
      },
    },
    {
      kind: 'triggered',
      label: 'Transform Tamiyo',
      trigger: (ev, self, state) =>
        ev.t === 'draw' &&
        ev.player === self.controller &&
        state.players[self.controller].drawsThisTurn === 3 &&
        self.face === 'front',
      *resolve(ctx) {
        ctx.transform(ctx.self.iid);
        ctx.log('transforms into Tamiyo, Seasoned Scholar');
        yield* nothing();
      },
    },
    {
      kind: 'activated',
      text: '−3: Return target instant or sorcery from your graveyard to your hand.',
      cost: { loyalty: -3 },
      timing: 'sorcery',
      canActivate: (_state, self) => self.face === 'back',
      targets: [
        {
          prompt: 'Return target instant or sorcery card from your graveyard',
          candidates: (state, controller): TargetRef[] =>
            state.zones[controller].graveyard
              .map((iid) => state.cards[iid])
              .filter((c) => {
                const t = c ? frontFace(c.oracleId).types : [];
                return t.includes('Instant') || t.includes('Sorcery');
              })
              .map((c): TargetRef => ({ kind: 'card', iid: c.iid, zone: 'graveyard' })),
        },
      ],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (t && t.kind === 'card') yield* ctx.moveTo(t.iid, 'hand');
      },
    },
  ],
};

export const CUBE_WALKERS: CardScript[] = [
  jaceThePerfectedMind,
  narsetParterOfVeils,
  ralCracklingWit,
  tamiyoCollectorOfTales,
  tamiyoInquisitiveStudent,
];
