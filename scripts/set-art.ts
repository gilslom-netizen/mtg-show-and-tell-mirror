import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Points each card at a specific real printing, chosen for its art.
 *
 * data/oracle-cards.json normally holds whichever printing Scryfall calls
 * "preferred" for a name (see sync-cards.ts). This script re-points the art —
 * and only the art — at the printings named in data/printings.json, fetched by
 * exact set + collector number so there is no ambiguity about which one.
 *
 * Rules text, mana cost, type line and keywords are left as they already were:
 * a reprint's oracle text should be identical, and if it is not, that is either
 * an errata worth knowing about deliberately or the wrong collector number. This
 * script fails loudly on either rather than silently absorbing a text change
 * while "just" swapping art.
 *
 *   npm run set:art          # report differences, write nothing
 *   npm run set:art -- --write
 */

const ROOT = process.cwd();
const DATA = join(ROOT, 'data', 'oracle-cards.json');
const PRINTINGS = join(ROOT, 'data', 'printings.json');
const API = 'https://api.scryfall.com/cards/collection';

type Json = Record<string, unknown>;

interface Printing {
  set: string;
  collector_number: string;
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const { printings } = JSON.parse(readFileSync(PRINTINGS, 'utf8')) as {
    printings: Record<string, Printing>;
  };
  const current = JSON.parse(readFileSync(DATA, 'utf8')) as { cards: Json[] };
  const byName = new Map(current.cards.map((c) => [String(c.name), c]));

  const names = Object.keys(printings);
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    throw new Error(`In printings.json but not in oracle-cards.json: ${missing.join(', ')}`);
  }

  const identifiers = names.map((name) => ({
    set: printings[name].set,
    collector_number: printings[name].collector_number,
  }));

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'show-and-tell-mirror/1.0',
    },
    body: JSON.stringify({ identifiers }),
  });
  if (!res.ok) throw new Error(`Scryfall returned ${res.status}`);
  const json = (await res.json()) as { data: Json[]; not_found: Json[] };
  if (json.not_found.length > 0) {
    throw new Error(
      `Scryfall could not find these printings: ${JSON.stringify(json.not_found)}`,
    );
  }

  // Match fetched prints back to names by (set, collector_number) — the identity
  // Scryfall was actually asked for, not by name (a set can print the same name
  // twice, e.g. a promo and the normal card share nothing else in common).
  const byPrint = new Map(
    json.data.map((c) => [`${String(c.set)}/${String(c.collector_number)}`, c]),
  );

  const changes: string[] = [];
  const errors: string[] = [];

  for (const name of names) {
    const wanted = printings[name];
    const fresh = byPrint.get(`${wanted.set}/${wanted.collector_number}`);
    if (!fresh) {
      errors.push(`No fetched data for ${name} (${wanted.set} #${wanted.collector_number})`);
      continue;
    }
    if (String(fresh.name) !== name) {
      errors.push(
        `${wanted.set} #${wanted.collector_number} is "${fresh.name}", not "${name}" — wrong collector number.`,
      );
      continue;
    }

    const existing = byName.get(name)!;
    // The fields the rules engine reads must not silently change underneath a
    // pure art swap — a mismatch here means either errata or a bad identifier.
    for (const field of ['oracle_text', 'type_line', 'mana_cost', 'keywords'] as const) {
      const before = JSON.stringify(existing[field]);
      const after = JSON.stringify(
        (fresh as Json)[field] ??
          ((fresh.card_faces as Json[] | undefined)?.[0] as Json | undefined)?.[field],
      );
      // Split cards / MDFCs keep these at the face level; only compare when the
      // reprint actually carries the field at the top level like the original did.
      if (existing[field] !== undefined && (fresh as Json)[field] !== undefined && before !== after) {
        errors.push(
          `${name} · ${field} differs between the stored oracle text and ${wanted.set} #${wanted.collector_number}:\n    was: ${before}\n    now: ${after}`,
        );
      }
    }

    const newImage =
      ((fresh.image_uris as Json | undefined)?.normal as string | undefined) ??
      (((fresh.card_faces as Json[] | undefined)?.[0]?.image_uris as Json | undefined)
        ?.normal as string | undefined) ??
      null;
    const newFaces = (fresh.card_faces as Json[] | undefined)?.map((f) => ({
      image_uri: ((f.image_uris as Json | undefined)?.normal as string | undefined) ?? null,
    }));

    const oldImage = existing.image_uri as string | null | undefined;
    if (oldImage !== newImage) {
      changes.push(`${name}: art → ${wanted.set.toUpperCase()} #${wanted.collector_number}`);
    }

    // Only the art moves. Which printing supplies it lives in printings.json,
    // not duplicated here — oracle-cards.json keeps the shape sync-cards.ts
    // already produces.
    existing.image_uri = newImage;
    if (newFaces && Array.isArray(existing.card_faces)) {
      const faces = existing.card_faces as Json[];
      newFaces.forEach((f, i) => {
        if (faces[i]) faces[i].image_uri = f.image_uri;
      });
    }
  }

  if (errors.length > 0) {
    console.log(`${errors.length} problem(s):\n`);
    for (const e of errors) console.log(e);
    console.log('\nNothing written. Fix the printing or the stored text, then re-run.');
    process.exitCode = 1;
    return;
  }

  if (changes.length === 0) {
    console.log('Every card already points at its chosen printing.');
    return;
  }

  console.log(`${changes.length} art change(s):\n`);
  for (const c of changes) console.log(c);

  if (!write) {
    console.log('\nNothing written. Re-run with --write to apply.');
    return;
  }

  writeFileSync(DATA, JSON.stringify(current, null, 2) + '\n');
  console.log(`\nWrote ${DATA}.`);
  execFileSync('node', [join(ROOT, 'scripts', 'gen-data.mjs')], { stdio: 'inherit' });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
