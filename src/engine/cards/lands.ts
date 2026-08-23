import { frontFace } from '../oracle.js';
import { battlefield, cardsIn, countLandSubtype, hasCardSubtype, isType } from '../state.js';
import type { CardScript } from '../script-types.js';
import type { GameState, PlayerId, TargetRef } from '../types.js';

/**
 * The manabase. Mana production itself comes straight from Scryfall's produced_mana,
 * so these scripts only implement what is special: enter-tapped replacements,
 * fetch activations, surveil triggers and Mistrise Village's shield.
 */

/** Shocklands: "As this land enters, you may pay 2 life. If you don't, it enters tapped." */
function shockland(oracleId: string): CardScript {
  return {
    oracleId,
    *asEnters(ctx) {
      // A replacement effect — there is no window to respond to this.
      const canAfford = ctx.state.players[ctx.controller].life > 0;
      const pay = canAfford
        ? yield* ctx.yesNo(
            ctx.controller,
            `Pay 2 life so ${frontFace(oracleId).name} enters untapped?`,
            { yes: 'Pay 2 life', no: 'Enter tapped' },
          )
        : false;
      if (pay) ctx.loseLife(ctx.controller, 2);
      else ctx.enterTapped();
    },
  };
}

/** Fetchlands. Both of these can find every land in the deck except Mistrise Village. */
function fetchland(oracleId: string, subtypes: string[]): CardScript {
  return {
    oracleId,
    abilities: [
      {
        kind: 'activated',
        text: `{T}, Pay 1 life, Sacrifice: search for a ${subtypes.join(' or ')}`,
        cost: { tap: true, life: 1, sacrificeSelf: true },
        *resolve(ctx) {
          const found = yield* ctx.searchZone({
            player: ctx.controller,
            cards: ctx.library(ctx.controller).map((c) => c.iid),
            filter: (c) => {
              const f = frontFace(c.oracleId);
              return f.types.includes('Land') && subtypes.some((s) => f.subtypes.includes(s));
            },
            prompt: `Search your library for a ${subtypes.join(' or ')} card`,
            // Searching may always fail to find (CR 701.19c).
            optional: true,
          });
          if (found !== null) {
            yield* ctx.moveToBattlefield(found);
          }
          ctx.shuffleLibrary(ctx.controller);
        },
      },
    ],
  };
}

/** Surveil lands: enter tapped, then surveil 1. Fuels Delve and Mystic Sanctuary. */
function surveilLand(oracleId: string): CardScript {
  return {
    oracleId,
    *asEnters(ctx) {
      ctx.enterTapped();
      },
    abilities: [
      {
        kind: 'triggered',
        label: 'Surveil 1',
        trigger: (ev, self) => ev.t === 'entersBattlefield' && ev.iid === self.iid,
        *resolve(ctx) {
          yield* ctx.surveil(ctx.controller, 1);
        },
      },
    ],
  };
}

export const breedingPool = shockland('breeding_pool');
export const wateryGrave = shockland('watery_grave');
export const hallowedFountain = shockland('hallowed_fountain');

export const floodedStrand = fetchland('flooded_strand', ['Plains', 'Island']);
export const pollutedDelta = fetchland('polluted_delta', ['Island', 'Swamp']);

export const hedgeMaze = surveilLand('hedge_maze');
export const undercitySewers = surveilLand('undercity_sewers');

/**
 * The rest of the blue duals, which the draft hands every player: each colour
 * paired with blue, two shocklands and two surveil lands. They behave exactly
 * like the ones the mirror already runs, so they are the same two factories.
 */
export const steamVents = shockland('steam_vents');
export const meticulousArchive = surveilLand('meticulous_archive');
export const thunderingFalls = surveilLand('thundering_falls');

/**
 * Mystic Sanctuary — "enters tapped unless you control three or more other Islands".
 *
 * Island is a land TYPE, so Breeding Pool, Watery Grave, Hedge Maze, Hallowed
 * Fountain and Undercity Sewers all count. Counting by card name here would be a
 * silent, near-invisible bug.
 */
export const mysticSanctuary: CardScript = {
  oracleId: 'mystic_sanctuary',
  *asEnters(ctx) {
    // Per ruling, this checks lands ALREADY on the battlefield — cards entering at
    // the same time (Show and Tell) are not seen.
    const islands = countLandSubtype(ctx.state, ctx.controller, 'Island', ctx.self.iid);
    if (islands < 3) ctx.enterTapped();
  },
  abilities: [
    {
      kind: 'triggered',
      label: 'Put an instant or sorcery from your graveyard on top of your library',
      // Intervening "if" clause: only triggers when it entered UNTAPPED.
      trigger: (ev, self) =>
        ev.t === 'entersBattlefield' && ev.iid === self.iid && !self.tapped,
      targets: [
        {
          prompt: 'Target instant or sorcery card in your graveyard',
          candidates: (state, controller): TargetRef[] =>
            cardsIn(state, controller, 'graveyard')
              .filter((c) => isType(c, 'Instant') || isType(c, 'Sorcery'))
              .map((c) => ({ kind: 'card', iid: c.iid, zone: 'graveyard' })),
        },
      ],
      *resolve(ctx) {
        const t = ctx.targets[0];
        if (!t || t.kind !== 'card') return;
        const card = ctx.card(t.iid);
        if (!card || card.zone !== 'graveyard') return;
        // "you may" — offer the choice rather than forcing it.
        const doIt = yield* ctx.yesNo(
          ctx.controller,
          `Put ${frontFace(card.oracleId).name} on top of your library?`,
        );
        if (doIt) yield* ctx.moveTo(t.iid, 'library', { position: 'top' });
      },
    },
  ],
};

/**
 * Mistrise Village — enters untapped only if you control a Mountain or a Forest.
 * In this deck Breeding Pool and Hedge Maze are Forests, so that is live.
 */
export const mistriseVillage: CardScript = {
  oracleId: 'mistrise_village',
  *asEnters(ctx) {
    const has = battlefield(ctx.state, ctx.controller).some(
      (c) =>
        c.iid !== ctx.self.iid &&
        isType(c, 'Land') &&
        (hasCardSubtype(c, 'Mountain') || hasCardSubtype(c, 'Forest')),
    );
    if (!has) ctx.enterTapped();
  },
  abilities: [
    {
      kind: 'activated',
      text: "{U}, {T}: the next spell you cast this turn can't be countered",
      cost: { tap: true, mana: '{U}' },
      *resolve(ctx) {
        // Attaches to whichever spell is cast next and is spent at that moment,
        // not at end of turn.
        ctx.addEffect({
          kind: 'cantBeCountered',
          controller: ctx.controller,
          scope: 'nextSpell',
          consumed: false,
          expires: 'endOfTurn',
        });
        ctx.log("The next spell you cast this turn can't be countered");
          },
    },
  ],
};

/** Helper used by the client and by tests to explain the manabase. */
export function fetchableBy(state: GameState, player: PlayerId, subtypes: string[]): number {
  return cardsIn(state, player, 'library').filter((c) => {
    const f = frontFace(c.oracleId);
    return f.types.includes('Land') && subtypes.some((s) => f.subtypes.includes(s));
  }).length;
}
