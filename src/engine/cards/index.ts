import { frontFace, oracle } from '../oracle.js';
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
  ponder,
  rakshasasBargain,
} from './cantrips.js';
import { demonicTutor, waterloggedTeachings } from './tutors.js';
import { omniscience, showAndTell } from './combo.js';
import { atraxaGrandUnifier, hullbreakerHorror, orcishBowmasters } from './creatures.js';
import { manaDrain, veilOfSummer } from './interaction.js';
import { commandeer, forceOfNegation, mindbreakTrap, pactOfNegation } from './free.js';
import { eternalWitness, gitaxianProbe, jacesErasure, peek } from './cube.js';

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
  ponder,
  borneUponAWind,
  digThroughTime,
  rakshasasBargain,
  planarGenesis,
  // tutors
  demonicTutor,
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
  // spells you can cast without paying for them
  commandeer,
  forceOfNegation,
  mindbreakTrap,
  pactOfNegation,
  // drafted cube
  jacesErasure,
  peek,
  gitaxianProbe,
  eternalWitness,
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

/**
 * Keywords the engine plays correctly with no script: combat and timing
 * behaviour the generic rules already cover.
 */
const GENERIC_KEYWORDS = [
  'flying',
  'flash',
  'vigilance',
  'deathtouch',
  'lifelink',
  'reach',
  'defender',
  'haste',
];

/**
 * Why this card cannot be played yet — or null when it works.
 *
 * From a real playtest: Thoughtseize was offered, cast, paid for and resolved,
 * and nothing at all happened — `resolveSpell` runs the script if there is one
 * and shrugs if there is not. From the table that is indistinguishable from a
 * broken game, and it cost a real card and real mana.
 *
 * So the question every gate asks — can this be cast, can this land be played,
 * should the deck builder warn — is answered here, once. A card is playable when
 * it has a script, or when everything printed on it is behaviour the engine
 * already provides: vanilla combat stats, the keywords above, and an
 * unconditional mana ability (which `producedManaFor` has already vetted — a
 * Chrome Mox reports no produced mana precisely because its ability is not
 * unconditional). Basic lands have no text at all.
 */
export function unimplementedReason(oracleId: OracleId): string | null {
  if (REGISTRY[oracleId]) return null;
  const card = oracle(oracleId);
  const face = frontFace(oracleId);
  if (face.supertypes.includes('Basic')) return null;
  // A second face the front cannot vouch for needs its own script.
  if (card.faces) return 'not implemented yet - this card does nothing if played';
  const covered = face.oracleText.split('\n').every((rawLine) => {
    const line = rawLine.replace(/\([^)]*\)/g, '').trim();
    if (line === '') return true;
    // A line of known keywords: "Flying" or "Flash, vigilance".
    const words = line.replace(/\.$/, '').split(/[,;]\s*/);
    if (words.every((w) => GENERIC_KEYWORDS.includes(w.trim().toLowerCase()))) return true;
    // An unconditional mana ability, already vetted by producedManaFor.
    if (/^\{T\}: Add /.test(line) && face.producedMana.length > 0) return true;
    return false;
  });
  return covered ? null : 'not implemented yet - this card does nothing if played';
}
