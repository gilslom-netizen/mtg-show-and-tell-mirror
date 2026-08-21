import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Refreshes data/oracle-cards.json from Scryfall.
 *
 * Card text is never typed by hand in this repo, so this script is the only way
 * card data changes. It is deliberately loud: if Wizards errata a card, the run
 * fails and names what moved, because an oracle change can quietly invalidate a
 * rules test (the Orcish Bowmasters draw exception, say, or a land type).
 *
 *   npm run sync:cards          # report differences, write nothing
 *   npm run sync:cards -- --write
 */

const ROOT = process.cwd();
const DATA = join(ROOT, 'data', 'oracle-cards.json');
const DECK = join(ROOT, 'data', 'decklist.json');
const API = 'https://api.scryfall.com/cards/collection';
const KEEP = [
  'name',
  'mana_cost',
  'cmc',
  'type_line',
  'oracle_text',
  'power',
  'toughness',
  'colors',
  'color_identity',
  'keywords',
  'produced_mana',
  'layout',
  'legalities',
  'scryfall_uri',
  'oracle_id',
] as const;

type Json = Record<string, unknown>;

function pick(src: Json): Json {
  const out: Json = {};
  for (const k of KEEP) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

function shape(card: Json): Json {
  const out = pick(card);
  const faces = card.card_faces as Json[] | undefined;
  if (faces) {
    out.card_faces = faces.map((f) => ({
      ...pick(f),
      image_uri: (f.image_uris as Json | undefined)?.normal ?? null,
    }));
  }
  out.image_uri =
    ((card.image_uris as Json | undefined)?.normal as string | undefined) ??
    ((faces?.[0]?.image_uris as Json | undefined)?.normal as string | undefined) ??
    null;
  return out;
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const deck = JSON.parse(readFileSync(DECK, 'utf8')) as {
    maindeck: { name: string }[];
  };
  const names = [...new Set(deck.maindeck.map((c) => c.name))];

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'show-and-tell-mirror/1.0',
    },
    body: JSON.stringify({ identifiers: names.map((name) => ({ name })) }),
  });
  if (!res.ok) throw new Error(`Scryfall returned ${res.status}`);
  const json = (await res.json()) as { data: Json[]; not_found: Json[] };
  if (json.not_found.length > 0) {
    throw new Error(`Scryfall could not find: ${JSON.stringify(json.not_found)}`);
  }

  const fresh = json.data
    .map(shape)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const current = JSON.parse(readFileSync(DATA, 'utf8')) as { cards: Json[] };

  const before = new Map(current.cards.map((c) => [String(c.name), c]));
  const changes: string[] = [];
  for (const card of fresh) {
    const old = before.get(String(card.name));
    if (!old) {
      changes.push(`NEW      ${card.name}`);
      continue;
    }
    // Only the fields the rules engine reads are worth failing over.
    for (const field of ['oracle_text', 'type_line', 'mana_cost', 'cmc', 'keywords'] as const) {
      if (JSON.stringify(old[field]) !== JSON.stringify(card[field])) {
        changes.push(`CHANGED  ${card.name} · ${field}\n    was: ${JSON.stringify(old[field])}\n    now: ${JSON.stringify(card[field])}`);
      }
    }
  }

  if (changes.length === 0) {
    console.log(`Up to date — ${fresh.length} cards match Scryfall.`);
    return;
  }

  console.log(`${changes.length} difference(s) against Scryfall:\n`);
  for (const c of changes) console.log(c);

  if (!write) {
    console.log('\nNothing written. Re-run with --write once the rules tests have been');
    console.log('checked against these changes.');
    process.exitCode = 1;
    return;
  }

  writeFileSync(
    DATA,
    JSON.stringify(
      { source: 'scryfall.com/cards/collection', fetched: new Date().toISOString().slice(0, 10), cards: fresh },
      null,
      2,
    ) + '\n',
  );
  console.log(`\nWrote ${fresh.length} cards to ${DATA}. Run the test suite now.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
