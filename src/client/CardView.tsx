import { memo, useState } from 'react';
import { faceOf, oracle } from '@engine/oracle';
import type { CardView as CardData } from '@engine/redact';
import type { OracleFace, PlayerId } from '@engine/types';
import { useStore } from './store';

/**
 * One card. Used everywhere — battlefield, hand, dialogs, previews — so that a card
 * always looks the same and the eye can track it between zones.
 */

export interface CardProps {
  card: CardData | null;
  /** Seat of the viewer, so we can colour "mine" vs "theirs". */
  viewer: PlayerId;
  onClick?: () => void;
  selected?: boolean;
  selectionIndex?: number;
  disabledReason?: string;
  /** Casting affordance: this card can be cast right now. */
  castable?: boolean;
  /** Under an Omniscience. */
  free?: boolean;
  size?: 'normal' | 'small' | 'large';
  className?: string;
}

/**
 * Card art comes from Scryfall's CDN. It is probed once at startup rather than
 * per card: if it is unreachable — offline, a blocked network, a strict proxy —
 * the whole app switches to rendered text cards instead of leaving sixty blank
 * rectangles on the table and firing sixty doomed requests.
 */
const failedArt = new Set<string>();

function noteArtFailure(uri: string): void {
  failedArt.add(uri);
}

/** Resolves false when Scryfall art cannot be reached within the timeout. */
export function probeCardArt(timeoutMs = 3500): Promise<boolean> {
  const probe = oracle('island').imageUri;
  if (!probe) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok: boolean) => {
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      done(true);
    };
    img.onerror = () => {
      clearTimeout(timer);
      done(false);
    };
    img.src = probe;
  });
}

export function faceOfCard(card: CardData): OracleFace {
  if (card.isToken) {
    return {
      name: card.tokenName ?? 'Token',
      manaCost: null,
      mv: 0,
      typeLine: 'Token Creature',
      types: ['Creature'],
      subtypes: [],
      supertypes: [],
      colors: [],
      oracleText: '',
      power: String(card.power ?? 0),
      toughness: String(card.toughness ?? 0),
      keywords: [],
      producedMana: [],
      imageUri: null,
    };
  }
  return faceOf(card.oracleId, card.face);
}

/** Renders a mana cost string as coloured pips. */
export function ManaCost({ cost }: { cost: string | null }) {
  if (!cost) return null;
  const symbols = [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  return (
    <>
      {symbols.map((s, i) => {
        const isNumber = /^\d+$/.test(s);
        const colorClass = isNumber ? 'C' : (s.split('/').pop() ?? 'C');
        return (
          <span key={i} className={`pip ${colorClass}`} title={`{${s}}`}>
            {isNumber ? s : s.replace('/', '')}
          </span>
        );
      })}
    </>
  );
}

function costLabel(face: OracleFace): string {
  if (!face.manaCost) return '';
  return face.manaCost.replace(/[{}]/g, '');
}

export const CardFace = memo(function CardFace({
  card,
  viewer,
  onClick,
  selected,
  selectionIndex,
  disabledReason,
  castable,
  free,
  size = 'normal',
  className = '',
}: CardProps) {
  const showArt = useStore((s) => s.settings.showCardArt && s.artAvailable === true);
  const hovered = useStore((s) => s.hoveredIid);
  const highlight = useStore((s) => s.highlightIids);
  const setHovered = useStore((s) => s.setHovered);
  const [artBroken, setArtBroken] = useState(false);

  if (!card) {
    return <div className={`card facedown ${className}`} aria-hidden />;
  }

  const face = faceOfCard(card);
  const isMine = card.controller === viewer;
  const seat = isMine ? 'seat-mine' : 'seat-theirs';
  const counters = card.counters['+1/+1'] ?? 0;
  const style =
    size === 'small'
      ? ({ '--card-w': '66px', '--card-h': '92px' } as React.CSSProperties)
      : size === 'large'
        ? ({ '--card-w': '150px', '--card-h': '209px' } as React.CSSProperties)
        : undefined;

  const classes = [
    'card',
    seat,
    className,
    card.tapped ? 'tapped' : '',
    onClick && !disabledReason ? 'clickable' : '',
    disabledReason ? 'dimmed' : '',
    selected ? 'selected' : '',
    highlight.includes(card.iid) || hovered === card.iid ? 'highlight' : '',
    castable ? 'castable' : '',
    free ? 'free' : '',
    card.attacking ? 'attacking' : '',
    card.summoningSick && card.zone === 'battlefield' ? 'summoning-sick' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      style={style}
      onClick={disabledReason ? undefined : onClick}
      onMouseEnter={() => setHovered(card.iid)}
      onMouseLeave={() => setHovered(null)}
      title={face.name}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick && !disabledReason ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && !disabledReason && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {showArt && face.imageUri && !card.isToken && !artBroken && !failedArt.has(face.imageUri) ? (
        <img
          className="card-art"
          src={face.imageUri}
          alt={face.name}
          onError={() => {
            noteArtFailure(face.imageUri!);
            setArtBroken(true);
          }}
        />
      ) : (
        <div className="card-text">
          <div className="name">{face.name}</div>
          <div className="type">{face.typeLine}</div>
          <div className="body">{face.oracleText}</div>
        </div>
      )}

      {selectionIndex !== undefined && <div className="order-badge">{selectionIndex + 1}</div>}

      {free ? (
        <span className="card-badge cost is-free">FREE</span>
      ) : (
        face.manaCost && <span className="card-badge cost">{costLabel(face)}</span>
      )}

      {face.power !== null && (
        <span className="card-badge pt">
          {card.power ?? face.power}/{card.toughness ?? face.toughness}
        </span>
      )}
      {counters > 0 && <span className="card-badge counters">+{counters}</span>}
      {card.damage > 0 && <span className="card-badge damage">{card.damage}</span>}

      {disabledReason && <div className="card-disabled-reason">{disabledReason}</div>}
    </div>
  );
});

/** The large hover preview, pinned so it never jumps around under the pointer. */
export function CardPreview({ viewer }: { viewer: PlayerId }) {
  const hovered = useStore((s) => s.hoveredIid);
  const view = useStore((s) => s.views[viewer]);
  const showArt = useStore((s) => s.settings.showCardArt && s.artAvailable === true);
  if (!hovered || !view) return null;
  const card = view.cards[hovered];
  if (!card) return null;
  const face = faceOfCard(card);
  const full = card.isToken ? null : oracle(card.oracleId);

  return (
    <div className="preview">
      {showArt && face.imageUri && !failedArt.has(face.imageUri) && (
        <img src={face.imageUri} alt={face.name} onError={() => noteArtFailure(face.imageUri!)} />
      )}
      <div className="preview-text">
        <h4>{face.name}</h4>
        <div className="type">
          {face.typeLine}
          {face.manaCost ? ` · ${face.manaCost}` : ''}
        </div>
        <div className="oracle">{face.oracleText}</div>
        {full?.layout === 'modal_dfc' && (
          <div className="oracle" style={{ marginTop: 8, opacity: 0.75 }}>
            ── {full.faces![1].name} ──{'\n'}
            {full.faces![1].oracleText}
          </div>
        )}
      </div>
    </div>
  );
}
