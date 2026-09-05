import { errataFor, frontFace, oracle, oracleByName } from './oracle.js';
import type { DeckEntry } from './state.js';
import type { OracleId } from './types.js';

/**
 * Reading and writing a decklist as text.
 *
 * The format is the one every Magic player already has: a count and a name per
 * line. That is deliberate — a list exported from here pastes into Moxfield,
 * Arena or an email to the person you are about to play, and a list written
 * anywhere else pastes back in. Inventing a private JSON shape would have made
 * "send it to a friend" mean "send it to a friend who runs this app".
 *
 * Reading is deliberately forgiving, because the lists people actually have are
 * messy: Arena writes `4 Ancient Tomb (LEA) 233`, MTGO writes `SB: 2 Force of
 * Will`, sites emit `4x` and `//` comment headers, and Windows sends CRLF. All
 * of those mean the same deck, so all of them are read as it.
 */

export interface DecklistProblem {
  /** 1-based, so it matches what the person sees in their editor. */
  line: number;
  text: string;
  reason: string;
}

export interface ParsedDecklist {
  entries: DeckEntry[];
  /** The name off a `Name:` or `// Name:` header, when the file carried one. */
  name: string | null;
  /** Lines that could not be read. The rest of the list is still returned. */
  problems: DecklistProblem[];
  /** Cards found under a sideboard heading, which this format has no use for. */
  ignoredSideboard: number;
}

/**
 * Guards against a file that is not really a decklist.
 *
 * A count is a loop bound the moment the deck is dealt, so `9999999 Island` is
 * not a strange deck, it is a hung tab. The caps sit far above any real list and
 * far below anything that costs somebody their browser.
 */
export const MAX_LINES = 2000;
export const MAX_COPIES = 99;
export const MAX_DECK_CARDS = 250;

/** Arena and MTGO annotate lines with the printing; the card is the same card. */
function stripPrinting(name: string): string {
  return name
    .replace(/\s*\([A-Za-z0-9_]{2,6}\)\s*\d*\s*$/, '')
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .trim();
}

const SECTION_HEADINGS = /^(deck|maindeck|main deck|main|companion|commander)$/i;
const SIDEBOARD_HEADINGS = /^(sideboard|side board|bench|maybeboard)$/i;

/**
 * Read a decklist.
 *
 * Never throws: a list with one unreadable line is still a list, and the caller
 * gets both the cards that were understood and the lines that were not, so it
 * can say which is which instead of refusing the whole file.
 */
export function parseDecklist(text: string): ParsedDecklist {
  const counts = new Map<OracleId, number>();
  const problems: DecklistProblem[] = [];
  let name: string | null = null;
  let ignoredSideboard = 0;
  let inSideboard = false;
  let total = 0;

  // A byte order mark is invisible in an editor and would otherwise attach
  // itself to the first card's count.
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  if (lines.length > MAX_LINES) {
    problems.push({
      line: MAX_LINES + 1,
      text: '',
      reason: `Only the first ${MAX_LINES} lines were read`,
    });
  }

  lines.slice(0, MAX_LINES).forEach((raw, i) => {
    const lineNo = i + 1;
    let line = raw.trim();
    if (line === '') return;

    // Comments, including the name our own exports write into one.
    if (line.startsWith('//') || line.startsWith('#')) {
      const comment = line.replace(/^(\/\/|#)\s*/, '');
      const titled = /^(?:name|deck)\s*:\s*(.+)$/i.exec(comment);
      if (titled && name === null) name = titled[1].trim();
      return;
    }
    const titled = /^(?:name|deck name)\s*:\s*(.+)$/i.exec(line);
    if (titled) {
      if (name === null) name = titled[1].trim();
      return;
    }

    if (SECTION_HEADINGS.test(line)) {
      inSideboard = false;
      return;
    }
    if (SIDEBOARD_HEADINGS.test(line)) {
      inSideboard = true;
      return;
    }
    // MTGO marks each sideboard line rather than heading a section.
    if (/^SB:\s*/i.test(line)) {
      line = line.replace(/^SB:\s*/i, '');
      const marked = /^(\d+)\s*[xX]?\s+/.exec(line);
      ignoredSideboard += marked ? Number(marked[1]) : 1;
      return;
    }

    const m = /^(\d+)\s*[xX]?\s+(.+)$/.exec(line);
    const count = m ? Number(m[1]) : 1;
    const cardName = stripPrinting(m ? m[2] : line);
    if (cardName === '') {
      problems.push({ line: lineNo, text: raw, reason: 'No card name on this line' });
      return;
    }

    let card;
    try {
      card = oracleByName(cardName);
    } catch {
      problems.push({
        line: lineNo,
        text: raw,
        reason: `"${cardName}" is not a card this game knows`,
      });
      return;
    }

    // Counted only once the card is known, so a typo in the sideboard is still
    // reported as a typo rather than silently swallowed by the section.
    if (inSideboard) {
      ignoredSideboard += count;
      return;
    }

    if (count < 1) {
      problems.push({ line: lineNo, text: raw, reason: 'That is not a number of copies' });
      return;
    }
    if (count > MAX_COPIES) {
      problems.push({
        line: lineNo,
        text: raw,
        reason: `${count} copies is more than a deck can hold`,
      });
      return;
    }
    if (total + count > MAX_DECK_CARDS) {
      problems.push({ line: lineNo, text: raw, reason: `A deck stops at ${MAX_DECK_CARDS} cards` });
      return;
    }

    total += count;
    counts.set(card.oracleId, (counts.get(card.oracleId) ?? 0) + count);
  });

  return {
    entries: [...counts].map(([oracleId, count]) => ({ oracleId, count })),
    name,
    problems,
    ignoredSideboard,
  };
}

export function deckSize(entries: DeckEntry[]): number {
  return entries.reduce((n, e) => n + e.count, 0);
}

/** Lands last, then by mana value, then by name — how a list is normally written. */
function writeOrder(a: DeckEntry, b: DeckEntry): number {
  const fa = frontFace(a.oracleId);
  const fb = frontFace(b.oracleId);
  const la = fa.types.includes('Land') ? 1 : 0;
  const lb = fb.types.includes('Land') ? 1 : 0;
  if (la !== lb) return la - lb;
  if (fa.mv !== fb.mv) return fa.mv - fb.mv;
  return fa.name.localeCompare(fb.name);
}

/**
 * Write a decklist out.
 *
 * The house changes go in as comments. A list that leaves this app is going to
 * be read somewhere that has never heard of them, and "Eternal Witness for
 * {2}{G}" is exactly the sort of difference that turns into an argument two
 * turns into a game — so the file says so itself rather than trusting that both
 * people read the same screen.
 */
export function formatDecklist(entries: DeckEntry[], opts: { name?: string } = {}): string {
  const sorted = [...entries].filter((e) => e.count > 0).sort(writeOrder);
  const out: string[] = [];
  out.push(`// Name: ${opts.name?.trim() || 'Show and Tell'}`);
  out.push(`// ${deckSize(sorted)} cards`);

  const housed = sorted.filter((e) => errataFor(oracle(e.oracleId).name));
  if (housed.length > 0) {
    out.push('//');
    out.push('// House changes in this list — these are not quite the printed cards:');
    for (const e of housed) {
      const card = oracle(e.oracleId);
      out.push(`//   ${card.name} — ${errataFor(card.name)!.why}`);
    }
  }

  out.push('');
  for (const e of sorted) out.push(`${e.count} ${oracle(e.oracleId).name}`);
  return out.join('\n') + '\n';
}

/** A filename that says which deck it is and sorts by date in a folder. */
export function decklistFilename(name = 'show-and-tell', at = new Date()): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'deck';
  return `${slug}-${at.toISOString().slice(0, 10)}.txt`;
}
