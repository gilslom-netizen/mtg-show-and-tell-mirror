import { ORACLE_DATA as raw } from './generated/oracle-cards.gen.js';
import type { CardType, Color, OracleCard, OracleFace, OracleId } from './types.js';

/**
 * Static card database, built from the frozen Scryfall snapshot in data/oracle-cards.json.
 *
 * Card text is never typed by hand anywhere in this repo — everything reads from here.
 * `npm run sync:cards` refetches and fails loudly if any oracle text changed upstream.
 */

interface RawFace {
  name: string;
  mana_cost?: string;
  cmc?: number;
  type_line: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  colors?: string[];
  keywords?: string[];
  produced_mana?: string[];
  image_uri?: string | null;
}

interface RawCard extends RawFace {
  layout: string;
  card_faces?: RawFace[];
  oracle_id: string;
  cmc: number;
  scryfall_uri?: string;
}

const ALL_TYPES: CardType[] = [
  'Artifact',
  'Battle',
  'Creature',
  'Enchantment',
  'Instant',
  'Land',
  'Planeswalker',
  'Sorcery',
];

const SUPERTYPES = ['Basic', 'Legendary', 'Snow', 'World', 'Ongoing'];

export function slugify(name: string): OracleId {
  return name
    .split('//')[0]
    .trim()
    .toLowerCase()
    .replace(/[',\.]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** "Legendary Creature — Phyrexian Angel" -> supertypes/types/subtypes */
function parseTypeLine(typeLine: string): {
  types: CardType[];
  subtypes: string[];
  supertypes: string[];
} {
  // The em dash is what Scryfall uses; accept a hyphen too for hand-written tokens.
  const [left, right] = typeLine.split(/\s+[—-]\s+/);
  const words = left.trim().split(/\s+/).filter(Boolean);
  const supertypes: string[] = [];
  const types: CardType[] = [];
  for (const w of words) {
    if (SUPERTYPES.includes(w)) supertypes.push(w);
    else if ((ALL_TYPES as string[]).includes(w)) types.push(w as CardType);
  }
  const subtypes = right ? right.trim().split(/\s+/).filter(Boolean) : [];
  return { types, subtypes, supertypes };
}

/**
 * Mana value of a cost string.
 * CR 202.3f — a hybrid symbol with a generic half counts as the larger half,
 * which is why Rakshasa's Bargain ({2/B}{2/G}{2/U}) has mana value 6.
 */
export function manaValueOf(cost: string | null): number {
  if (!cost) return 0;
  let total = 0;
  for (const sym of cost.matchAll(/\{([^}]+)\}/g)) {
    const s = sym[1];
    if (/^\d+$/.test(s)) total += Number(s);
    else if (/^(\d+)\/[WUBRG]$/.test(s)) total += Number(s.split('/')[0]);
    else if (s === 'X' || s === 'Y' || s === 'Z') total += 0;
    else total += 1; // {U}, {U/B}, {U/P}, {S}, {C}
  }
  return total;
}

function buildFace(
  f: RawFace,
  fallbackImage: string | null,
  fallbackProducedMana: string[] = [],
): OracleFace {
  const { types, subtypes, supertypes } = parseTypeLine(f.type_line);
  // Scryfall reports produced_mana at card level for modal DFCs, so the land face
  // has to inherit it or Inundated Archive would tap for nothing.
  const produced =
    f.produced_mana ?? (types.includes('Land') ? fallbackProducedMana : []);
  return {
    name: f.name,
    manaCost: f.mana_cost && f.mana_cost.length > 0 ? f.mana_cost : null,
    mv: manaValueOf(f.mana_cost ?? null),
    typeLine: f.type_line,
    types,
    subtypes,
    supertypes,
    colors: (f.colors ?? []) as Color[],
    oracleText: f.oracle_text ?? '',
    power: f.power ?? null,
    toughness: f.toughness ?? null,
    keywords: f.keywords ?? [],
    producedMana: produced as Color[],
    imageUri: f.image_uri ?? fallbackImage,
  };
}

function buildCard(c: RawCard): OracleCard {
  const isMdfc = c.layout === 'modal_dfc' && Array.isArray(c.card_faces);
  const faces = isMdfc
    ? c.card_faces!.map((f) => buildFace(f, c.image_uri ?? null, c.produced_mana ?? []))
    : null;
  const primary = faces ? faces[0] : buildFace(c, c.image_uri ?? null);
  return {
    ...primary,
    // Keep the real printed mana value for the whole card, which for an MDFC is the
    // front face's — that is what Mana Drain reads off a Waterlogged Teachings spell.
    mv: faces ? faces[0].mv : c.cmc,
    oracleId: slugify(c.name),
    layout: isMdfc ? 'modal_dfc' : 'normal',
    faces,
  };
}

const cards: Record<OracleId, OracleCard> = {};
const byName: Record<string, OracleCard> = {};

for (const c of (raw as { cards: RawCard[] }).cards) {
  const card = buildCard(c);
  cards[card.oracleId] = card;
  byName[card.name.toLowerCase()] = card;
  // MDFCs are also addressable by their front face name alone.
  byName[card.name.split('//')[0].trim().toLowerCase()] = card;
}

export const ORACLE: Readonly<Record<OracleId, OracleCard>> = cards;

export function oracle(id: OracleId): OracleCard {
  const c = cards[id];
  if (!c) throw new Error(`Unknown oracle id: ${id}`);
  return c;
}

/** Look a card up by printed name. Used by the deck loader and the test harness. */
export function oracleByName(name: string): OracleCard {
  const c = byName[name.toLowerCase()] ?? byName[name.split('//')[0].trim().toLowerCase()];
  if (!c) throw new Error(`Unknown card name: ${name}`);
  return c;
}

export function allOracleIds(): OracleId[] {
  return Object.keys(cards).sort();
}

// --- face helpers ----------------------------------------------------------

/**
 * Characteristics of a card in a hidden/graveyard/hand zone.
 *
 * CR 712.8a: while a modal double-faced card is anywhere other than the battlefield
 * or the stack, it has only its front face's characteristics. This is why
 * Waterlogged Teachings in hand is an Instant and can NOT be chosen for Show and Tell,
 * and why it counts as an instant (never a land) for Atraxa.
 */
export function frontFace(id: OracleId): OracleFace {
  const c = oracle(id);
  return c.faces ? c.faces[0] : c;
}

export function faceOf(id: OracleId, face: 'front' | 'back'): OracleFace {
  const c = oracle(id);
  if (!c.faces) return c;
  return face === 'back' ? c.faces[1] : c.faces[0];
}

export function hasType(f: { types: CardType[] }, t: CardType): boolean {
  return f.types.includes(t);
}

export function hasSubtype(f: { subtypes: string[] }, s: string): boolean {
  return f.subtypes.includes(s);
}
