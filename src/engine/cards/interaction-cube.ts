import { frontFace } from '../oracle.js';
import { battlefield, isType, manaValueOfCard } from '../state.js';
import type { CardScript, Ctx, Eff } from '../script-types.js';
import type { CardInstance, GameState, IID, PlayerId, TargetRef } from '../types.js';

/**
 * Removal, discard and the graveyard.
 *
 * Everything here answers a permanent, a hand or a graveyard rather than the
 * stack — the counterspells live next door in counters.ts.
 */

function permanents(
  state: GameState,
  filter: (c: CardInstance) => boolean = () => true,
): TargetRef[] {
  return [...state.zones.p1.battlefield, ...state.zones.p2.battlefield]
    .map((iid) => state.cards[iid])
    .filter((c): c is CardInstance => Boolean(c) && filter(c))
    .map((c): TargetRef => ({ kind: 'permanent', iid: c.iid }));
}

const isCreature = (c: CardInstance) => isType(c, 'Creature');
const isWalker = (c: CardInstance) => isType(c, 'Planeswalker');
const isArtifactOrEnchantment = (c: CardInstance) =>
  isType(c, 'Artifact') || isType(c, 'Enchantment');

function players(): TargetRef[] {
  return [
    { kind: 'player', id: 'p1' },
    { kind: 'player', id: 'p2' },
  ];
}

/** "Reveals their hand, you choose a card, they discard it." */
function* revealAndDiscard(
  ctx: Ctx,
  victim: PlayerId,
  allow: (c: CardInstance) => boolean,
  label: string,
): Eff {
  const hand = ctx.hand(victim);
  if (hand.length === 0) {
    ctx.log(`${victim} has no cards in hand`);
    return;
  }
  const legal = hand.filter(allow);
  ctx.log(`${victim} reveals their hand`);
  if (legal.length === 0) {
    ctx.log(`nothing there is ${label}`);
    return;
  }
  const picked = yield* ctx.chooseCards({
    player: ctx.controller,
    cards: hand.map((c) => c.iid),
    min: 1,
    max: 1,
    prompt: `Choose a ${label} card to discard`,
    from: 'hand',
    publicReveal: true,
    disabled: hand.filter((c) => !allow(c)).map((c) => ({ iid: c.iid, reason: `not ${label}` })),
  });
  if (picked.length === 0) return;
  const card = ctx.card(picked[0]);
  ctx.log(`${victim} discards ${card ? frontFace(card.oracleId).name : 'a card'}`);
  yield* ctx.moveTo(picked[0], 'graveyard');
}

const nonland = (c: CardInstance) => !frontFace(c.oracleId).types.includes('Land');
const noncreatureNonland = (c: CardInstance) => {
  const t = frontFace(c.oracleId).types;
  return !t.includes('Land') && !t.includes('Creature');
};

export const thoughtseize: CardScript = {
  oracleId: 'thoughtseize',
  targets: [{ prompt: 'Target player reveals their hand', candidates: players }],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind !== 'player') return;
    yield* revealAndDiscard(ctx, t.id, nonland, 'nonland');
    ctx.loseLife(ctx.controller, 2);
  },
};

export const duress: CardScript = {
  oracleId: 'duress',
  targets: [{ prompt: 'Target opponent reveals their hand', candidates: players }],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind !== 'player') return;
    yield* revealAndDiscard(ctx, t.id, noncreatureNonland, 'noncreature, nonland');
  },
};

export const thoughtErasure: CardScript = {
  oracleId: 'thought_erasure',
  targets: [{ prompt: 'Target opponent reveals their hand', candidates: players }],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (t && t.kind === 'player') yield* revealAndDiscard(ctx, t.id, nonland, 'nonland');
    yield* ctx.surveil(ctx.controller, 1);
  },
};

export const swordsToPlowshares: CardScript = {
  oracleId: 'swords_to_plowshares',
  targets: [
    {
      prompt: 'Exile target creature',
      candidates: (state) => permanents(state, isCreature),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind !== 'permanent') return;
    const c = ctx.card(t.iid);
    if (!c || c.zone !== 'battlefield') return;
    // Life equal to its power, to its controller — not to you.
    const power = Number(frontFace(c.oracleId).power ?? '0') + (c.counters['+1/+1'] ?? 0);
    const owner = c.controller;
    ctx.log(`exiles ${frontFace(c.oracleId).name}`);
    yield* ctx.moveTo(t.iid, 'exile');
    if (power > 0) ctx.gainLife(owner, power);
  },
};

export const abruptDecay: CardScript = {
  oracleId: 'abrupt_decay',
  cantBeCountered: true,
  targets: [
    {
      prompt: 'Destroy target nonland permanent with mana value 3 or less',
      candidates: (state) =>
        permanents(
          state,
          (c) => !frontFace(c.oracleId).types.includes('Land') && manaValueOfCard(c) <= 3,
        ),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (t && t.kind === 'permanent') yield* ctx.moveTo(t.iid, 'graveyard');
  },
};

export const krosanGrip: CardScript = {
  oracleId: 'krosan_grip',
  splitSecond: true,
  targets: [
    {
      prompt: 'Destroy target artifact or enchantment',
      candidates: (state) => permanents(state, isArtifactOrEnchantment),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (t && t.kind === 'permanent') yield* ctx.moveTo(t.iid, 'graveyard');
  },
};

export const naturesClaim: CardScript = {
  oracleId: 'natures_claim',
  targets: [
    {
      prompt: 'Destroy target artifact or enchantment',
      candidates: (state) => permanents(state, isArtifactOrEnchantment),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind !== 'permanent') return;
    const c = ctx.card(t.iid);
    if (!c || c.zone !== 'battlefield') return;
    const owner = c.controller;
    yield* ctx.moveTo(t.iid, 'graveyard');
    // The four life is the whole drawback, and it goes to them.
    ctx.gainLife(owner, 4);
  },
};

export const bitterTriumph: CardScript = {
  oracleId: 'bitter_triumph',
  additionalCost: {
    label: 'discard a card or pay 3 life',
    canPay: (state, controller) =>
      state.zones[controller].hand.length > 0 || state.players[controller].life > 3,
    *pay(ctx) {
      const canDiscard = ctx.hand(ctx.controller).length > 0;
      const canPayLife = ctx.state.players[ctx.controller].life > 3;
      if (!canDiscard && !canPayLife) return false;
      const discard =
        canDiscard && canPayLife
          ? yield* ctx.yesNo(ctx.controller, 'Bitter Triumph — discard a card, or pay 3 life?', {
              yes: 'Discard a card',
              no: 'Pay 3 life',
            })
          : canDiscard;
      if (discard) {
        const picked = yield* ctx.chooseCards({
          player: ctx.controller,
          cards: ctx.hand(ctx.controller).map((c) => c.iid),
          min: 1,
          max: 1,
          prompt: 'Discard a card',
          from: 'hand',
        });
        if (picked.length === 0) return false;
        yield* ctx.moveTo(picked[0], 'graveyard');
        ctx.log('discards a card for Bitter Triumph');
      } else {
        ctx.loseLife(ctx.controller, 3);
      }
      return true;
    },
  },
  targets: [
    {
      prompt: 'Destroy target creature or planeswalker',
      candidates: (state) => permanents(state, (c) => isCreature(c) || isWalker(c)),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (t && t.kind === 'permanent') yield* ctx.moveTo(t.iid, 'graveyard');
  },
};

export const bloodchiefsThirst: CardScript = {
  oracleId: 'bloodchiefs_thirst',
  kicker: { cost: '{2}{B}', label: 'kicked' },
  targets: [
    {
      prompt: 'Destroy target creature or planeswalker',
      /*
       * Unkicked it only reaches mana value 2 or less — but targets are chosen
       * knowing whether the kicker was paid, so the candidate list has to ask
       * the instance rather than the card. `self.kicked` is set as it is cast.
       */
      candidates: (state, _controller, self) =>
        permanents(
          state,
          (c) => (isCreature(c) || isWalker(c)) && (self.kicked === true || manaValueOfCard(c) <= 2),
        ),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (t && t.kind === 'permanent') yield* ctx.moveTo(t.iid, 'graveyard');
  },
};

/**
 * Sheoldred's Edict — each opponent chooses. An edict rather than removal: the
 * choice belongs to them, which is why it beats hexproof and loses to a token.
 */
export const sheoldredsEdict: CardScript = {
  oracleId: 'sheoldreds_edict',
  modes: {
    min: 1,
    max: 1,
    prompt: 'Choose one',
    options: [
      { text: 'Each opponent sacrifices a nontoken creature of their choice.' },
      { text: 'Each opponent sacrifices a creature token of their choice.' },
      { text: 'Each opponent sacrifices a planeswalker of their choice.' },
    ],
  },
  *resolve(ctx) {
    const mode = ctx.chosenModes[0] ?? 0;
    const wanted = (c: CardInstance) =>
      mode === 0
        ? isCreature(c) && !c.isToken
        : mode === 1
          ? isCreature(c) && c.isToken
          : isWalker(c);
    const opp = ctx.opponent;
    const options = ctx.battlefieldOf(opp).filter(wanted);
    if (options.length === 0) {
      ctx.log('they have nothing to sacrifice');
      return;
    }
    const picked = yield* ctx.chooseCards({
      player: opp,
      cards: options.map((c) => c.iid),
      min: 1,
      max: 1,
      prompt: 'Sacrifice one',
      from: 'battlefield',
    });
    if (picked.length > 0) yield* ctx.sacrifice(picked[0]);
  },
};

/**
 * Surgical Extraction — the reason a graveyard is not safe. Everything with
 * that name, from every hidden zone, gone.
 */
export const surgicalExtraction: CardScript = {
  oracleId: 'surgical_extraction',
  targets: [
    {
      prompt: 'Choose target card in a graveyard',
      candidates: (state): TargetRef[] =>
        (['p1', 'p2'] as PlayerId[]).flatMap((p) =>
          state.zones[p].graveyard
            .map((iid) => state.cards[iid])
            .filter((c) => c && !frontFace(c.oracleId).supertypes.includes('Basic'))
            .map((c): TargetRef => ({ kind: 'card', iid: c.iid, zone: 'graveyard' })),
        ),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind !== 'card') return;
    const card = ctx.card(t.iid);
    if (!card) return;
    const owner = card.owner;
    const name = frontFace(card.oracleId).name;
    const same = (c: CardInstance) => frontFace(c.oracleId).name === name;

    const found: IID[] = [
      ...ctx.graveyard(owner).filter(same),
      ...ctx.hand(owner).filter(same),
      ...ctx.library(owner).filter(same),
    ].map((c) => c.iid);
    for (const iid of found) yield* ctx.moveTo(iid, 'exile');
    ctx.log(`exiles ${found.length} × ${name} from ${owner}'s graveyard, hand and library`);
    ctx.shuffleLibrary(owner);
  },
};

/** Reanimate: the cheapest way to break a Show and Tell mirror wide open. */
export const reanimate: CardScript = {
  oracleId: 'reanimate',
  targets: [
    {
      prompt: 'Put target creature card from a graveyard onto the battlefield',
      candidates: (state): TargetRef[] =>
        (['p1', 'p2'] as PlayerId[]).flatMap((p) =>
          state.zones[p].graveyard
            .map((iid) => state.cards[iid])
            .filter((c) => c && frontFace(c.oracleId).types.includes('Creature'))
            .map((c): TargetRef => ({ kind: 'card', iid: c.iid, zone: 'graveyard' })),
        ),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (!t || t.kind !== 'card') return;
    const card = ctx.card(t.iid);
    if (!card || card.zone !== 'graveyard') return;
    const cost = manaValueOfCard(card);
    yield* ctx.moveToBattlefield(t.iid, { controller: ctx.controller });
    ctx.loseLife(ctx.controller, cost);
  },
};

export const auroralProcession: CardScript = {
  oracleId: 'auroral_procession',
  targets: [
    {
      prompt: 'Return target card from your graveyard to your hand',
      candidates: (state, controller): TargetRef[] =>
        state.zones[controller].graveyard.map((iid) => ({ kind: 'card', iid, zone: 'graveyard' })),
    },
  ],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (t && t.kind === 'card') yield* ctx.moveTo(t.iid, 'hand');
  },
};

export const thoughtScour: CardScript = {
  oracleId: 'thought_scour',
  targets: [{ prompt: 'Target player mills two cards', candidates: players }],
  *resolve(ctx) {
    const t = ctx.targets[0];
    if (t && t.kind === 'player') yield* ctx.mill(t.id, 2);
    ctx.draw(ctx.controller, 1);
  },
};

export const growthSpiral: CardScript = {
  oracleId: 'growth_spiral',
  *resolve(ctx) {
    ctx.draw(ctx.controller, 1);
    yield* playALandFromHand(ctx, 'You may put a land from your hand onto the battlefield');
  },
};

/** Shared by Growth Spiral and Uro: an extra land, straight from hand. */
export function* playALandFromHand(ctx: Ctx, prompt: string): Eff {
  const lands = ctx.hand(ctx.controller).filter((c) => frontFace(c.oracleId).types.includes('Land'));
  if (lands.length === 0) return;
  const picked = yield* ctx.chooseCards({
    player: ctx.controller,
    cards: lands.map((c) => c.iid),
    min: 0,
    max: 1,
    prompt,
    from: 'hand',
  });
  if (picked.length === 0) {
    ctx.log('declines the extra land');
    return;
  }
  // Not a land drop: it does not use the one per turn (CR 305.1 vs an effect).
  ctx.log('puts a land onto the battlefield');
  yield* ctx.moveToBattlefield(picked[0]);
}

export const expressiveIteration: CardScript = {
  oracleId: 'expressive_iteration',
  *resolve(ctx) {
    const top = ctx.library(ctx.controller).slice(0, 3).map((c) => c.iid);
    if (top.length === 0) return;
    const toHand = yield* ctx.chooseCards({
      player: ctx.controller,
      cards: top,
      min: 1,
      max: 1,
      prompt: 'Put one into your hand',
      from: 'library',
    });
    if (toHand.length > 0) yield* ctx.moveTo(toHand[0], 'hand');
    const rest = top.filter((i) => !toHand.includes(i));
    if (rest.length === 0) return;
    const exiled = yield* ctx.chooseCards({
      player: ctx.controller,
      cards: rest,
      min: 1,
      max: 1,
      prompt: 'Exile one — you may play it this turn',
      from: 'library',
    });
    for (const iid of exiled) {
      yield* ctx.moveTo(iid, 'exile');
      ctx.addEffect({
        kind: 'castFromElsewhere',
        controller: ctx.controller,
        iids: [iid],
        zone: 'exile',
        mode: 'play',
        expires: 'endOfTurn',
      });
    }
    for (const iid of rest.filter((i) => !exiled.includes(i))) {
      yield* ctx.moveTo(iid, 'library', { position: 'bottom' });
    }
    ctx.log('takes one, exiles one to play this turn, bottoms one');
  },
};

/**
 * Timetwister — the biggest single swing in the cube. Hand and graveyard back
 * in, shuffle, seven new. Both players, which is what makes it a decision.
 */
export const timetwister: CardScript = {
  oracleId: 'timetwister',
  *resolve(ctx) {
    for (const p of ['p1', 'p2'] as PlayerId[]) {
      for (const c of [...ctx.hand(p), ...ctx.graveyard(p)]) {
        // The Timetwister itself is still on the stack, so it is not caught here
        // — it goes to the graveyard afterwards, as the card says.
        yield* ctx.moveTo(c.iid, 'library');
      }
      ctx.shuffleLibrary(p);
      ctx.draw(p, 7);
      ctx.log(`${p} shuffles in and draws seven`);
    }
  },
};

export const strongholdGambit: CardScript = {
  oracleId: 'stronghold_gambit',
  *resolve(ctx) {
    // Each player chooses in secret, then both reveal: the engine already has
    // exactly this primitive, because Show and Tell needs it.
    const picks = yield* ctx.simultaneousSecret({
      prompt: 'Each player chooses a card in their hand',
      optionsFor: (p) => ctx.hand(p).map((c) => ({ iid: c.iid })),
      promptFor: () => 'Choose a card from your hand',
    });
    const revealed = (['p1', 'p2'] as PlayerId[])
      .map((p) => ({ p, iid: picks[p] }))
      .filter((x): x is { p: PlayerId; iid: IID } => x.iid !== null);
    for (const { p, iid } of revealed) {
      const c = ctx.card(iid);
      ctx.log(`${p} reveals ${c ? frontFace(c.oracleId).name : 'a card'}`);
    }
    const creatures = revealed.filter(({ iid }) => {
      const c = ctx.card(iid);
      return c && frontFace(c.oracleId).types.includes('Creature');
    });
    if (creatures.length === 0) return;
    const lowest = Math.min(
      ...creatures.map(({ iid }) => {
        const c = ctx.card(iid);
        return c ? manaValueOfCard(c) : Infinity;
      }),
    );
    // "The owner of each creature card revealed this way with the lowest mana
    // value" — a tie means both of them.
    for (const { iid } of creatures) {
      const c = ctx.card(iid);
      if (!c || manaValueOfCard(c) !== lowest) continue;
      yield* ctx.moveToBattlefield(iid, { controller: c.owner });
    }
  },
};

export const sauronsRansom: CardScript = {
  oracleId: 'saurons_ransom',
  *resolve(ctx) {
    const top = ctx.library(ctx.controller).slice(0, 4).map((c) => c.iid);
    if (top.length === 0) return;
    /*
     * They split, you choose. The engine has no "face-down pile" primitive and
     * does not need one: the split is a choice made by the opponent over cards
     * they can see, and the pile you did not take goes to the graveyard.
     */
    const theirPile = yield* ctx.chooseCards({
      player: ctx.opponent,
      cards: top,
      min: 0,
      max: top.length,
      prompt: 'Separate these into two piles — choose the cards for one pile',
      from: 'library',
      publicReveal: true,
    });
    const other = top.filter((i) => !theirPile.includes(i));
    const takeFirst = yield* ctx.yesNo(
      ctx.controller,
      `Take the pile of ${theirPile.length}, or the pile of ${other.length}?`,
      { yes: `Take ${theirPile.length}`, no: `Take ${other.length}` },
    );
    const mine = takeFirst ? theirPile : other;
    const binned = takeFirst ? other : theirPile;
    for (const iid of mine) yield* ctx.moveTo(iid, 'hand');
    for (const iid of binned) yield* ctx.moveTo(iid, 'graveyard');
    ctx.log(`takes ${mine.length} into hand, ${binned.length} to the graveyard`);
  },
};

export const CUBE_INTERACTION: CardScript[] = [
  thoughtseize,
  duress,
  thoughtErasure,
  swordsToPlowshares,
  abruptDecay,
  krosanGrip,
  naturesClaim,
  bitterTriumph,
  bloodchiefsThirst,
  sheoldredsEdict,
  surgicalExtraction,
  reanimate,
  auroralProcession,
  thoughtScour,
  growthSpiral,
  expressiveIteration,
  timetwister,
  strongholdGambit,
  sauronsRansom,
];

void battlefield;
