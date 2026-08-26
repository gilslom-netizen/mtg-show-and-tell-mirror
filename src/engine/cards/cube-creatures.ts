import { currentFace, isType, manaValueOfCard } from '../state.js';
import type { CardScript, Ctx, Eff } from '../script-types.js';
import type { CardInstance, GameState, PlayerId, TargetRef } from '../types.js';
import { playALandFromHand } from './interaction-cube.js';

/** The cube's creatures, and the two artifacts that behave like them. */

const CARD_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Instant', 'Land', 'Planeswalker', 'Sorcery'] as const;

/** How many card types are in this graveyard — delirium's whole condition. */
function typesInGraveyard(state: GameState, player: PlayerId): number {
  const seen = new Set<string>();
  for (const iid of state.zones[player].graveyard) {
    const c = state.cards[iid];
    if (!c) continue;
    for (const t of currentFace(c).types) {
      if ((CARD_TYPES as readonly string[]).includes(t)) seen.add(t);
    }
  }
  return seen.size;
}

/**
 * Birds of Paradise and Mox Emerald need no script at all — their whole text is
 * an unconditional mana ability, which the engine derives. Chrome Mox does not:
 * its mana depends on what it imprinted, so it needs both halves written out.
 */
export const chromeMox: CardScript = {
  oracleId: 'chrome_mox',
  abilities: [
    {
      kind: 'triggered',
      label: 'Imprint — exile a nonartifact, nonland card from your hand',
      trigger: (ev, self) => ev.t === 'entersBattlefield' && ev.iid === self.iid,
      *resolve(ctx) {
        const legal = ctx
          .hand(ctx.controller)
          .filter((c) => {
            const t = currentFace(c).types;
            return !t.includes('Artifact') && !t.includes('Land');
          });
        if (legal.length === 0) return;
        const picked = yield* ctx.chooseCards({
          player: ctx.controller,
          cards: legal.map((c) => c.iid),
          min: 0,
          max: 1,
          prompt: 'Imprint — exile a nonartifact, nonland card (or nothing)',
          from: 'hand',
        });
        if (picked.length === 0) {
          ctx.log('imprints nothing — this Mox taps for no mana');
          return;
        }
        const card = ctx.card(picked[0]);
        if (!card) return;
        // The colours live on the Mox: producedMana is derived from this.
        ctx.setImprint(ctx.self.iid, picked[0]);
        ctx.log(`imprints ${currentFace(card).name}`);
        yield* ctx.moveTo(picked[0], 'exile');
      },
    },
    {
      kind: 'mana',
      produces: [],
      /** Whatever the imprinted card's colours were. */
      fromImprint: true,
    },
  ],
};

export const deathriteShaman: CardScript = {
  oracleId: 'deathrite_shaman',
  abilities: [
    {
      kind: 'activated',
      text: '{T}: Exile target land card from a graveyard. Add one mana of any color.',
      cost: { tap: true },
      isManaAbility: true,
      targets: [
        {
          prompt: 'Exile target land card from a graveyard',
          candidates: (state): TargetRef[] =>
            (['p1', 'p2'] as PlayerId[]).flatMap((p) =>
              state.zones[p].graveyard
                .map((iid) => state.cards[iid])
                .filter((c) => c && currentFace(c).types.includes('Land'))
                .map((c): TargetRef => ({ kind: 'card', iid: c.iid, zone: 'graveyard' })),
            ),
        },
      ],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (!t || t.kind !== 'card') return;
        yield* ctx.moveTo(t.iid, 'exile');
        const colour = yield* ctx.chooseColour(ctx.controller, 'Add one mana of any color');
        if (colour) ctx.addManaToPool(ctx.controller, colour, 1);
      },
    },
    {
      kind: 'activated',
      text: '{B}, {T}: Exile target instant or sorcery card from a graveyard. Each opponent loses 2 life.',
      cost: { tap: true, mana: '{B}' },
      targets: [
        {
          prompt: 'Exile target instant or sorcery card from a graveyard',
          candidates: (state): TargetRef[] =>
            (['p1', 'p2'] as PlayerId[]).flatMap((p) =>
              state.zones[p].graveyard
                .map((iid) => state.cards[iid])
                .filter((c) => {
                  const types = c ? currentFace(c).types : [];
                  return types.includes('Instant') || types.includes('Sorcery');
                })
                .map((c): TargetRef => ({ kind: 'card', iid: c.iid, zone: 'graveyard' })),
            ),
        },
      ],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (t && t.kind === 'card') yield* ctx.moveTo(t.iid, 'exile');
        ctx.loseLife(ctx.opponent, 2);
      },
    },
    {
      kind: 'activated',
      text: '{G}, {T}: Exile target creature card from a graveyard. You gain 2 life.',
      cost: { tap: true, mana: '{G}' },
      targets: [
        {
          prompt: 'Exile target creature card from a graveyard',
          candidates: (state): TargetRef[] =>
            (['p1', 'p2'] as PlayerId[]).flatMap((p) =>
              state.zones[p].graveyard
                .map((iid) => state.cards[iid])
                .filter((c) => c && currentFace(c).types.includes('Creature'))
                .map((c): TargetRef => ({ kind: 'card', iid: c.iid, zone: 'graveyard' })),
            ),
        },
      ],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (t && t.kind === 'card') yield* ctx.moveTo(t.iid, 'exile');
        ctx.gainLife(ctx.controller, 2);
      },
    },
  ],
};

/**
 * Dragon's Rage Channeler. Delirium is a live static, so it is expressed as
 * staticPt rather than as a trigger: the moment a fourth card type hits the
 * graveyard it is a 3/3, and the moment one leaves it is not.
 */
export const dragonsRageChanneler: CardScript = {
  oracleId: 'dragons_rage_channeler',
  staticPt: {
    self: (state, card) =>
      typesInGraveyard(state, card.controller) >= 4
        ? { power: 2, toughness: 2 }
        : { power: 0, toughness: 0 },
  },
  grantsKeywords: (state, card) =>
    typesInGraveyard(state, card.controller) >= 4 ? ['Flying'] : [],
  abilities: [
    {
      kind: 'triggered',
      label: 'Surveil 1',
      trigger: (ev, self, state) => {
        if (ev.t !== 'spellCast') return false;
        if (ev.controller !== self.controller) return false;
        const spell = state.cards[ev.iid];
        return Boolean(spell) && !currentFace(spell).types.includes('Creature');
      },
      *resolve(ctx) {
        yield* ctx.surveil(ctx.controller, 1);
      },
    },
  ],
};

export const psychicFrog: CardScript = {
  oracleId: 'psychic_frog',
  abilities: [
    {
      kind: 'triggered',
      label: 'Draw a card',
      trigger: (ev, self) =>
        ev.t === 'damage' &&
        ev.sourceIid === self.iid &&
        ev.target.kind === 'player' &&
        ev.combat === true,
      *resolve(ctx) {
        ctx.draw(ctx.controller, 1);
        yield* nothing();
      },
    },
    {
      kind: 'activated',
      text: 'Discard a card: Put a +1/+1 counter on this creature.',
      cost: { discard: 1 },
      *resolve(ctx) {
        ctx.addCounters(ctx.self.iid, '+1/+1', 1);
        yield* nothing();
      },
    },
    {
      kind: 'activated',
      text: 'Exile three cards from your graveyard: This creature gains flying until end of turn.',
      cost: { exileFromGraveyard: 3 },
      *resolve(ctx) {
        ctx.addEffect({
          kind: 'grantKeyword',
          iids: [ctx.self.iid],
          keyword: 'Flying',
          expires: 'endOfTurn',
        });
        ctx.log('gains flying until end of turn');
        yield* nothing();
      },
    },
  ],
};

export const snapcasterMage: CardScript = {
  oracleId: 'snapcaster_mage',
  abilities: [
    {
      kind: 'triggered',
      label: 'Give an instant or sorcery in your graveyard flashback',
      trigger: (ev, self) => ev.t === 'entersBattlefield' && ev.iid === self.iid,
      targets: [
        {
          prompt: 'Target instant or sorcery card in your graveyard gains flashback',
          optional: true,
          candidates: (state, controller): TargetRef[] =>
            state.zones[controller].graveyard
              .map((iid) => state.cards[iid])
              .filter((c) => {
                const t = c ? currentFace(c).types : [];
                return t.includes('Instant') || t.includes('Sorcery');
              })
              .map((c): TargetRef => ({ kind: 'card', iid: c.iid, zone: 'graveyard' })),
        },
      ],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (!t || t.kind !== 'card') return;
        ctx.addEffect({
          kind: 'castFromElsewhere',
          controller: ctx.controller,
          iids: [t.iid],
          zone: 'graveyard',
          mode: 'flashback',
          expires: 'endOfTurn',
        });
        const c = ctx.card(t.iid);
        ctx.log(`${c ? currentFace(c).name : 'a card'} gains flashback until end of turn`);
        yield* nothing();
      },
    },
  ],
};

/**
 * Lier: a static that turns off the whole counterspell half of the cube, plus
 * blanket flashback. Both are continuous, so they are re-derived every time
 * legal actions are enumerated rather than granted once.
 */
export const lier: CardScript = {
  oracleId: 'lier_disciple_of_the_drowned',
  staticRules: {
    spellsCantBeCountered: true,
    graveyardFlashbackFor: (state, card) => {
      const out: number[] = [];
      for (const iid of state.zones[card.controller].graveyard) {
        const c = state.cards[iid];
        if (!c) continue;
        const t = currentFace(c).types;
        if (t.includes('Instant') || t.includes('Sorcery')) out.push(iid);
      }
      return out;
    },
  },
};

export const glarb: CardScript = {
  oracleId: 'glarb_calamitys_augur',
  staticRules: {
    /** Lands and 4+ drops are castable straight off the top of your library. */
    playFromLibraryTop: (state, card) => {
      const top = state.zones[card.controller].library[0];
      if (top === undefined) return [];
      const c = state.cards[top];
      if (!c) return [];
      const face = currentFace(c);
      return face.types.includes('Land') || face.mv >= 4 ? [top] : [];
    },
  },
  abilities: [
    {
      kind: 'activated',
      text: '{T}: Surveil 2.',
      cost: { tap: true },
      *resolve(ctx) {
        yield* ctx.surveil(ctx.controller, 2);
      },
    },
  ],
};

export const uro: CardScript = {
  oracleId: 'uro_titan_of_natures_wrath',
  escape: { cost: '{G}{G}{U}{U}', exile: 5 },
  abilities: [
    {
      kind: 'triggered',
      label: 'Gain 3 life, draw a card, then you may put a land onto the battlefield',
      trigger: (ev, self) =>
        (ev.t === 'entersBattlefield' && ev.iid === self.iid) ||
        (ev.t === 'attacks' && ev.iid === self.iid),
      *resolve(ctx) {
        ctx.gainLife(ctx.controller, 3);
        ctx.draw(ctx.controller, 1);
        yield* playALandFromHand(ctx, 'You may put a land from your hand onto the battlefield');
      },
    },
    {
      kind: 'triggered',
      label: 'Sacrifice Uro unless it escaped',
      trigger: (ev, self) => ev.t === 'entersBattlefield' && ev.iid === self.iid,
      *resolve(ctx) {
        // The escape flag rides on the instance from the cast that made it.
        if (ctx.self.escaped) return;
        ctx.log('is sacrificed — it did not escape');
        yield* ctx.sacrifice(ctx.self.iid);
      },
    },
  ],
};

export const thundertrapTrainer: CardScript = {
  oracleId: 'thundertrap_trainer',
  kicker: { cost: '{4}', label: 'offspring' },
  abilities: [
    {
      kind: 'triggered',
      label: 'Look at the top four cards; you may reveal a noncreature, nonland card',
      trigger: (ev, self) => ev.t === 'entersBattlefield' && ev.iid === self.iid,
      *resolve(ctx) {
        yield* lookAtFourTakeOne(ctx);
        if (ctx.self.kicked) {
          ctx.createToken(ctx.controller, {
            name: 'Thundertrap Trainer',
            types: ['Creature'],
            subtypes: ['Otter', 'Wizard'],
            colors: ['U'],
            power: 1,
            toughness: 1,
          });
          ctx.log('offspring — creates a 1/1 copy');
        }
      },
    },
  ],
};

/** Shared by Narset's minus and Thundertrap Trainer's arrival. */
export function* lookAtFourTakeOne(ctx: Ctx): Eff {
  const top = ctx.library(ctx.controller).slice(0, 4).map((c) => c.iid);
  if (top.length === 0) return;
  const eligible = top.filter((iid) => {
    const c = ctx.card(iid);
    if (!c) return false;
    const t = currentFace(c).types;
    return !t.includes('Creature') && !t.includes('Land');
  });
  if (eligible.length > 0) {
    const picked = yield* ctx.chooseCards({
      player: ctx.controller,
      cards: top,
      min: 0,
      max: 1,
      prompt: 'You may reveal a noncreature, nonland card and put it into your hand',
      from: 'library',
      disabled: top
        .filter((i) => !eligible.includes(i))
        .map((iid) => ({ iid, reason: 'creature or land' })),
    });
    if (picked.length > 0) {
      const c = ctx.card(picked[0]);
      ctx.log(`reveals ${c ? currentFace(c).name : 'a card'} and takes it`);
      yield* ctx.moveTo(picked[0], 'hand');
      ctx.bottomInRandomOrder(top.filter((i) => i !== picked[0]));
      return;
    }
  }
  ctx.log('takes nothing');
  ctx.bottomInRandomOrder(top);
}

export const abhorrentOculus: CardScript = {
  oracleId: 'abhorrent_oculus',
  additionalCost: {
    label: 'exile six cards from your graveyard',
    canPay: (state, controller) => state.zones[controller].graveyard.length >= 6,
    *pay(ctx) {
      const gy = ctx.graveyard(ctx.controller).map((c) => c.iid);
      if (gy.length < 6) return false;
      const picked = yield* ctx.chooseCards({
        player: ctx.controller,
        cards: gy,
        min: 6,
        max: 6,
        prompt: 'Exile six cards from your graveyard',
        from: 'graveyard',
      });
      if (picked.length < 6) return false;
      for (const iid of picked) yield* ctx.moveTo(iid, 'exile');
      return true;
    },
  },
  abilities: [
    {
      kind: 'triggered',
      label: 'Manifest dread',
      trigger: (ev, self, state) =>
        ev.t === 'stepChange' &&
        ev.step === 'upkeep' &&
        state.activePlayer !== self.controller,
      *resolve(ctx) {
        yield* manifestDread(ctx);
      },
    },
  ],
};

/** Look at the top two: one onto the battlefield face down, one to the graveyard. */
export function* manifestDread(ctx: Ctx): Eff {
  const top = ctx.library(ctx.controller).slice(0, 2).map((c) => c.iid);
  if (top.length === 0) return;
  if (top.length === 1) {
    yield* ctx.manifest(ctx.controller, top[0]);
    return;
  }
  const picked = yield* ctx.chooseCards({
    player: ctx.controller,
    cards: top,
    min: 1,
    max: 1,
    prompt: 'Manifest dread — one face down, the other to your graveyard',
    from: 'library',
  });
  const chosen = picked[0] ?? top[0];
  yield* ctx.manifest(ctx.controller, chosen);
  for (const iid of top.filter((i) => i !== chosen)) yield* ctx.moveTo(iid, 'graveyard');
}

function* nothing(): Eff {
  // A resolve() that asks nothing is still a generator.
}

void isType;
void manaValueOfCard;
void ((c: CardInstance) => c);

export const CUBE_CREATURES: CardScript[] = [
  chromeMox,
  deathriteShaman,
  dragonsRageChanneler,
  psychicFrog,
  snapcasterMage,
  lier,
  glarb,
  uro,
  thundertrapTrainer,
  abhorrentOculus,
];
