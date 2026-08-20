import type { CardScript } from '../script-types';
import type { OracleId } from '../types';

import {
  breedingPool,
  floodedStrand,
  hallowedFountain,
  hedgeMaze,
  mistriseVillage,
  mysticSanctuary,
  pollutedDelta,
  undercitySewers,
  wateryGrave,
} from './lands';
import {
  borneUponAWind,
  brainstorm,
  digThroughTime,
  planarGenesis,
  rakshasasBargain,
} from './cantrips';
import { assembleTheTeam, demonicTutor, waterloggedTeachings } from './tutors';
import { omniscience, showAndTell } from './combo';
import { atraxaGrandUnifier, hullbreakerHorror, orcishBowmasters } from './creatures';
import { manaDrain, veilOfSummer } from './interaction';

/**
 * The script registry.
 *
 * `Island` deliberately has no script — a basic land needs nothing beyond the mana
 * production the engine reads from Scryfall's produced_mana.
 */
const ALL: CardScript[] = [
  // lands
  breedingPool,
  wateryGrave,
  hallowedFountain,
  floodedStrand,
  pollutedDelta,
  hedgeMaze,
  undercitySewers,
  mysticSanctuary,
  mistriseVillage,
  // selection
  brainstorm,
  borneUponAWind,
  digThroughTime,
  rakshasasBargain,
  planarGenesis,
  // tutors
  demonicTutor,
  assembleTheTeam,
  waterloggedTeachings,
  // combo
  showAndTell,
  omniscience,
  // creatures
  atraxaGrandUnifier,
  hullbreakerHorror,
  orcishBowmasters,
  // interaction
  manaDrain,
  veilOfSummer,
];

const REGISTRY: Record<OracleId, CardScript> = {};
for (const s of ALL) {
  if (REGISTRY[s.oracleId]) throw new Error(`Duplicate card script: ${s.oracleId}`);
  REGISTRY[s.oracleId] = s;
}

export function getScript(oracleId: OracleId): CardScript | undefined {
  return REGISTRY[oracleId];
}

export function scriptedOracleIds(): OracleId[] {
  return Object.keys(REGISTRY).sort();
}
