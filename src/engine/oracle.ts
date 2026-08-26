import { ERRATA_DATA } from './generated/errata.gen.js';
import { ORACLE_DATA as raw } from './generated/oracle-cards.gen.js';
import type { CardType, Color, OracleCard, OracleFace, OracleId } from './types.js';

/**
 * Static card database, built from the frozen Scryfall snapshot in data/oracle-cards.json
 * and the house changes in data/errata.json.
 *
 * Card text is never typed by hand anywhere in this repo — everything reads from here.
 * `npm run sync:cards` refetches and fails loudly if any oracle text changed upstream.
 *
 * The errata are a separate layer rather than edits to the snapshot, and the reason is
 * the sync: it compares against Scryfall and reports every difference, so a house change
 * written into the snapshot would either be reported as drift for ever or be quietly
 * overwritten the next time somebody ran it. Kept apart, the snapshot stays exactly what
 * Wizards printed and the deliberate deviations stay in one file you can read end to end.
 */

interface RawFace {
  name: string;
  mana_cost?: string;
  cmc?: number;
  type_line: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
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

/**
 * The mana a permanent taps for, without a script.
 *
 * The engine offers "tap this for {G}" off Scryfall's `produced_mana` alone, which
 * is exactly right for a land or a Mox — their whole ability is "{T}: Add" — and
 * exactly wrong for anything whose mana costs more than the tap. Deathrite Shaman
 * reports producing all five colours, but only by exiling a land from a graveyard
 * first; offered as a plain tap it would be a free Birds of Paradise that also
 * fixes. So a non-land has to actually say "{T}: Add" to get the shortcut, and
 * anything conditional waits for a script instead of being quietly wrong.
 *
 * Lands keep the old rule, including the inherited fallback: a basic prints no
 * text at all, so there is nothing to match against.
 */
const BASIC_LAND_TYPES = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

/**
 * Whether this face's mana can be trusted straight from Scryfall's produced_mana.
 *
 * The old test was "does the text contain {T}: Add", which reads the words and
 * ignores the sentence: an unimprinted Chrome Mox offered all five colours,
 * because "{T}: Add one mana of any of the exiled card's colors" contains the
 * magic string — and there is no exiled card. Cavern of Souls handed out
 * unrestricted mana for the same reason, minus its whole "spend only on the
 * chosen creature type" clause.
 *
 * So the question is now about the ability, not the string: the mana is derived
 * automatically only when there is an Add line with no condition riding on it.
 * Anything conditional — imprint, chosen colours, spend-only restrictions —
 * waits for a real script instead of being quietly wrong.
 */
function producedManaFor(f: RawFace, types: string[], subtypes: string[], fallback: string[]): string[] {
  const produced = f.produced_mana ?? (types.includes('Land') ? fallback : undefined);
  if (!produced || produced.length === 0) return [];
  const text = f.oracle_text ?? '';
  // A restriction anywhere poisons the whole derivation: produced_mana is one flat
  // list, so there is no way to keep the unrestricted half of a Cavern of Souls.
  if (/spend this mana only/i.test(text)) return [];
  // A basic land type is an intrinsic mana ability (CR 305.6) — the duals and
  // surveil lands say their mana only in reminder text, and it is still real.
  if (types.includes('Land') && subtypes.some((st) => BASIC_LAND_TYPES.includes(st))) {
    return produced;
  }
  if (text === '') return produced;
  const unconditional = text
    .split('\n')
    .some((line) => /^\{T\}: Add [^.]+\.$/.test(line.trim()) && !/exiled|chosen/i.test(line));
  return unconditional ? produced : [];
}

function buildFace(
  f: RawFace,
  fallbackImage: string | null,
  fallbackProducedMana: string[] = [],
): OracleFace {
  const { types, subtypes, supertypes } = parseTypeLine(f.type_line);
  // Scryfall reports produced_mana at card level for modal DFCs, so the land face
  // has to inherit it or Inundated Archive would tap for nothing.
  const produced = producedManaFor(f, types, subtypes, fallbackProducedMana);
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
    loyalty: f.loyalty ?? null,
  };
}

function buildCard(c: RawCard): OracleCard {
  // Two-faced layouts both carry their text on card_faces; the difference is how
  // the back is reached. A modal DFC is played as either face from hand; a
  // transforming card is always cast as its front and only transforms on the
  // battlefield — Tamiyo, Inquisitive Student is the one in the pool.
  const twoFaced = (c.layout === 'modal_dfc' || c.layout === 'transform') && Array.isArray(c.card_faces);
  const faces = twoFaced
    ? c.card_faces!.map((f) => buildFace(f, c.image_uri ?? null, c.produced_mana ?? []))
    : null;
  const primary = faces ? faces[0] : buildFace(c, c.image_uri ?? null);
  return {
    ...primary,
    // Keep the real printed mana value for the whole card, which for an MDFC is the
    // front face's — that is what Mana Drain reads off a Waterlogged Teachings spell.
    mv: faces ? faces[0].mv : c.cmc,
    oracleId: slugify(c.name),
    layout: twoFaced ? (c.layout as 'modal_dfc' | 'transform') : 'normal',
    faces,
  };
}

interface Erratum {
  name: string;
  why: string;
  mana_cost?: string;
  oracle_text?: string;
  type_line?: string;
  power?: string;
  toughness?: string;
}

const errata = new Map<string, Erratum>(
  (ERRATA_DATA as { cards: Erratum[] }).cards.map((e) => [e.name, e]),
);

/**
 * The card as this format plays it.
 *
 * Mana value is recomputed from the cost rather than carried over or restated, so a
 * cheaper Lier is a three drop everywhere at once — to the payment solver, to a Mana
 * Drain reading its mana value, and to the agent's hand ranking. Stating it twice is
 * how those three come to disagree.
 */
function withErrata(c: RawCard): RawCard {
  const e = errata.get(c.name);
  if (!e) return c;
  const next: RawCard = { ...c };
  if (e.mana_cost !== undefined) {
    next.mana_cost = e.mana_cost;
    next.cmc = manaValueOf(e.mana_cost);
  }
  if (e.oracle_text !== undefined) next.oracle_text = e.oracle_text;
  if (e.type_line !== undefined) next.type_line = e.type_line;
  if (e.power !== undefined) next.power = e.power;
  if (e.toughness !== undefined) next.toughness = e.toughness;
  return next;
}

const cards: Record<OracleId, OracleCard> = {};
const byName: Record<string, OracleCard> = {};

for (const c of (raw as { cards: RawCard[] }).cards) {
  const card = buildCard(withErrata(c));
  cards[card.oracleId] = card;
  byName[card.name.toLowerCase()] = card;
  // MDFCs are also addressable by their front face name alone.
  byName[card.name.split('//')[0].trim().toLowerCase()] = card;
}

/*
 * A name that matches nothing is a mistake, not a no-op.
 *
 * The failure mode this exists for is silent: rename a card upstream, or mistype an
 * apostrophe, and the erratum simply stops applying — the card goes back to its
 * printed cost and nothing anywhere says so. Better to refuse to start.
 */
const unmatched = [...errata.keys()].filter((name) => !byName[name.toLowerCase()]);
if (unmatched.length > 0) {
  throw new Error(`data/errata.json names cards that are not in the pool: ${unmatched.join(', ')}`);
}

/** The house changes, for anything that wants to show or check them. */
export const ERRATA: readonly Erratum[] = (ERRATA_DATA as { cards: Erratum[] }).cards;

/**
 * Why this card is not the card you remember, or null when it is.
 *
 * Worth showing rather than leaving people to notice: somebody who knows Eternal
 * Witness costs {1}{G}{G} and reads {2}{G} here has no way to tell a house rule
 * from a bug, and will reasonably assume the bug.
 */
export function errataFor(name: string): Erratum | null {
  return errata.get(name) ?? null;
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
