import { currentFace, isType } from '../state.js';
import type { CardScript, Eff } from '../script-types.js';
import type { CardInstance, GameState, PlayerId, TargetRef } from '../types.js';
import { lookAtFourTakeOne, manifestDread } from './cube-creatures.js';

/** The cube's enchantments, auras, planeswalkers and the one tricky land. */

function allPermanents(
  state: GameState,
  filter: (c: CardInstance) => boolean = () => true,
): TargetRef[] {
  return [...state.zones.p1.battlefield, ...state.zones.p2.battlefield]
    .map((iid) => state.cards[iid])
    .filter((c): c is CardInstance => Boolean(c) && filter(c))
    .map((c): TargetRef => ({ kind: 'permanent', iid: c.iid }));
}

const players = (): TargetRef[] => [
  { kind: 'player', id: 'p1' },
  { kind: 'player', id: 'p2' },
];

function* nothing(): Eff {
  // A resolve() that asks nothing is still a generator.
}

// ---------------------------------------------------------------------------
// Auras
// ---------------------------------------------------------------------------

/**
 * Utopia Sprawl. The extra mana is a triggered mana ability, which never uses
 * the stack — the engine folds it into tapForMana, reading the colour this
 * chose as it entered.
 */
export const utopiaSprawl: CardScript = {
  oracleId: 'utopia_sprawl',
  enchantedTapBonus: true,
  enchant: {
    prompt: 'Enchant Forest',
    candidates: (state, controller) =>
      allPermanents(
        state,
        (c) =>
          c.controller === controller &&
          isType(c, 'Land') &&
          currentFace(c).subtypes.includes('Forest'),
      ),
  },
  *asEnters(ctx) {
    const colour = yield* ctx.chooseColour(ctx.controller, 'Choose a color for Utopia Sprawl');
    if (colour) {
      ctx.setNamedChoice(ctx.self.iid, colour);
      ctx.log(`chooses {${colour}}`);
    }
  },
};

/**
 * Animate Dead. The aura reanimates on arrival and then enchants what it made,
 * so its own state-based check keeps the creature honest: kill the aura and the
 * creature is sacrificed, which is the whole reason it is an aura at all.
 */
export const animateDead: CardScript = {
  oracleId: 'animate_dead',
  staticPt: { enchanted: { power: -1, toughness: 0 } },
  enchant: {
    prompt: 'Enchant creature',
    candidates: (state) => allPermanents(state, (c) => isType(c, 'Creature')),
  },
  abilities: [
    {
      kind: 'triggered',
      label: 'Return a creature card from a graveyard under your control',
      trigger: (ev, self) => ev.t === 'entersBattlefield' && ev.iid === self.iid,
      targets: [
        {
          prompt: 'Return target creature card from a graveyard',
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
        if (!t || t.kind !== 'card') {
          // Nothing to animate: the aura has nothing legal to enchant and dies.
          yield* ctx.sacrifice(ctx.self.iid);
          return;
        }
        yield* ctx.moveToBattlefield(t.iid, { controller: ctx.controller });
        ctx.attachTo(ctx.self.iid, t.iid);
      },
    },
    {
      kind: 'triggered',
      label: 'The enchanted creature is sacrificed',
      trigger: (ev, self) => ev.t === 'leavesBattlefield' && ev.iid === self.iid,
      *resolve(ctx) {
        // LKI: what it was attached to, read off the object as it left.
        const host = ctx.self.attachedTo;
        if (host === undefined) return;
        const c = ctx.card(host);
        if (c && c.zone === 'battlefield') yield* ctx.sacrifice(host);
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Enchantments
// ---------------------------------------------------------------------------

export const drownedSecrets: CardScript = {
  oracleId: 'drowned_secrets',
  abilities: [
    {
      kind: 'triggered',
      label: 'Target player mills two cards',
      trigger: (ev, self, state) => {
        if (ev.t !== 'spellCast' || ev.controller !== self.controller) return false;
        const spell = state.cards[ev.iid];
        return Boolean(spell) && currentFace(spell).colors.includes('U');
      },
      targets: [{ prompt: 'Target player mills two cards', candidates: players }],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (t && t.kind === 'player') yield* ctx.mill(t.id, 2);
      },
    },
  ],
};

export const upTheBeanstalk: CardScript = {
  oracleId: 'up_the_beanstalk',
  abilities: [
    {
      kind: 'triggered',
      label: 'Draw a card',
      trigger: (ev, self, state) => {
        if (ev.t === 'entersBattlefield' && ev.iid === self.iid) return true;
        if (ev.t !== 'spellCast' || ev.controller !== self.controller) return false;
        const spell = state.cards[ev.iid];
        return Boolean(spell) && currentFace(spell).mv >= 5;
      },
      *resolve(ctx) {
        ctx.draw(ctx.controller, 1);
        yield* nothing();
      },
    },
  ],
};

export const wildernessReclamation: CardScript = {
  oracleId: 'wilderness_reclamation',
  abilities: [
    {
      kind: 'triggered',
      label: 'Untap all lands you control',
      trigger: (ev, self) =>
        ev.t === 'stepChange' && ev.step === 'end_step' && ev.activePlayer === self.controller,
      *resolve(ctx) {
        let n = 0;
        for (const c of ctx.battlefieldOf(ctx.controller)) {
          if (!isType(c, 'Land') || !c.tapped) continue;
          ctx.untap(c.iid);
          n++;
        }
        ctx.log(`untaps ${n} land${n === 1 ? '' : 's'}`);
        yield* nothing();
      },
    },
  ],
};

export const mysticRemora: CardScript = {
  oracleId: 'mystic_remora',
  cumulativeUpkeep: '{1}',
  abilities: [
    {
      kind: 'triggered',
      label: 'Draw a card unless they pay {4}',
      trigger: (ev, self, state) => {
        if (ev.t !== 'spellCast' || ev.controller === self.controller) return false;
        const spell = state.cards[ev.iid];
        return Boolean(spell) && !currentFace(spell).types.includes('Creature');
      },
      *resolve(ctx) {
        const paid = yield* ctx.payOrDecline(
          ctx.opponent,
          '{4}',
          'Mystic Remora — pay {4}, or they draw a card?',
        );
        if (paid) {
          ctx.log('they pay {4}');
          return;
        }
        ctx.draw(ctx.controller, 1);
      },
    },
  ],
};

export const sneakAttack: CardScript = {
  oracleId: 'sneak_attack',
  abilities: [
    {
      kind: 'activated',
      text: '{R}: Put a creature from your hand onto the battlefield with haste.',
      cost: { mana: '{R}' },
      *resolve(ctx) {
        yield* sneakACreatureIn(ctx);
      },
    },
  ],
};

export const throughTheBreach: CardScript = {
  oracleId: 'through_the_breach',
  *resolve(ctx) {
    yield* sneakACreatureIn(ctx);
  },
};

/** Shared by Sneak Attack and Through the Breach: in now, gone at end of turn. */
function* sneakACreatureIn(ctx: Parameters<NonNullable<CardScript['resolve']>>[0]): Eff {
  const creatures = ctx
    .hand(ctx.controller)
    .filter((c) => currentFace(c).types.includes('Creature'));
  if (creatures.length === 0) {
    ctx.log('no creature in hand');
    return;
  }
  const picked = yield* ctx.chooseCards({
    player: ctx.controller,
    cards: creatures.map((c) => c.iid),
    min: 0,
    max: 1,
    prompt: 'You may put a creature from your hand onto the battlefield',
    from: 'hand',
  });
  if (picked.length === 0) return;
  yield* ctx.moveToBattlefield(picked[0], { controller: ctx.controller });
  ctx.addEffect({
    kind: 'grantKeyword',
    iids: [picked[0]],
    keyword: 'Haste',
    expires: 'endOfTurn',
  });
  // The bill: it leaves at the beginning of the next end step, whoever's it is.
  ctx.sacrificeAtNextEndStep(ctx.controller, picked[0]);
  const c = ctx.card(picked[0]);
  ctx.log(`sneaks ${c ? currentFace(c).name : 'a creature'} in with haste`);
}

/**
 * Ashiok's Erasure — the errata'd two-mana version. Exiling the spell is not
 * countering it, so it goes through Veil of Summer; and while the enchantment
 * is out the name itself is banned, which the engine enforces in legalActions.
 */
export const ashioksErasure: CardScript = {
  oracleId: 'ashioks_erasure',
  abilities: [
    {
      kind: 'triggered',
      label: 'Exile target spell',
      trigger: (ev, self) => ev.t === 'entersBattlefield' && ev.iid === self.iid,
      targets: [
        {
          prompt: 'Exile target spell',
          candidates: (state, controller): TargetRef[] =>
            state.stack
              .map((iid) => state.cards[iid])
              .filter((c) => c && !c.isAbility && c.controller !== controller)
              .map((c): TargetRef => ({ kind: 'spell', iid: c.iid })),
        },
      ],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (!t || t.kind !== 'spell') return;
        const spell = ctx.card(t.iid);
        if (!spell || spell.zone !== 'stack') return;
        const name = currentFace(spell).name;
        ctx.log(`exiles ${name} — opponents cannot cast that name`);
        yield* ctx.moveTo(t.iid, 'exile');
        ctx.addEffect({
          kind: 'cantCastName',
          players: [ctx.opponent],
          name,
          sourceIid: ctx.self.iid,
          expires: 'permanent',
        });
        ctx.setNamedChoice(ctx.self.iid, String(t.iid));
      },
    },
    {
      kind: 'triggered',
      label: 'Return the exiled card to its owner’s hand',
      trigger: (ev, self) => ev.t === 'leavesBattlefield' && ev.iid === self.iid,
      *resolve(ctx) {
        const exiled = ctx.self.namedChoice ? Number(ctx.self.namedChoice) : NaN;
        if (!Number.isFinite(exiled)) return;
        const card = ctx.card(exiled);
        if (card && card.zone === 'exile') {
          ctx.log(`returns ${currentFace(card).name} to its owner's hand`);
          yield* ctx.moveTo(exiled, 'hand');
        }
      },
    },
  ],
};

/**
 * Glacierwood Siege — one of two enchantments wearing one card. The mode is
 * chosen as it enters and never changes, so it is a named choice rather than a
 * mode on the stack.
 */
export const glacierwoodSiege: CardScript = {
  oracleId: 'glacierwood_siege',
  *asEnters(ctx) {
    const pick = yield* ctx.chooseName(
      ctx.controller,
      ['Temur', 'Sultai'],
      'As Glacierwood Siege enters, choose Temur or Sultai',
    );
    ctx.setNamedChoice(ctx.self.iid, pick ?? 'Temur');
    ctx.log(`chooses ${pick ?? 'Temur'}`);
  },
  staticRules: {
    // Sultai: lands are playable from your graveyard.
    playFromGraveyard: (state, card) =>
      card.namedChoice === 'Sultai'
        ? state.zones[card.controller].graveyard.filter((iid) => {
            const c = state.cards[iid];
            return Boolean(c) && currentFace(c).types.includes('Land');
          })
        : [],
  },
  abilities: [
    {
      kind: 'triggered',
      label: 'Target player mills four cards',
      trigger: (ev, self, state) => {
        if (self.namedChoice !== 'Temur') return false;
        if (ev.t !== 'spellCast' || ev.controller !== self.controller) return false;
        const spell = state.cards[ev.iid];
        if (!spell) return false;
        const t = currentFace(spell).types;
        return t.includes('Instant') || t.includes('Sorcery');
      },
      targets: [{ prompt: 'Target player mills four cards', candidates: players }],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (t && t.kind === 'player') yield* ctx.mill(t.id, 4);
      },
    },
  ],
};

/**
 * Founding the Third Path — a saga. The chapters arrive as events from the
 * engine's own saga clock; this script is only what each one does.
 */
export const foundingTheThirdPath: CardScript = {
  oracleId: 'founding_the_third_path',
  saga: { chapters: 3 },
  abilities: [
    {
      kind: 'triggered',
      label: 'Chapter',
      trigger: (ev, self) =>
        ev.t === 'sagaChapter' && ev.iid === self.iid ? { chapter: ev.chapter } : false,
      *resolve(ctx) {
        const chapter = Number(ctx.context.chapter ?? 0);
        if (chapter === 1) {
          // I — cast a cheap instant or sorcery from hand for free.
          const legal = ctx.hand(ctx.controller).filter((c) => {
            const f = currentFace(c);
            const t = f.types;
            return (t.includes('Instant') || t.includes('Sorcery')) && f.mv >= 1 && f.mv <= 2;
          });
          if (legal.length === 0) {
            ctx.log('nothing cheap enough to cast');
            return;
          }
          ctx.addEffect({
            kind: 'castFromElsewhere',
            controller: ctx.controller,
            iids: legal.map((c) => c.iid),
            zone: 'hand',
            mode: 'free',
            expires: 'endOfTurn',
          });
          ctx.log('you may cast a 1- or 2-mana instant or sorcery for free this turn');
          return;
        }
        if (chapter === 2) {
          yield* ctx.mill(ctx.opponent, 4);
          return;
        }
        // III — exile an instant or sorcery from your graveyard and copy it.
        const gy = ctx.graveyard(ctx.controller).filter((c) => {
          const t = currentFace(c).types;
          return t.includes('Instant') || t.includes('Sorcery');
        });
        if (gy.length === 0) return;
        const picked = yield* ctx.chooseCards({
          player: ctx.controller,
          cards: gy.map((c) => c.iid),
          min: 1,
          max: 1,
          prompt: 'Exile an instant or sorcery from your graveyard and copy it',
          from: 'graveyard',
        });
        if (picked.length === 0) return;
        yield* ctx.moveTo(picked[0], 'exile');
        ctx.addEffect({
          kind: 'castFromElsewhere',
          controller: ctx.controller,
          iids: [picked[0]],
          zone: 'exile',
          mode: 'free',
          expires: 'endOfTurn',
        });
        const c = ctx.card(picked[0]);
        ctx.log(`may cast a copy of ${c ? currentFace(c).name : 'it'}`);
      },
    },
  ],
};

/**
 * Cavern of Souls. The restriction is the card: mana that only casts one
 * creature type, and makes it uncounterable. Producing it is a mana ability, so
 * the mana is marked rather than tracked separately — see `restrictedTo`.
 */
export const cavernOfSouls: CardScript = {
  oracleId: 'cavern_of_souls',
  *asEnters(ctx) {
    const types = ['Human', 'Wizard', 'Elf', 'Shaman', 'Frog', 'Otter', 'Bird', 'Angel', 'Giant'];
    const pick = yield* ctx.chooseName(ctx.controller, types, 'As Cavern of Souls enters, choose a creature type');
    ctx.setNamedChoice(ctx.self.iid, pick ?? types[0]);
    ctx.log(`names ${pick ?? types[0]}`);
  },
  abilities: [
    {
      kind: 'activated',
      text: '{T}: Add {C}.',
      cost: { tap: true },
      isManaAbility: true,
      *resolve(ctx) {
        ctx.addManaToPool(ctx.controller, 'C', 1);
        yield* nothing();
      },
    },
    {
      kind: 'activated',
      text: '{T}: Add one mana of any color for a creature of the chosen type.',
      cost: { tap: true },
      isManaAbility: true,
      *resolve(ctx) {
        const colour = yield* ctx.chooseColour(ctx.controller, 'Add one mana of any color');
        if (colour) ctx.addManaToPool(ctx.controller, colour, 1);
      },
    },
  ],
};

export const CUBE_PERMANENTS: CardScript[] = [
  utopiaSprawl,
  animateDead,
  drownedSecrets,
  upTheBeanstalk,
  wildernessReclamation,
  mysticRemora,
  sneakAttack,
  throughTheBreach,
  ashioksErasure,
  glacierwoodSiege,
  foundingTheThirdPath,
  cavernOfSouls,
];

void lookAtFourTakeOne;
void manifestDread;
