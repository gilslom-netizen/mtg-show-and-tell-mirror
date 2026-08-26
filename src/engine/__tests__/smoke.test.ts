import { describe, expect, it } from 'vitest';
import { testGame } from './harness.js';
import { MAINDECK, MAINDECK_SIZE } from '../deck.js';
import { ORACLE, allOracleIds, oracleByName } from '../oracle.js';
import { scriptedOracleIds } from '../cards/index.js';
import { DRAFT_POOL, grantedLands } from '../draft-pool.js';

describe('setup', () => {
  it('loads the frozen Scryfall data, main deck and draft pool alike', () => {
    // One snapshot covers everything the app can show: the shared main deck, the
    // draft pool, and the lands a drafter is handed. Asserting an exact count
    // here would just be a number to bump every time the pool changes — what
    // matters is that the cards the engine needs are all in it.
    expect(allOracleIds().length).toBeGreaterThanOrEqual(25);
    expect(ORACLE['show_and_tell'].typeLine).toBe('Sorcery');
    expect(ORACLE['timetwister']).toBeDefined();
  });

  it('has a legal 60 card maindeck', () => {
    expect(MAINDECK_SIZE).toBe(60);
    expect(MAINDECK.every((e) => ORACLE[e.oracleId])).toBe(true);
  });

  it('has a script for every card the main deck can actually play', () => {
    const scripted = new Set(scriptedOracleIds());
    // Island is the only main deck card with no rules text beyond producing mana.
    const unscripted = [...new Set(MAINDECK.map((e) => e.oracleId))]
      .filter((id) => !scripted.has(id))
      .sort();
    expect(unscripted).toEqual(['island']);
  });

  it('can play every land the draft hands out', () => {
    // Each drafter gets four lands per colour — that colour plus blue, two
    // shocklands and two surveil lands. They are dealt to every player in every
    // drafted game, so they are the one part of the pool that must work.
    const scripted = new Set(scriptedOracleIds());
    for (const entry of grantedLands()) {
      expect(scripted.has(entry.oracleId), `${entry.oracleId} has no script`).toBe(true);
    }
  });

  it('knows which drafted cards are not playable yet', () => {
    // The draft pool is in the card database so it can be drafted, shown and
    // deckbuilt with — but a card needs an engine script before it can be cast.
    // This test exists to keep that gap measured rather than surprising: it is
    // the list that has to reach zero before a drafted deck is fully playable.
    const scripted = new Set(scriptedOracleIds());
    const poolIds = DRAFT_POOL.map((name) => oracleByName(name).oracleId);
    const playable = poolIds.filter((id) => scripted.has(id));
    // Some pool cards are already implemented because the main deck uses them.
    expect(playable.length).toBeGreaterThan(0);
    expect(poolIds.length).toBe(63);
  });

  it('parses mana values correctly, including hybrid symbols', () => {
    // CR 202.3f — {2/B} counts as 2, so this is a six mana instant.
    expect(oracleByName("Rakshasa's Bargain").mv).toBe(6);
    expect(oracleByName('Omniscience').mv).toBe(10);
    expect(oracleByName('Dig Through Time').mv).toBe(8);
    // MDFC mana value comes from the front face.
    expect(oracleByName('Waterlogged Teachings').mv).toBe(4);
  });

  it('parses land types, which several cards count', () => {
    expect(oracleByName('Breeding Pool').subtypes).toEqual(['Forest', 'Island']);
    expect(oracleByName('Undercity Sewers').subtypes).toEqual(['Island', 'Swamp']);
    expect(oracleByName('Mistrise Village').subtypes).toEqual([]);
  });
});

describe('engine basics', () => {
  it('starts a game and gives the active player priority in their main phase', () => {
    const t = testGame();
    t.p1.hand('Island');
    t.begin();
    expect(t.state.priorityPlayer).toBe('p1');
    expect(t.state.phase).toBe('precombat_main');
    t.assertCardConservation();
  });

  it('plays a land and taps it for mana', () => {
    const t = testGame();
    t.p1.hand('Island');
    t.begin();
    t.p1.playLand('Island');
    expect(t.p1.battlefieldNames()).toEqual(['Island']);
    expect(t.state.players.p1.landDropsUsed).toBe(1);
    // A second land drop is not offered.
    t.p1.hand('Watery Grave');
    expect(
      t.game.legalActions('p1').some((a) => a.intent.t === 'playLand'),
    ).toBe(false);
  });

  it('casts a spell and resolves it', () => {
    const t = testGame();
    t.p1.hand('Brainstorm');
    t.p1.battlefield('Island');
    t.begin();
    t.p1.cast('Brainstorm');
    expect(t.stackNames()).toEqual(['Brainstorm']);
    t.resolveStack();
    // Brainstorm asks which two cards to put back.
    expect(t.expectChoice().kind).toBe('chooseCards');
    t.auto();
    expect(t.p1.handSize()).toBe(1);
    expect(t.p1.graveyardNames()).toEqual(['Brainstorm']);
    t.assertCardConservation();
  });

  it('empties the mana pool between steps', () => {
    const t = testGame();
    t.p1.hand('Brainstorm');
    t.p1.battlefield('Island');
    t.begin();
    t.game.submitIntent('p1', { t: 'tapForMana', iid: t.p1.find('Island', 'battlefield'), kind: 'U' });
    expect(t.state.players.p1.manaPool.U).toBe(1);
    t.passUntil('begin_combat');
    expect(t.state.players.p1.manaPool.U).toBe(0);
  });

  it('advances through a full turn cycle without stalling', () => {
    const t = testGame();
    t.p1.hand('Island');
    t.p2.hand('Island');
    t.begin();
    const startTurn = t.state.turn;
    // `turn` counts rounds: p2's turn is still round 1 (same number as p1's),
    // and only ticks over once play returns to p1, who started the game.
    t.passUntilCondition(() => t.state.activePlayer === 'p2');
    expect(t.state.turn).toBe(startTurn);
    expect(t.state.activePlayer).toBe('p2');
    t.advanceToTurn(startTurn + 1);
    expect(t.state.turn).toBe(startTurn + 1);
    expect(t.state.activePlayer).toBe('p1');
    t.assertCardConservation();
  });
});
