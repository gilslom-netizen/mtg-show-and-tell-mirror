import { decklistFilename, formatDecklist, parseDecklist } from '@engine/decklist';
import type { ParsedDecklist } from '@engine/decklist';
import type { DeckEntry } from '@engine/state';

/**
 * Getting a decklist out of the browser and back in.
 *
 * Three ways out, because "send it" means something different depending on
 * where you are: a file to keep, the clipboard to paste into a chat, and the
 * share sheet on a phone, where neither of the other two is any use. All three
 * carry the same text, which is the point — see `@engine/decklist`.
 */

/** How big a file will even be looked at. A decklist is a couple of KB. */
export const MAX_DECK_FILE_BYTES = 256 * 1024;

export function downloadText(filename: string, text: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // Firefox will not follow a click on an element that is not in the document.
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on the next tick: revoking it immediately races the download in
    // Safari, which has not finished reading the blob when click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** True when this browser can hand the list to another app — phones, mostly. */
export function canShareFiles(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/**
 * Hand the list to whatever the person picks — mail, a chat, their notes.
 *
 * Returns false when there is nothing to hand it to, or when the sheet was
 * dismissed, so the caller can fall back to a download rather than leaving
 * somebody looking at a button that did nothing.
 */
export async function shareDeck(filename: string, text: string): Promise<boolean> {
  if (!canShareFiles()) return false;
  try {
    const file = new File([text], filename, { type: 'text/plain' });
    // Not every browser with `share` will take a file; text always works.
    const asFile = { files: [file], title: filename };
    const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
    await navigator.share(nav.canShare?.(asFile) ? asFile : { title: filename, text });
    return true;
  } catch {
    // A dismissed share sheet throws AbortError, which is not a failure worth
    // reporting — the person changed their mind.
    return false;
  }
}

export function deckToText(entries: DeckEntry[], name?: string): string {
  return formatDecklist(entries, { name });
}

export function deckFilenameFor(name?: string): string {
  return decklistFilename(name || 'show-and-tell');
}

export interface LoadedDeck extends ParsedDecklist {
  /** What the file was called, which is the best guess at what the deck is called. */
  fileName: string;
}

/**
 * Read a decklist off a file the person picked.
 *
 * Rejects rather than resolves for the things that are not a decklist at all —
 * a video, an empty pick — so the caller has one place to say so. A file that
 * *is* text but has bad lines in it resolves: those are reported per line.
 */
export async function readDeckFile(file: File): Promise<LoadedDeck> {
  if (file.size > MAX_DECK_FILE_BYTES) {
    throw new Error(`${file.name} is too big to be a decklist`);
  }
  const text = await file.text();
  // A binary file read as text is mostly control characters; a decklist is not.
  // Written as codes rather than as an escape in a regex because that is the one
  // form of this test no editor, diff or copy-paste can quietly turn into a
  // literal NUL byte in the source.
  const head = text.slice(0, 4096);
  for (let k = 0; k < head.length; k++) {
    const code = head.charCodeAt(k);
    // Everything below space except tab, newline and carriage return.
    if (code < 9 || (code > 13 && code < 32)) {
      throw new Error(`${file.name} does not look like a decklist`);
    }
  }
  const parsed = parseDecklist(text);
  return {
    ...parsed,
    fileName: file.name,
    name: parsed.name ?? file.name.replace(/\.[a-z0-9]+$/i, '') ?? null,
  };
}

/** The smallest list a game can be dealt from. Matches the server's own rule. */
export const MIN_PLAYABLE_DECK = 60;

export interface DeckReadiness {
  size: number;
  /** How many cards short of a legal deck, or 0. */
  short: number;
  /** Cards in the list the engine has no script for, by name. */
  unplayable: string[];
}

/**
 * Whether a loaded list is one a game can actually be dealt from.
 *
 * The size check is the hard one — a forty-card deck decks out on turn five and
 * looks like a bug. The unplayable list is a warning rather than a refusal: the
 * card pool is wider than the set of cards the engine can cast, and somebody
 * testing a list should be told which ones will sit in hand doing nothing
 * rather than have the list rejected.
 */
export function deckReadiness(
  entries: DeckEntry[],
  hasScript: (oracleId: string) => boolean,
  nameOf: (oracleId: string) => string,
): DeckReadiness {
  const size = entries.reduce((n, e) => n + e.count, 0);
  return {
    size,
    short: Math.max(0, MIN_PLAYABLE_DECK - size),
    unplayable: entries.filter((e) => !hasScript(e.oracleId)).map((e) => nameOf(e.oracleId)),
  };
}

/** A short line for the toast, or null when the list read cleanly. */
export function describeProblems(parsed: ParsedDecklist): string | null {
  const bits: string[] = [];
  if (parsed.problems.length > 0) {
    const first = parsed.problems[0];
    bits.push(
      parsed.problems.length === 1
        ? `Line ${first.line}: ${first.reason}`
        : `${parsed.problems.length} lines could not be read — line ${first.line}: ${first.reason}`,
    );
  }
  if (parsed.ignoredSideboard > 0) {
    bits.push(`${parsed.ignoredSideboard} sideboard cards were left out; this format has no sideboard.`);
  }
  return bits.length > 0 ? bits.join(' ') : null;
}
