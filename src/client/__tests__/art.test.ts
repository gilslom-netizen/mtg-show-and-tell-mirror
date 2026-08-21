import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artUrl } from '../CardView';
import { parseManaSymbols } from '../mana';

/**
 * Art resolution and mana symbols — the two things that decide whether a card is
 * readable at a glance.
 *
 * The snapshot stores Scryfall's "normal" image, which is 488px wide: blurry the
 * moment a card is drawn at any useful size, and the reason the table looked like
 * mush. The other sizes live at a predictable path, so the client asks for them.
 */
describe('card art', () => {
  const uri =
    'https://cards.scryfall.io/normal/front/8/a/8a28c1e8-1969-40bc-a6fb-5494b88eb9ac.jpg?1783918541';

  it('swaps the size segment and keeps everything else', () => {
    expect(artUrl(uri, 'large')).toBe(
      'https://cards.scryfall.io/large/front/8/a/8a28c1e8-1969-40bc-a6fb-5494b88eb9ac.jpg?1783918541',
    );
    // png is the only one that is not a jpg.
    expect(artUrl(uri, 'png')).toBe(
      'https://cards.scryfall.io/png/front/8/a/8a28c1e8-1969-40bc-a6fb-5494b88eb9ac.png?1783918541',
    );
    expect(artUrl(uri, 'normal')).toBe(uri);
  });

  it('leaves anything it does not recognise alone', () => {
    for (const odd of ['', 'https://example.com/card.jpg', 'data:image/png;base64,AAAA']) {
      expect(artUrl(odd, 'large')).toBe(odd);
    }
  });

  it('rewrites every image in the card snapshot, including back faces', () => {
    const data = JSON.parse(
      readFileSync(join(process.cwd(), 'data', 'oracle-cards.json'), 'utf8'),
    ) as { cards: { image_uri?: string; card_faces?: { image_uri?: string }[] }[] };

    const uris = data.cards.flatMap((c) => [
      c.image_uri,
      ...(c.card_faces ?? []).map((f) => f.image_uri),
    ]);
    const found = uris.filter((u): u is string => Boolean(u));
    expect(found.length).toBeGreaterThan(20);
    for (const u of found) {
      const large = artUrl(u, 'large');
      expect(large, `${u} was not rewritten`).toContain('/large/');
      expect(large).not.toContain('/normal/');
    }
  });
});

describe('mana symbols', () => {
  it('reads a plain cost in printed order', () => {
    expect(parseManaSymbols('{3}{G}{W}{U}{B}').map((s) => s.label)).toEqual([
      '3',
      'G',
      'W',
      'U',
      'B',
    ]);
  });

  it('knows a generic pip from a coloured one', () => {
    const [generic, colour] = parseManaSymbols('{2}{U}');
    expect(generic.kind).toBe('generic');
    expect(generic.colours).toEqual([]);
    expect(colour.kind).toBe('colour');
    expect(colour.colours).toEqual(['U']);
  });

  it('splits hybrids and keeps both colours for the split circle', () => {
    const [h] = parseManaSymbols('{U/R}');
    expect(h.kind).toBe('hybrid');
    expect(h.colours).toEqual(['U', 'R']);

    // Generic/colour hybrids have one colour and a number.
    const [g] = parseManaSymbols('{2/U}');
    expect(g.kind).toBe('hybrid');
    expect(g.colours).toEqual(['U']);
  });

  it('marks Phyrexian symbols so they get the slash', () => {
    const [p] = parseManaSymbols('{G/P}');
    expect(p.kind).toBe('phyrexian');
    expect(p.colours).toEqual(['G']);
    expect(p.label).toBe('G');
  });

  it('handles X, no cost at all, and symbols it has never seen', () => {
    expect(parseManaSymbols('{X}{U}')[0].kind).toBe('generic');
    expect(parseManaSymbols(null)).toEqual([]);
    expect(parseManaSymbols('')).toEqual([]);
    expect(parseManaSymbols('{S}')[0].kind).toBe('other');
  });

  it('parses every cost in the deck without falling through to "other"', () => {
    const data = JSON.parse(
      readFileSync(join(process.cwd(), 'data', 'oracle-cards.json'), 'utf8'),
    ) as { cards: { mana_cost?: string; card_faces?: { mana_cost?: string }[] }[] };
    const costs = data.cards.flatMap((c) => [
      c.mana_cost,
      ...(c.card_faces ?? []).map((f) => f.mana_cost),
    ]);
    for (const cost of costs) {
      for (const sym of parseManaSymbols(cost ?? null)) {
        expect(sym.kind, `${cost} → ${sym.raw}`).not.toBe('other');
      }
    }
  });
});
