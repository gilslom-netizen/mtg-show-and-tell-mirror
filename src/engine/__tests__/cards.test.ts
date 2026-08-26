import { describe, expect, it } from 'vitest';
import { testGame } from './harness.js';

/** DESIGN.md 15.7 (Atraxa) and 15.8 (selection, tutors and the manabase). */

describe('Atraxa, Grand Unifier', () => {
  it('71. reveals the top ten and offers one pick per card type present', () => {
    const t = testGame();
    t.p1.hand('Atraxa, Grand Unifier');
    t.p1.manaBase(7);
    t.p1.libraryTop(
      'Brainstorm', // Instant
      'Show and Tell', // Sorcery
      'Omniscience', // Enchantment
      'Polluted Delta', // Land
      'Orcish Bowmasters', // Creature
    );
    t.begin();

    t.p1.cast('Atraxa, Grand Unifier');
    t.resolveAll(400);

    // Only five of the eight card types exist in this deck at all.
    expect(t.p1.handSize()).toBeLessThanOrEqual(5);
    expect(t.countTriggers('Atraxa, Grand Unifier')).toBe(1);
  });

  it('lets you skip a card type and come back to it after seeing the rest', () => {
    // Whether you want the instant depends on what the creature slot holds, so
    // the questions run in two passes: skip one and it is asked again at the end.
    const t = testGame();
    t.p1.hand('Atraxa, Grand Unifier');
    t.p1.manaBase(7);
    t.p1.libraryTop('Brainstorm', 'Orcish Bowmasters');
    t.p1.librarySize(2);
    t.begin();
    t.p1.cast('Atraxa, Grand Unifier');
    t.resolveStack();

    // The types are asked alphabetically, so creature comes before instant.
    const first = t.expectChoice();
    expect(first.kind).toBe('chooseCards');
    if (first.kind !== 'chooseCards') throw new Error('expected a card choice');
    expect(first.prompt).toMatch(/creature/i);
    // Something else is still open, so this one can be postponed.
    expect(first.deferrable).toBeTruthy();
    t.answer({ kind: 'cards', iids: [], deferred: true });

    // The instant question comes next, and it is the last of the first pass —
    // nothing left to come back from, so it is not offered as postponable.
    const second = t.expectChoice();
    if (second.kind !== 'chooseCards') throw new Error('expected a card choice');
    expect(second.prompt).toMatch(/instant/i);
    expect(second.deferrable).toBeFalsy();
    t.chooseCards('Brainstorm');

    // And now the creature comes back around.
    const third = t.expectChoice();
    if (third.kind !== 'chooseCards') throw new Error('expected a card choice');
    expect(third.prompt).toMatch(/creature/i);
    expect(third.deferrable).toBeFalsy();
    t.chooseCards('Orcish Bowmasters');

    t.resolveAll(200);
    expect(t.p1.handNames().sort()).toEqual(['Brainstorm', 'Orcish Bowmasters']);
    t.assertCardConservation();
  });

  it('asks a postponed type only once more, so it always terminates', () => {
    const t = testGame();
    t.p1.hand('Atraxa, Grand Unifier');
    t.p1.manaBase(7);
    t.p1.libraryTop('Brainstorm', 'Orcish Bowmasters');
    t.p1.librarySize(2);
    t.begin();
    t.p1.cast('Atraxa, Grand Unifier');
    t.resolveStack();

    // Postpone everything that can be postponed; the second pass is final.
    let deferrals = 0;
    for (let i = 0; i < 20; i++) {
      const c = t.choice();
      if (!c) break;
      if (c.kind === 'chooseCards' && c.deferrable) {
        deferrals++;
        t.answer({ kind: 'cards', iids: [], deferred: true });
      } else {
        t.auto();
      }
    }
    expect(deferrals).toBe(1);
    expect(t.choice()).toBeNull();
    t.assertCardConservation();
  });

  it('72. a modal DFC among the revealed cards counts as an instant, never a land', () => {
    const t = testGame();
    t.p1.hand('Atraxa, Grand Unifier');
    t.p1.manaBase(7);
    t.p1.libraryTop('Waterlogged Teachings');
    t.p1.librarySize(1);
    t.begin();

    t.p1.cast('Atraxa, Grand Unifier');
    t.resolveStack();

    // The very first prompt is the instant slot, and this is the only card.
    const c = t.expectChoice();
    expect(c.kind).toBe('chooseCards');
    if (c.kind === 'chooseCards') {
      expect(c.prompt).toMatch(/instant/i);
      expect(c.options).toHaveLength(1);
    }
    t.chooseCards('Waterlogged Teachings');
    // No land prompt follows — there is no land among the revealed cards.
    expect(t.choice()).toBeNull();
    expect(t.p1.handNames()).toContain('Waterlogged Teachings');
  });

  it('74. every pick is optional', () => {
    const t = testGame();
    t.p1.hand('Atraxa, Grand Unifier');
    t.p1.manaBase(7);
    t.begin();

    t.p1.cast('Atraxa, Grand Unifier');
    t.resolveStack();
    t.auto();
    // auto() answers the minimum, which is zero for each type.
    expect(t.p1.handSize()).toBe(0);
  });

  it('75/76. a short library reveals what it has; an empty one does nothing', () => {
    const short = testGame();
    short.p1.hand('Atraxa, Grand Unifier');
    short.p1.manaBase(7);
    short.p1.librarySize(6);
    short.begin();
    short.p1.cast('Atraxa, Grand Unifier');
    short.resolveStack();
    const c = short.expectChoice();
    if (c.kind === 'chooseCards') expect(c.options.length).toBeLessThanOrEqual(6);

    const empty = testGame();
    empty.p1.hand('Atraxa, Grand Unifier');
    empty.p1.manaBase(7);
    empty.p1.librarySize(0);
    empty.begin();
    empty.p1.cast('Atraxa, Grand Unifier');
    empty.resolveAll();
    expect(empty.choice()).toBeNull();
    expect(empty.p1.battlefieldNames()).toContain('Atraxa, Grand Unifier');
  });

  it('77. the cards put on the bottom are randomised deterministically from the seed', () => {
    const run = (seed: number) => {
      const t = testGame({ seed });
      t.p1.hand('Atraxa, Grand Unifier');
      t.p1.manaBase(7);
      t.begin();
      t.p1.cast('Atraxa, Grand Unifier');
      t.resolveAll(400);
      return t.p1.libraryNames().slice(-10).join(',');
    };
    expect(run(7)).toBe(run(7));
    expect(run(7)).not.toBe(run(8));
  });

  it('79. two Atraxas under the SAME controller trigger the legend rule', () => {
    const t = testGame();
    t.p1.battlefield('Atraxa, Grand Unifier');
    t.p1.hand('Show and Tell', 'Atraxa, Grand Unifier');
    t.p1.manaBase(3);
    t.p2.hand('Island');
    t.begin();

    t.p1.cast('Show and Tell');
    t.resolveStack();
    t.secret('p1', 'Atraxa, Grand Unifier');
    t.secret('p2', 'Island');
    t.auto(200);

    const atraxas = t.p1.battlefieldNames().filter((n) => n === 'Atraxa, Grand Unifier');
    expect(atraxas).toHaveLength(1);
    expect(t.p1.graveyardNames()).toContain('Atraxa, Grand Unifier');
  });

  it('80/81. Atraxa blocking Atraxa kills both, and lifelink pays out first', () => {
    const t = testGame();
    const [attacker] = t.p1.battlefield('Atraxa, Grand Unifier');
    t.p2.battlefield('Atraxa, Grand Unifier');
    t.begin('combat', 'declare_attackers');

    const c = t.expectChoice();
    expect(c.kind).toBe('declareAttackers');
    t.answer({ kind: 'attackers', iids: [attacker] });

    // Vigilance means the attacker is not tapped.
    expect(t.state.cards[attacker].tapped).toBe(false);

    // Both players still get priority in the declare attackers step.
    t.passToChoice();
    const blockChoice = t.expectChoice();
    expect(blockChoice.kind).toBe('declareBlockers');
    const blocker = t.p2.find('Atraxa, Grand Unifier', 'battlefield');
    t.answer({ kind: 'blockers', blocks: [{ blocker, attacker }] });

    t.passUntilCondition(() => t.state.step === 'end_of_combat');

    // Deathtouch on both sides.
    expect(t.p1.graveyardNames()).toContain('Atraxa, Grand Unifier');
    expect(t.p2.graveyardNames()).toContain('Atraxa, Grand Unifier');
    // Both had lifelink, so both gained 7.
    expect(t.p1.lifeTotal).toBe(27);
    expect(t.p2.lifeTotal).toBe(27);
  });
});

describe('Selection and tutors', () => {
  it('83. a fetchland after Brainstorm shuffles the two bad cards away', () => {
    const t = testGame();
    t.p1.hand('Brainstorm');
    t.p1.battlefield('Island', 'Flooded Strand');
    t.begin();

    t.p1.cast('Brainstorm');
    t.resolveStack();
    const c = t.expectChoice();
    if (c.kind !== 'chooseCards') throw new Error('expected chooseCards');
    const putBack = c.options.slice(0, 2).map((o) => o.iid);
    t.answer({ kind: 'cards', iids: putBack });
    expect(t.state.zones.p1.library.slice(0, 2)).toEqual(putBack);

    t.p1.activate('Flooded Strand');
    t.resolveStack();
    t.auto();

    // After the shuffle those two cards are no longer guaranteed on top.
    expect(t.countEvents('shuffle')).toBeGreaterThan(0);
  });

  it('84. Brainstorm off a two card library loses the game to the empty draw', () => {
    const t = testGame();
    t.p1.hand('Brainstorm');
    t.p1.battlefield('Island');
    t.p1.librarySize(2);
    t.begin();

    t.p1.cast('Brainstorm');
    t.resolveAll();
    expect(t.state.winner).toBe('p2');
    expect(t.state.endReason).toMatch(/empty library/i);
  });

  it('85. the first card chosen for Brainstorm ends up on top', () => {
    const t = testGame();
    t.p1.hand('Brainstorm');
    t.p1.battlefield('Island');
    t.begin();

    t.p1.cast('Brainstorm');
    t.resolveStack();
    const c = t.expectChoice();
    if (c.kind !== 'chooseCards') throw new Error('expected chooseCards');
    expect(c.ordered).toBe(true);
    const [first, second] = c.options.slice(0, 2).map((o) => o.iid);
    t.answer({ kind: 'cards', iids: [first, second] });
    expect(t.state.zones.p1.library[0]).toBe(first);
    expect(t.state.zones.p1.library[1]).toBe(second);
  });

  it('86. Ponder reorders the top three, and the first choice ends up on top', () => {
    const t = testGame();
    t.p1.hand('Ponder');
    t.p1.manaBase(1);
    t.begin();

    t.p1.cast('Ponder');
    t.resolveStack();
    const c = t.expectChoice();
    if (c.kind !== 'chooseCards') throw new Error('expected chooseCards');
    expect(c.ordered).toBe(true);
    expect(c.options).toHaveLength(3);
    const [a, b, d] = c.options.map((o) => o.iid);
    t.answer({ kind: 'cards', iids: [d, b, a] });
    // "You may shuffle" — declining keeps the order that was just chosen, and
    // the draw then takes the card put on top.
    t.no();
    expect(t.state.zones.p1.hand).toContain(d);
    expect(t.state.zones.p1.library[0]).toBe(b);
    expect(t.state.zones.p1.library[1]).toBe(a);
  });

  it('87. Ponder shuffles only when asked, and always draws', () => {
    // auto() answers every yes/no with "no", so this is the decline branch.
    const declined = testGame();
    declined.p1.hand('Ponder');
    declined.p1.manaBase(1);
    declined.begin();
    declined.clearEvents();
    declined.p1.cast('Ponder');
    declined.resolveStack();
    declined.auto();
    expect(declined.countEvents('shuffle')).toBe(0);
    expect(declined.countEvents('draw')).toBe(1);

    const shuffled = testGame();
    shuffled.p1.hand('Ponder');
    shuffled.p1.manaBase(1);
    shuffled.begin();
    shuffled.clearEvents();
    shuffled.p1.cast('Ponder');
    shuffled.resolveStack();
    const c = shuffled.expectChoice();
    if (c.kind !== 'chooseCards') throw new Error('expected chooseCards');
    shuffled.answer({ kind: 'cards', iids: c.options.map((o) => o.iid) });
    shuffled.yes();
    expect(shuffled.countEvents('shuffle')).toBe(1);
    expect(shuffled.countEvents('draw')).toBe(1);
  });

  it('88. Ponder still draws with only one card left to look at', () => {
    const t = testGame();
    t.p1.hand('Ponder');
    t.p1.manaBase(1);
    t.p1.librarySize(1);
    t.begin();

    t.p1.cast('Ponder');
    t.resolveStack();
    // One card has only one order, so the arrange step is skipped entirely and
    // the "you may shuffle" question comes first.
    const c = t.expectChoice();
    expect(c.kind).toBe('yesNo');
    t.no();
    expect(t.state.zones.p1.library).toHaveLength(0);
  });

  it('89/90. Delve pays the generic part only, and needs the full cost with an empty yard', () => {
    const cheap = testGame();
    cheap.p1.hand('Dig Through Time');
    cheap.p1.manaBase(2);
    cheap.p1.graveyard('Brainstorm', 'Brainstorm', 'Brainstorm', 'Mana Drain', 'Mana Drain', 'Veil of Summer');
    cheap.begin();
    expect(cheap.p1.canCast('Dig Through Time')).toBe(true);

    const expensive = testGame();
    expensive.p1.hand('Dig Through Time');
    expensive.p1.manaBase(2);
    expensive.begin();
    expect(expensive.p1.canCast('Dig Through Time')).toBe(false);
  });

  it('91. delved cards leave the graveyard, so Mystic Sanctuary can no longer see them', () => {
    const t = testGame();
    t.p1.hand('Dig Through Time');
    t.p1.manaBase(2);
    t.p1.graveyard('Brainstorm', 'Brainstorm', 'Brainstorm', 'Mana Drain', 'Mana Drain', 'Veil of Summer');
    t.begin();

    t.p1.cast('Dig Through Time');
    const c = t.expectChoice();
    if (c.kind !== 'chooseCards') throw new Error('expected the delve prompt');
    t.answer({ kind: 'cards', iids: c.options.slice(0, 6).map((o) => o.iid) });

    expect(t.state.zones.p1.exile).toHaveLength(6);
    expect(t.state.zones.p1.graveyard).toHaveLength(0);
  });

  it("92. Rakshasa's Bargain puts two cards in the graveyard, fuelling delve", () => {
    const t = testGame();
    t.p1.hand("Rakshasa's Bargain");
    t.p1.manaBase(6);
    t.begin();

    t.p1.cast("Rakshasa's Bargain");
    t.resolveStack();
    t.auto();
    expect(t.p1.handSize()).toBe(2);
    // Two milled plus the Bargain itself.
    expect(t.p1.graveyardNames()).toHaveLength(3);
  });
});

describe('The manabase', () => {
  it('94/95. Mystic Sanctuary counts the Island land type, not the card name', () => {
    const t = testGame();
    // Breeding Pool, Watery Grave and Hedge Maze are all Islands.
    t.p1.battlefield('Breeding Pool', 'Watery Grave', 'Hedge Maze');
    t.p1.hand('Mystic Sanctuary');
    t.p1.graveyard('Brainstorm');
    t.begin();

    t.p1.playLand('Mystic Sanctuary');
    const ms = t.p1.find('Mystic Sanctuary', 'battlefield');
    expect(t.state.cards[ms].tapped).toBe(false);

    // Its trigger is on the stack with the graveyard Brainstorm targeted.
    t.resolveStack();
    t.yes();
    expect(t.p1.libraryNames()[0]).toBe('Brainstorm');
    expect(t.p1.graveyardNames()).not.toContain('Brainstorm');
  });

  it('96. with only two Islands it enters tapped and does not trigger', () => {
    const t = testGame();
    t.p1.battlefield('Breeding Pool', 'Watery Grave');
    t.p1.hand('Mystic Sanctuary');
    t.p1.graveyard('Brainstorm');
    t.begin();

    t.p1.playLand('Mystic Sanctuary');
    const ms = t.p1.find('Mystic Sanctuary', 'battlefield');
    expect(t.state.cards[ms].tapped).toBe(true);
    expect(t.state.stack).toHaveLength(0);
    expect(t.p1.graveyardNames()).toContain('Brainstorm');
  });

  it('97. an empty graveyard means the trigger is never put on the stack', () => {
    const t = testGame();
    t.p1.battlefield('Breeding Pool', 'Watery Grave', 'Hedge Maze');
    t.p1.hand('Mystic Sanctuary');
    t.begin();

    t.p1.playLand('Mystic Sanctuary');
    expect(t.state.stack).toHaveLength(0);
    expect(t.logText()).toMatch(/no legal targets/i);
  });

  it('98. a fetchland finding Mystic Sanctuary counts Islands at the moment it enters', () => {
    const t = testGame();
    t.p1.battlefield('Breeding Pool', 'Watery Grave', 'Hedge Maze', 'Flooded Strand');
    t.begin();

    t.p1.activate('Flooded Strand');
    t.resolveStack();
    const c = t.expectChoice();
    expect(c.kind).toBe('chooseCards');
    t.chooseCards('Mystic Sanctuary');
    t.auto();

    const ms = t.p1.find('Mystic Sanctuary', 'battlefield');
    expect(t.state.cards[ms].tapped).toBe(false);
    expect(t.p1.lifeTotal).toBe(19);
  });

  it('99/100. Mistrise Village enters untapped only with a Mountain or Forest', () => {
    const withForest = testGame();
    // Breeding Pool is a Forest Island.
    withForest.p1.battlefield('Breeding Pool');
    withForest.p1.hand('Mistrise Village');
    withForest.begin();
    withForest.p1.playLand('Mistrise Village');
    expect(withForest.state.cards[withForest.p1.find('Mistrise Village', 'battlefield')].tapped).toBe(false);

    const without = testGame();
    without.p1.battlefield('Island');
    without.p1.hand('Mistrise Village');
    without.begin();
    without.p1.playLand('Mistrise Village');
    expect(without.state.cards[without.p1.find('Mistrise Village', 'battlefield')].tapped).toBe(true);
  });

  it('102. an unused Mistrise shield simply expires at end of turn', () => {
    const t = testGame();
    t.p1.battlefield('Mistrise Village', 'Island');
    t.p1.hand('Brainstorm');
    t.begin();

    t.p1.activate('Mistrise Village');
    t.resolveStack();
    expect(t.state.effects.some((e) => e.kind === 'cantBeCountered')).toBe(true);

    // Right past the end of p1's own turn — the effect says "until end of
    // turn", not "until end of round".
    t.passUntilCondition(() => t.state.activePlayer === 'p2');
    expect(t.state.effects.some((e) => e.kind === 'cantBeCountered')).toBe(false);
  });

  it('103. Planar Genesis puts a land onto the battlefield without using the land drop', () => {
    const t = testGame();
    t.p1.hand('Planar Genesis');
    t.p1.manaBase(2);
    t.p1.libraryTop('Island', 'Brainstorm', 'Brainstorm', 'Brainstorm');
    t.begin();

    t.p1.cast('Planar Genesis');
    t.resolveStack();
    t.chooseCards('Island');
    t.auto();

    const island = t.p1.find('Island', 'battlefield');
    expect(t.state.cards[island].tapped).toBe(true);
    expect(t.state.players.p1.landDropsUsed).toBe(0);
  });

  it('104. with no land among the four, a card goes to hand instead', () => {
    const t = testGame();
    t.p1.hand('Planar Genesis');
    t.p1.manaBase(2);
    t.p1.libraryTop('Brainstorm', 'Brainstorm', 'Brainstorm', 'Brainstorm');
    t.begin();

    t.p1.cast('Planar Genesis');
    t.resolveStack();
    const c = t.expectChoice();
    expect(c.kind).toBe('chooseCards');
    if (c.kind === 'chooseCards') {
      expect(c.min).toBe(1);
      expect(c.prompt).toMatch(/into your hand/i);
    }
  });

  it('105. Borne Upon a Wind does not let you play a land at instant speed', () => {
    const t = testGame();
    t.p1.hand('Borne Upon a Wind', 'Island');
    t.p1.manaBase(2);
    t.begin();

    t.p1.cast('Borne Upon a Wind');
    t.resolveAll();
    t.passUntil('end_step');

    const islandIid = t.p1.find('Island', 'hand');
    expect(
      t.game.legalActions('p1').some((a) => a.intent.t === 'playLand' && a.intent.iid === islandIid),
    ).toBe(false);
  });

  it('106. a fetchland at one life is legal and lethal', () => {
    const t = testGame();
    t.p1.battlefield('Flooded Strand');
    t.p1.life(1);
    t.begin();

    t.p1.activate('Flooded Strand');
    t.resolveAll(200);
    expect(t.state.winner).toBe('p2');
  });

  it('107. a shockland can be paid for at exactly two life, and it kills you', () => {
    const t = testGame();
    t.p1.hand('Watery Grave');
    t.p1.life(2);
    t.begin();

    t.p1.playLand('Watery Grave');
    t.yes();
    expect(t.state.winner).toBe('p2');
  });

  it('108-110. Waterlogged Teachings finds instants and flash cards, but not sorceries', () => {
    const t = testGame();
    t.p1.hand('Waterlogged Teachings');
    t.p1.manaBase(4);
    t.begin();

    t.p1.cast('Waterlogged Teachings');
    t.resolveStack();
    const c = t.expectChoice();
    if (c.kind !== 'chooseCards') throw new Error('expected search');
    const names = c.options.map((o) => t.state.cards[o.iid].oracleId);

    expect(names).toContain('brainstorm'); // instant
    expect(names).toContain('hullbreaker_horror'); // flash
    expect(names).toContain('orcish_bowmasters'); // flash
    expect(names).not.toContain('show_and_tell'); // sorcery, no flash
    expect(names).not.toContain('omniscience');
  });

  it('111. the back face of a modal DFC is a tapped land that uses your land drop', () => {
    const t = testGame();
    t.p1.hand('Waterlogged Teachings');
    t.begin();

    t.p1.playLand('Waterlogged Teachings', 'back');
    const iid = t.p1.find('Waterlogged Teachings', 'battlefield');
    expect(t.state.cards[iid].face).toBe('back');
    expect(t.state.cards[iid].tapped).toBe(true);
    expect(t.state.players.p1.landDropsUsed).toBe(1);
    expect(t.p1.battlefieldNames()).toContain('Inundated Archive');
  });
});
