/**
 * Room codes, generated rather than left to chance.
 *
 * The lobby used to invent a code only when the box was left empty — so two
 * players who both left it empty got two different codes and waited for each other
 * in two different rooms, with nothing on screen to say so. A code now exists
 * before anyone clicks anything, and it normalises exactly the way the server's
 * `normaliseCode` does, so what a player reads out is what their opponent joins.
 */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no O/0, no I/1

export function randomRoomCode(len = 5): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function normaliseRoomCode(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 12);
}

export function inviteLink(code: string): string {
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
}

/** The code from an invite link, if this tab was opened from one. */
export function roomFromUrl(search = location.search): string | null {
  try {
    return normaliseRoomCode(new URLSearchParams(search).get('room') ?? '') || null;
  } catch {
    return null;
  }
}
