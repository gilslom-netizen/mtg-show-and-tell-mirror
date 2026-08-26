import { execFileSync } from 'node:child_process';
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
 *
 * House changes to cards live in data/errata.json, deliberately not here: this file
 * stays exactly what Wizards printed, so a diff against Scryfall means Wizards moved
 * something rather than that we did. The errata are applied on top when the oracle
 * index is built, which is also why a re-sync never quietly undoes one.
 *
 * This always pulls whichever printing Scryfall calls "preferred" for a name —
 * usually the most recent one — including its art. data/printings.json pins a
 * specific printing per card for its art instead (see scripts/set-art.ts), so
 * after a text sync re-run `npm run set:art -- --write` to put the chosen art
 * back; sync:cards has no idea printings.json exists.
 */

const ROOT = process.cwd();
const DATA = join(ROOT, 'data', 'oracle-cards.json');
const DECK = join(ROOT, 'data', 'decklist.json');
const DRAFT = join(ROOT, 'data', 'draft.json');
const API = 'https://api.scryfall.com/cards/collection';
const KEEP = [
  'name',
  'mana_cost',
  'cmc',
  'type_line',
  'oracle_text',
  'power',
  'toughness',
  'loyalty',
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
  const draft = JSON.parse(readFileSync(DRAFT, 'utf8')) as {
    pool: string[];
    grantedLands: { name: string }[];
  };
  // One snapshot covers everything the app can ever show: the shared main deck,
  // the draft pool, and the lands every drafter is handed. Splitting these into
  // separate snapshots would only create a way for them to disagree.
  const names = [
    ...new Set([
      ...deck.maindeck.map((c) => c.name),
      ...draft.pool,
      ...draft.grantedLands.map((l) => l.name),
    ]),
  ];

  // Scryfall's collection endpoint takes at most 75 identifiers per request.
  const batches: string[][] = [];
  for (let i = 0; i < names.length; i += 70) batches.push(names.slice(i, i + 70));

  const found: Json[] = [];
  const notFound: Json[] = [];
  for (const batch of batches) {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'show-and-tell-mirror/1.0',
      },
      body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }),
    });
    if (!res.ok) throw new Error(`Scryfall returned ${res.status}`);
    const json = (await res.json()) as { data: Json[]; not_found: Json[] };
    found.push(...json.data);
    notFound.push(...json.not_found);
  }
  if (notFound.length > 0) {
    throw new Error(`Scryfall could not find: ${JSON.stringify(notFound)}`);
  }

  const fresh = found
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
  // The engine imports the generated TypeScript, not the JSON — see
  // scripts/gen-data.mjs for why — so a data change is only half applied until
  // that is regenerated.
  execFileSync('node', [join(ROOT, 'scripts', 'gen-data.mjs')], { stdio: 'inherit' });
  console.log(`\nWrote ${fresh.length} cards to ${DATA}. Run the test suite now.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
