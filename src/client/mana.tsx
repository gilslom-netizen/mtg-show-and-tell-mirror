import { memo } from 'react';

/**
 * Mana symbols.
 *
 * Magic's costs are read at a glance, not parsed — the shape and colour of the
 * pips carry the meaning, and a row of plain letters makes every card in a hand
 * look the same. So every symbol the deck can produce is drawn properly: coloured
 * pips, split circles for hybrids, the Phyrexian slash, and a neutral pip for
 * generic. The letter stays inside as a label, which is also what keeps it
 * readable for anyone who cannot separate the colours.
 */

const COLOURS = new Set(['W', 'U', 'B', 'R', 'G', 'C']);

export interface ManaSymbol {
  /** The raw symbol between the braces, e.g. "2", "U", "U/R", "G/P". */
  raw: string;
  kind: 'generic' | 'colour' | 'hybrid' | 'phyrexian' | 'other';
  /** One or two colour letters, for tinting. */
  colours: string[];
  /** What is printed inside the pip. */
  label: string;
}

export function parseManaSymbols(cost: string | null): ManaSymbol[] {
  if (!cost) return [];
  return [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => classify(m[1]));
}

function classify(raw: string): ManaSymbol {
  const parts = raw.split('/');

  if (parts.length === 2 && parts[1] === 'P') {
    // Phyrexian: pay the colour or two life.
    return { raw, kind: 'phyrexian', colours: [parts[0]], label: parts[0] };
  }
  if (parts.length === 2) {
    // Hybrid, either colour/colour or generic/colour.
    const colours = parts.filter((p) => COLOURS.has(p));
    return { raw, kind: 'hybrid', colours, label: parts.join('') };
  }
  if (/^\d+$/.test(raw) || raw === 'X' || raw === 'Y' || raw === 'Z') {
    return { raw, kind: 'generic', colours: [], label: raw };
  }
  if (COLOURS.has(raw)) {
    return { raw, kind: 'colour', colours: [raw], label: raw };
  }
  // {S}, {T}, {Q} and anything new.
  return { raw, kind: 'other', colours: [], label: raw };
}

/** A single pip. Exported so the log and the mana pool can use one too. */
export const Pip = memo(function Pip({ symbol }: { symbol: ManaSymbol }) {
  const [a, b] = symbol.colours;
  const classes = ['pip', `pip-${symbol.kind}`, a ? `c-${a}` : 'c-N', b ? `c2-${b}` : '']
    .filter(Boolean)
    .join(' ');

  // A hybrid is printed as two halves, each with its own symbol. Cramming "UR"
  // into one circle is unreadable at any size the table can spare, so the two
  // sides get their own labels across the diagonal, exactly as on the card.
  const halves = symbol.kind === 'hybrid' ? symbol.raw.split('/') : null;

  return (
    <span className={classes} title={`{${symbol.raw}}`} aria-label={`{${symbol.raw}}`}>
      {halves ? (
        <>
          <span className="pip-half is-first">{halves[0]}</span>
          <span className="pip-half is-second">{halves[1]}</span>
        </>
      ) : (
        <span className="pip-label">{symbol.label}</span>
      )}
    </span>
  );
});

/** A whole mana cost, in printed order. */
export function ManaCost({
  cost,
  size = 'normal',
  className = '',
}: {
  cost: string | null;
  size?: 'small' | 'normal' | 'large';
  className?: string;
}) {
  const symbols = parseManaSymbols(cost);
  if (symbols.length === 0) return null;
  return (
    <span className={`mana-cost is-${size} ${className}`.trim()}>
      {symbols.map((s, i) => (
        <Pip key={i} symbol={s} />
      ))}
    </span>
  );
}
