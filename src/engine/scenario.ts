import type { Game } from './game.js';
import { oracleByName } from './oracle.js';
import { moveCardRaw, stepAt } from './state.js';
import { TURN_SEQUENCE, type IID, type Phase, type PlayerId, type Step } from './types.js';

/**
 * Staging a specific board.
 *
 * Used by the practice drills in the client — the format is meant to be played
 * hundreds of times, so being able to jump straight to "you have Show and Tell and
 * three lands" is worth more than another random game. Cards are taken out of the
 * library, so the deck always stays at sixty.
 */

export interface SeatSetup {
  hand?: string[];
  battlefield?: string[];
  battlefieldTapped?: string[];
  graveyard?: string[];
  life?: number;
}

export interface ScenarioSpec {
  name: string;
  description: string;
  startingPlayer?: PlayerId;
  phase?: Phase;
  step?: Step;
  p1?: SeatSetup;
  p2?: SeatSetup;
}

function take(game: Game, player: PlayerId, names: string[]): IID[] {
  const s = game.state;
  const used: IID[] = [];
  for (const name of names) {
    const oracleId = oracleByName(name).oracleId;
    const iid = s.zones[player].library.find(
      (i) => s.cards[i].oracleId === oracleId && !used.includes(i),
    );
    if (iid === undefined) throw new Error(`No ${name} left in ${player}'s library`);
    used.push(iid);
  }
  return used;
}

function applySeat(game: Game, player: PlayerId, setup: SeatSetup): void {
  const s = game.state;
  for (const iid of take(game, player, setup.hand ?? [])) {
    moveCardRaw(s, iid, 'hand');
  }
  for (const iid of take(game, player, setup.battlefield ?? [])) {
    moveCardRaw(s, iid, 'battlefield', { controller: player });
    s.cards[iid].summoningSick = false;
  }
  for (const iid of take(game, player, setup.battlefieldTapped ?? [])) {
    moveCardRaw(s, iid, 'battlefield', { controller: player, tapped: true });
    s.cards[iid].summoningSick = false;
  }
  for (const iid of take(game, player, setup.graveyard ?? [])) {
    moveCardRaw(s, iid, 'graveyard');
  }
  if (setup.life !== undefined) s.players[player].life = setup.life;
}

/** Applies a scenario to a freshly created game and hands priority to the active player. */
export function stageScenario(game: Game, spec: ScenarioSpec): void {
  const s = game.state;
  s.mode = 'playing';
  if (spec.p1) applySeat(game, 'p1', spec.p1);
  if (spec.p2) applySeat(game, 'p2', spec.p2);

  const phase = spec.phase ?? 'precombat_main';
  const step = spec.step ?? 'main';
  const idx = TURN_SEQUENCE.findIndex((x) => x.phase === phase && x.step === step);
  s.stepIndex = idx < 0 ? 3 : idx;
  const at = stepAt(s.stepIndex);
  s.phase = at.phase;
  s.step = at.step;
  s.stepInitialized = true;
  s.priorityPlayer = s.activePlayer;
  s.passed = [];
  game.flushEvents();
  game.advance();
}

/**
 * The drills. Each one drops you straight into a decision this deck actually has to
 * make, instead of asking you to shuffle up and hope.
 */
export const SCENARIOS: Record<string, ScenarioSpec> = {
  showAndTell: {
    name: 'The Show and Tell decision',
    startingPlayer: 'p1',
    description:
      'You have Show and Tell, Omniscience and Atraxa. So does the other seat. Both of you pick in secret.',
    p1: {
      hand: ['Show and Tell', 'Omniscience', 'Atraxa, Grand Unifier', 'Brainstorm'],
      battlefield: ['Island', 'Breeding Pool', 'Watery Grave'],
    },
    p2: {
      hand: ['Atraxa, Grand Unifier', 'Omniscience', 'Mana Drain', 'Veil of Summer'],
      battlefield: ['Undercity Sewers', 'Hedge Maze'],
    },
  },

  omniscienceTurn: {
    name: 'The combo turn',
    startingPlayer: 'p1',
    description:
      'Omniscience is already down and your hand is live. Practise chaining free spells without giving away a window.',
    p1: {
      hand: [
        'Atraxa, Grand Unifier',
        'Brainstorm',
        'Dig Through Time',
        'Show and Tell',
        'Borne Upon a Wind',
        "Rakshasa's Bargain",
      ],
      battlefield: ['Omniscience', 'Island', 'Breeding Pool'],
      graveyard: ['Brainstorm', 'Brainstorm', 'Mana Drain'],
    },
    p2: {
      hand: ['Mana Drain', 'Veil of Summer'],
      battlefield: ['Watery Grave', 'Hedge Maze'],
    },
  },

  hullbreakerLock: {
    name: 'Hullbreaker Horror + Omniscience',
    startingPlayer: 'p1',
    description:
      'Every free spell triggers the Horror. This is the turn the trigger policy exists for.',
    p1: {
      hand: ['Brainstorm', 'Brainstorm', 'Dig Through Time', 'Atraxa, Grand Unifier'],
      battlefield: ['Omniscience', 'Hullbreaker Horror', 'Island'],
      graveyard: ['Mana Drain', 'Mana Drain', 'Veil of Summer'],
    },
    p2: {
      hand: ['Show and Tell'],
      battlefield: ['Watery Grave', 'Breeding Pool', 'Hedge Maze', 'Omniscience'],
    },
  },

  bowmasterWar: {
    name: 'Orcish Bowmasters on the draw',
    startingPlayer: 'p1',
    description:
      'They have two Bowmasters. Every extra card you draw is a ping and an Army counter.',
    p1: {
      hand: ['Brainstorm', 'Dig Through Time', "Rakshasa's Bargain"],
      battlefield: ['Island', 'Breeding Pool', 'Watery Grave', 'Hedge Maze', 'Undercity Sewers'],
      graveyard: ['Mana Drain', 'Mana Drain', 'Veil of Summer', 'Brainstorm', 'Brainstorm', 'Show and Tell'],
      life: 12,
    },
    p2: {
      battlefield: ['Orcish Bowmasters', 'Orcish Bowmasters', 'Hallowed Fountain'],
    },
  },

  fetchBrainstorm: {
    name: 'Brainstorm into a fetchland',
    startingPlayer: 'p1',
    description:
      'The oldest decision in the deck: what do you put back, and do you shuffle it away?',
    p1: {
      hand: ['Brainstorm', 'Show and Tell', 'Atraxa, Grand Unifier'],
      battlefield: ['Island', 'Flooded Strand', 'Polluted Delta'],
    },
    p2: {
      battlefield: ['Watery Grave'],
    },
  },
};
