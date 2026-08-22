import { memo, useState } from 'react';
import { faceOf, oracle } from '@engine/oracle';
import type { CardView as CardData } from '@engine/redact';
import type { OracleFace, PlayerId } from '@engine/types';
import { ManaCost } from './mana';
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

/**
 * Scryfall serves the same card at several resolutions under a predictable path,
 * so the frozen snapshot only has to store one of them.
 *
 *   https://cards.scryfall.io/normal/front/8/a/<id>.jpg
 *   https://cards.scryfall.io/large/front/8/a/<id>.jpg
 *   https://cards.scryfall.io/png/front/8/a/<id>.png
 *
 * "normal" is 488px wide, which is a blurry mess on a modern display once a card
 * is drawn at any useful size — the reason nothing on the table was readable.
 * "large" is 672px and "png" is 745px with real transparency, which is what the
 * hover preview deserves. Anything unrecognised is passed through untouched.
 */
export type ArtSize = 'normal' | 'large' | 'png';

export function artUrl(uri: string, size: ArtSize): string {
  const m = /^(https:\/\/cards\.scryfall\.io\/)(normal|large|png|small|art_crop|border_crop)(\/.+?)(\.jpg|\.png)(\?.*)?$/.exec(
    uri,
  );
  if (!m) return uri;
  const ext = size === 'png' ? '.png' : '.jpg';
  return `${m[1]}${size}${m[3]}${ext}${m[5] ?? ''}`;
}

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
        // Used for the opening hand and other single-card decisions — the
        // size a player leans in to actually read, so it gets the size that
        // measured as genuinely crisp rather than just less-blurry.
        ? ({ '--card-w': '190px', '--card-h': '265px' } as React.CSSProperties)
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
          // 'png' is the highest resolution Scryfall serves (745px, real
          // transparency) — the same one the hover preview already used. It is
          // a much bigger download than 'large' (roughly 8x), which is fine
          // once cached but costs something the instant many permanents enter
          // at once (Show and Tell, a big Omniscience turn); loading="lazy"
          // below is what keeps that cost off cards not actually on screen.
          src={artUrl(face.imageUri, 'png')}
          alt={face.name}
          loading="lazy"
          decoding="async"
          draggable={false}
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
        face.manaCost && (
          <ManaCost
            cost={face.manaCost}
            size={size === 'small' ? 'small' : 'normal'}
            className="card-cost"
          />
        )
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
        <img
          src={artUrl(face.imageUri, 'png')}
          alt={face.name}
          decoding="async"
          onError={() => noteArtFailure(face.imageUri!)}
        />
      )}
      <div className="preview-text">
        <h4>
          <span>{face.name}</span>
          <ManaCost cost={face.manaCost} />
        </h4>
        <div className="type">{face.typeLine}</div>
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
