import type { CardScript } from '../script-types.js';
import type { OracleId } from '../types.js';

import {
  breedingPool,
  floodedStrand,
  hallowedFountain,
  meticulousArchive,
  steamVents,
  thunderingFalls,
  hedgeMaze,
  mistriseVillage,
  mysticSanctuary,
  pollutedDelta,
  undercitySewers,
  wateryGrave,
} from './lands.js';
import {
  borneUponAWind,
  brainstorm,
  digThroughTime,
  planarGenesis,
  rakshasasBargain,
} from './cantrips.js';
import { assembleTheTeam, demonicTutor, waterloggedTeachings } from './tutors.js';
import { omniscience, showAndTell } from './combo.js';
import { atraxaGrandUnifier, hullbreakerHorror, orcishBowmasters } from './creatures.js';
import { manaDrain, veilOfSummer } from './interaction.js';

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
  meticulousArchive,
  steamVents,
  thunderingFalls,
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
