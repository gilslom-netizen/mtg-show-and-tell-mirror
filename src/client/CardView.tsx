import { memo, useState } from 'react';
import { faceOf, frontFace, oracle } from '@engine/oracle';
import type { CardView as CardData } from '@engine/redact';
import type { OracleFace, OracleId, PlayerId } from '@engine/types';
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

/**
 * The widest a card is ever drawn: the largest card-size setting, in the hand,
 * which is the one row that scales cards up. The browser multiplies this by the
 * display's pixel ratio to choose from the srcset above.
 */
const ART_SIZES = '280px';

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
          /*
           * Let the browser pick the resolution instead of always taking the
           * biggest one.
           *
           * A card on the table is at most ~244 CSS px wide (168px base at the
           * largest card-size setting), and ~280px in the hand. 'png' is 745px
           * and 357KB; 'large' is 672px and 135KB. On an ordinary or a retina
           * display 'large' is still two to three times more pixels than the
           * card has, so the 2.6x download bought nothing — and a Show and Tell
           * or a big Omniscience turn puts a dozen of them on screen at once.
           * A three-times-density display genuinely wants the bigger file, and
           * this is exactly the decision `srcset` exists to make.
           */
          src={artUrl(face.imageUri, 'large')}
          srcSet={`${artUrl(face.imageUri, 'large')} 672w, ${artUrl(face.imageUri, 'png')} 745w`}
          sizes={ART_SIZES}
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

      {/*
        A selected card gets a mark in the top left corner: the number when the
        order of the selection matters, a plain check when it does not. The ring
        alone was easy to miss in a row of cards that all have a coloured border
        already, and the two can never collide because they share the slot.
      */}
      {selectionIndex !== undefined ? (
        <div className="order-badge">{selectionIndex + 1}</div>
      ) : (
        selected && (
          <span className="card-badge selected-check" aria-hidden>
            ✓
          </span>
        )
      )}

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
/**
 * A card at reading size: the art, the name and cost, and the full rules text.
 *
 * Shared by the game's hover preview and the deckbuilder, which both need
 * exactly this and would otherwise drift apart — one of them growing a back
 * face or a power/toughness line the other never got.
 */
export function CardDetail({
  face,
  full,
  className = '',
}: {
  face: OracleFace;
  /** The whole card, when there is one — a token has only a face. */
  full: ReturnType<typeof oracle> | null;
  className?: string;
}) {
  const showArt = useStore((s) => s.settings.showCardArt && s.artAvailable === true);
  return (
    <div className={`preview ${className}`.trim()}>
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
        <div className="type">
          {face.typeLine}
          {face.power !== null && ` · ${face.power}/${face.toughness}`}
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

/** The same detail view, addressed by oracle id — for screens with no game. */
export function OracleCardDetail({
  oracleId,
  className,
}: {
  oracleId: OracleId | null;
  className?: string;
}) {
  if (!oracleId) return null;
  return <CardDetail face={frontFace(oracleId)} full={oracle(oracleId)} className={className} />;
}

export function CardPreview({ viewer }: { viewer: PlayerId }) {
  const hovered = useStore((s) => s.hoveredIid);
  const view = useStore((s) => s.views[viewer]);
  if (!hovered || !view) return null;
  const card = view.cards[hovered];
  if (!card) return null;
  return (
    <CardDetail
      face={faceOfCard(card)}
      full={card.isToken ? null : oracle(card.oracleId)}
    />
  );
}
