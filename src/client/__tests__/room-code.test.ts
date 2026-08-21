import { describe, expect, it } from 'vitest';
import { normaliseCode } from '../../server/room';
import { normaliseRoomCode, randomRoomCode, roomFromUrl } from '../room-code';

/**
 * The bug this file exists for: two players opened the game, both left the room
 * box empty, and each tab quietly generated its own code. They then waited for
 * each other in two different rooms with no way to tell.
 */
describe('room codes', () => {
  it('generates a code that survives the server’s normalisation untouched', () => {
    for (let i = 0; i < 500; i++) {
      const code = randomRoomCode();
      expect(code).toHaveLength(5);
      expect(normaliseCode(code)).toBe(code);
      expect(normaliseRoomCode(code)).toBe(code);
    }
  });

  it('avoids the characters people mishear when reading a code aloud', () => {
    const generated = new Set(Array.from({ length: 800 }, () => randomRoomCode()).join(''));
    for (const ambiguous of ['O', '0', 'I', '1', 'L']) {
      expect(generated.has(ambiguous)).toBe(false);
    }
  });

  it('normalises exactly the way the server does, so both players land together', () => {
    for (const raw of [' abc12 ', 'ab c12', 'AbC12', 'abc-12', 'abc_12', 'abc!12', '']) {
      expect(normaliseRoomCode(raw)).toBe(normaliseCode(raw));
    }
  });

  it('reads the code out of an invite link', () => {
    expect(roomFromUrl('?room=mthap')).toBe('MTHAP');
    expect(roomFromUrl('?room=MTHAP&x=1')).toBe('MTHAP');
    expect(roomFromUrl('')).toBe(null);
    expect(roomFromUrl('?room=')).toBe(null);
    expect(roomFromUrl('?room=!!!')).toBe(null);
  });
});
