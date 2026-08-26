import { frontFace } from '../oracle.js';
import type { CardScript } from '../script-types.js';
import type { IID } from '../types.js';

/**
 * Card selection. The important detail in this file is that Brainstorm and Ponder
 * perform real draws, while Dig Through Time, Rakshasa's Bargain and Planar
 * Genesis "put cards into your hand" and are not draws at all. That distinction is
 * the entire Orcish Bowmasters matchup.
 */

export const brainstorm: CardScript = {
  oracleId: 'brainstorm',
  *resolve(ctx) {
    // Three separate draw events. Writing this as a single drawN(3) would silently
    // reduce an opposing Orcish Bowmasters from three triggers to one.
    ctx.draw(ctx.controller, 1);
    ctx.draw(ctx.controller, 1);
    ctx.draw(ctx.controller, 1);

    const hand = ctx.hand(ctx.controller).map((c) => c.iid);
    if (hand.length === 0) return;
    const chosen = yield* ctx.chooseCards({
      player: ctx.controller,
      cards: hand,
      min: Math.min(2, hand.length),
      max: Math.min(2, hand.length),
      ordered: true,
      prompt: 'Put two cards on top of your library (first one ends up on top)',
      from: 'hand',
    });
    yield* putOnTopInOrder(ctx, chosen);
  },
};

/** chosen[0] must end up on top, so they are pushed in reverse. */
function* putOnTopInOrder(
  ctx: Parameters<NonNullable<CardScript['resolve']>>[0],
  chosen: IID[],
) {
  for (let i = chosen.length - 1; i >= 0; i--) {
    yield* ctx.moveTo(chosen[i], 'library', { position: 'top' });
  }
}

/**
 * Ponder — look at three, put them back in any order, then "you may shuffle",
 * then draw. The order is asked first because arranging them is how the player
 * gets to see what is there before deciding whether to shuffle it away.
 */
export const ponder: CardScript = {
  oracleId: 'ponder',
  *resolve(ctx) {
    const top = ctx.library(ctx.controller).slice(0, 3).map((c) => c.iid);
    // One card has only one order, so there is nothing to ask.
    if (top.length > 1) {
      const ordered = yield* ctx.chooseCards({
        player: ctx.controller,
        cards: top,
        min: top.length,
        max: top.length,
        ordered: true,
        prompt: 'Put these back on top of your library (first one ends up on top)',
        from: 'library',
      });
      yield* putOnTopInOrder(ctx, ordered);
    }

    if (yield* ctx.yesNo(ctx.controller, 'Shuffle your library?')) {
      ctx.shuffleLibrary(ctx.controller);
    }

    // A real draw, so an opposing Orcish Bowmasters does trigger.
    ctx.draw(ctx.controller, 1);
  },
};

export const borneUponAWind: CardScript = {
  oracleId: 'borne_upon_a_wind',
  *resolve(ctx) {
    ctx.addEffect({
      kind: 'castAsThoughFlash',
      controller: ctx.controller,
      expires: 'endOfTurn',
    });
    ctx.log('You may cast spells this turn as though they had flash');
    // This is a real draw, so it does trigger an opposing Orcish Bowmasters.
    ctx.draw(ctx.controller, 1);
  },
};

export const digThroughTime: CardScript = {
  oracleId: 'dig_through_time',
  hasDelve: true,
  *resolve(ctx) {
    const top = ctx.library(ctx.controller).slice(0, 7).map((c) => c.iid);
    if (top.length === 0) return;
    const take = Math.min(2, top.length);
    const chosen = yield* ctx.chooseCards({
      player: ctx.controller,
      cards: top,
      min: take,
      max: take,
      prompt: 'Put two of these into your hand',
      from: 'library',
    });
    for (const iid of chosen) yield* ctx.moveTo(iid, 'hand');

    const rest = top.filter((iid) => !chosen.includes(iid));
    if (rest.length === 0) return;
    if (rest.length === 1) {
      yield* ctx.moveTo(rest[0], 'library', { position: 'bottom' });
      return;
    }
    const ordered = yield* ctx.chooseCards({
      player: ctx.controller,
      cards: rest,
      min: rest.length,
      max: rest.length,
      ordered: true,
      prompt: 'Order the rest on the bottom of your library (first goes on first)',
      from: 'library',
    });
    for (const iid of ordered) yield* ctx.moveTo(iid, 'library', { position: 'bottom' });
  },
};

export const rakshasasBargain: CardScript = {
  oracleId: 'rakshasas_bargain',
  *resolve(ctx) {
    const top = ctx.library(ctx.controller).slice(0, 4).map((c) => c.iid);
    if (top.length === 0) return;
    const take = Math.min(2, top.length);
    const chosen = yield* ctx.chooseCards({
      player: ctx.controller,
      cards: top,
      min: take,
      max: take,
      prompt: 'Put two of these into your hand (the rest go to your graveyard)',
      from: 'library',
    });
    for (const iid of chosen) yield* ctx.moveTo(iid, 'hand');
    // The rest fuel Delve — this is the deck's main graveyard engine.
    for (const iid of top.filter((i) => !chosen.includes(i))) {
      yield* ctx.moveTo(iid, 'graveyard');
    }
  },
};

export const planarGenesis: CardScript = {
  oracleId: 'planar_genesis',
  *resolve(ctx) {
    const top = ctx.library(ctx.controller).slice(0, 4).map((c) => c.iid);
    if (top.length === 0) return;

    const isLand = (iid: IID) => frontFace(ctx.card(iid)!.oracleId).types.includes('Land');
    const lands = top.filter(isLand);

    let used: IID | null = null;
    if (lands.length > 0) {
      const pick = yield* ctx.chooseCards({
        player: ctx.controller,
        cards: top,
        min: 0,
        max: 1,
        // Putting a land onto the battlefield this way does NOT use your land drop.
        prompt: 'You may put a land onto the battlefield tapped (this does not use your land drop)',
        from: 'library',
        disabled: top.filter((i) => !isLand(i)).map((iid) => ({ iid, reason: 'Not a land' })),
      });
      if (pick.length > 0) {
        used = pick[0];
        yield* ctx.moveToBattlefield(used, { tapped: true });
      }
    }

    if (used === null) {
      // "If you don't, put a card from among them into your hand." — mandatory.
      const pick = yield* ctx.chooseCards({
        player: ctx.controller,
        cards: top,
        min: 1,
        max: 1,
        prompt: 'Put a card into your hand',
        from: 'library',
      });
      if (pick.length > 0) yield* ctx.moveTo(pick[0], 'hand');
      used = pick[0] ?? null;
    }

    ctx.bottomInRandomOrder(top.filter((i) => i !== used));
  },
};
