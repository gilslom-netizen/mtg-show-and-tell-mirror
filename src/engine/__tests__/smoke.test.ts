import { describe, expect, it } from 'vitest';
import { testGame } from './harness';
import { MAINDECK, MAINDECK_SIZE } from '../deck';
import { ORACLE, allOracleIds, oracleByName } from '../oracle';
import { scriptedOracleIds } from '../cards';

describe('setup', () => {
  it('loads all 25 cards from the frozen Scryfall data', () => {
    expect(allOracleIds()).toHaveLength(25);
    expect(ORACLE['show_and_tell'].typeLine).toBe('Sorcery');
  });

  it('has a legal 60 card maindeck', () => {
    expect(MAINDECK_SIZE).toBe(60);
    expect(MAINDECK.every((e) => ORACLE[e.oracleId])).toBe(true);
  });

  it('has a script for every card that needs one', () => {
    const scripted = new Set(scriptedOracleIds());
    // Island is the only card with no rules text beyond producing mana.
    const unscripted = allOracleIds().filter((id) => !scripted.has(id));
    expect(unscripted).toEqual(['island']);
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
    t.advanceToTurn(startTurn + 1);
    expect(t.state.turn).toBe(startTurn + 1);
    expect(t.state.activePlayer).toBe('p2');
    t.assertCardConservation();
  });
});
