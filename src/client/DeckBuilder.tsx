import { useEffect, useMemo, useRef, useState } from 'react';
import { frontFace, oracle } from '@engine/oracle';
import type { DeckEntry } from '@engine/state';
import type { OracleId, PlayerId } from '@engine/types';
import { unimplementedReason } from '@engine/cards/index';
import {
  canShareFiles,
  copyText,
  deckFilenameFor,
  deckToText,
  describeProblems,
  downloadText,
  readDeckFile,
  shareDeck,
} from './deck-file';
import { useStore } from './store';
import { ManaCost } from './mana';
import { OracleCardDetail } from './CardView';

/**
 * Deckbuilding and sideboarding.
 *
 * One pool, two columns: what is in the deck and what is on the bench. A card
 * moves with a single click either way, and the deck is legal or it is not —
 * there is no third state to reason about mid-swap. This is also the screen
 * between games in a series, which is why it opens with the deck you last
 * played rather than a blank list.
 */

const MIN_DECK = 60;

interface Row {
  oracleId: OracleId;
  inDeck: number;
  owned: number;
}

/**
 * How the two lists are ordered.
 *
 * All three answer a different question. Cost is the curve — the one you want
 * while deciding what to cut. Type groups the deck the way a decklist is
 * written. Name is how you find a specific card in a hurry, which with sixty
 * plus a drafted pool is the common case during sideboarding.
 */
export type SortMode = 'cost' | 'type' | 'name';

export const SORT_LABEL: Record<SortMode, string> = {
  cost: 'Mana cost',
  type: 'Type',
  name: 'A–Z',
};

/** Reading order of a written decklist. Lands last, as they always are. */
const TYPE_ORDER = [
  'Creature',
  'Planeswalker',
  'Battle',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Land',
];

function typeRank(types: string[]): number {
  // A card with several types is filed under the first one that appears here,
  // which is why the list is in the order a decklist is written rather than
  // alphabetical: an artifact creature belongs with the creatures.
  const i = TYPE_ORDER.findIndex((t) => types.includes(t));
  return i === -1 ? TYPE_ORDER.length : i;
}

/** The heading a row sits under, or null when the list is not grouped. */
export function groupOf(oracleId: OracleId, mode: SortMode): string | null {
  const face = frontFace(oracleId);
  if (mode === 'type') return TYPE_ORDER[typeRank(face.types)] ?? 'Other';
  if (mode === 'cost') {
    if (face.types.includes('Land')) return 'Lands';
    return face.mv === 0 ? 'Free' : `${face.mv} mana`;
  }
  return null;
}

export function sortRows(rows: Row[], mode: SortMode): Row[] {
  return [...rows].sort((a, b) => {
    const fa = frontFace(a.oracleId);
    const fb = frontFace(b.oracleId);
    if (mode === 'name') return fa.name.localeCompare(fb.name);

    if (mode === 'type') {
      const ra = typeRank(fa.types);
      const rb = typeRank(fb.types);
      if (ra !== rb) return ra - rb;
      // Inside a type the curve is still the useful second key.
      if (fa.mv !== fb.mv) return fa.mv - fb.mv;
      return fa.name.localeCompare(fb.name);
    }

    // Cost. Lands have no meaningful mana value, so they go last as a block
    // rather than sitting in with the free spells.
    const la = fa.types.includes('Land') ? 1 : 0;
    const lb = fb.types.includes('Land') ? 1 : 0;
    if (la !== lb) return la - lb;
    if (fa.mv !== fb.mv) return fa.mv - fb.mv;
    return fa.name.localeCompare(fb.name);
  });
}

function CardRow({
  row,
  side,
  playable,
  shown,
  onMove,
  onShow,
}: {
  row: Row;
  side: 'deck' | 'bench';
  playable: boolean;
  /** This is the card in the reading pane. */
  shown: boolean;
  onMove: (n: number) => void;
  onShow: () => void;
}) {
  const face = frontFace(row.oracleId);
  const count = side === 'deck' ? row.inDeck : row.owned - row.inDeck;
  return (
    <div
      className={`build-row${playable ? '' : ' is-unplayable'}${shown ? ' is-shown' : ''}`}
      // Pointing at a row is enough to read the card — no click needed, and no
      // click conflict either, since a click already moves the card across.
      onMouseEnter={onShow}
      onFocus={onShow}
      onClick={() => onMove(side === 'deck' ? -1 : 1)}
      onContextMenu={(e) => {
        // Right click moves the whole stack; the common case when cutting a card.
        e.preventDefault();
        onMove(side === 'deck' ? -count : count);
      }}
      title={
        playable
          ? `${face.name} — click to move one, right click to move all ${count}`
          : `${face.name} is in the pool but the engine cannot play it yet`
      }
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onMove(side === 'deck' ? -1 : 1);
        }
      }}
    >
      <span className="build-count">{count}</span>
      <span className="build-name">{face.name}</span>
      {!playable && <span className="build-flag" title="Not implemented yet">⚠</span>}
      <ManaCost cost={face.manaCost} size="small" />
    </div>
  );
}

/**
 * A sorted list with a heading whenever the group changes.
 *
 * The headings are what make sorting worth having: a list ordered by cost with
 * no "3 mana" markers is just a list, and counting the curve by eye is exactly
 * the thing you opened the builder to do.
 */
function RowList({
  rows,
  side,
  sort,
  isPlayable,
  shown,
  onShow,
  onMove,
}: {
  rows: Row[];
  side: 'deck' | 'bench';
  sort: SortMode;
  isPlayable: (id: OracleId) => boolean;
  shown: OracleId | null;
  onShow: (id: OracleId) => void;
  onMove: (id: OracleId, n: number) => void;
}) {
  let lastGroup: string | null = null;
  return (
    <>
      {rows.map((r) => {
        const group = groupOf(r.oracleId, sort);
        const heading = group !== null && group !== lastGroup ? group : null;
        lastGroup = group;
        return (
          <div key={r.oracleId}>
            {heading && (
              <div className="build-group">
                <span>{heading}</span>
                <span className="build-group-count">
                  {rows
                    .filter((x) => groupOf(x.oracleId, sort) === group)
                    .reduce((n, x) => n + (side === 'deck' ? x.inDeck : x.owned - x.inDeck), 0)}
                </span>
              </div>
            )}
            <CardRow
              row={r}
              side={side}
              playable={isPlayable(r.oracleId)}
              shown={shown === r.oracleId}
              onMove={(n) => onMove(r.oracleId, n)}
              onShow={() => onShow(r.oracleId)}
            />
          </div>
        );
      })}
    </>
  );
}

const SORT_KEY = 'satm.build.sort.v1';

function loadSort(): SortMode {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    return raw === 'type' || raw === 'name' || raw === 'cost' ? raw : 'cost';
  } catch {
    return 'cost';
  }
}

function saveSort(mode: SortMode): void {
  try {
    localStorage.setItem(SORT_KEY, mode);
  } catch {
    // A private window with storage disabled is not a reason to break the builder.
  }
}

export interface FittedDeck {
  deck: Map<OracleId, number>;
  /** Cards the list asked for that this player does not own at all. */
  missing: string[];
  /** Copies dropped because the pool holds fewer than the list wanted. */
  trimmed: number;
}

/**
 * Fit an imported list to what this player actually has.
 *
 * A list from outside knows nothing about the draft that happened here, so the
 * honest options are to refuse it or to take the part of it that is legal. It
 * takes the legal part and says exactly what it could not take — refusing a
 * sixty-card list over one card leaves somebody re-typing fifty-nine.
 */
export function fitToPool(entries: DeckEntry[], owned: Map<OracleId, number>): FittedDeck {
  const deck = new Map<OracleId, number>();
  const missing: string[] = [];
  let trimmed = 0;
  for (const e of entries) {
    const have = owned.get(e.oracleId) ?? 0;
    if (have === 0) {
      missing.push(cardName(e.oracleId));
      continue;
    }
    const take = Math.min(have, e.count);
    trimmed += e.count - take;
    if (take > 0) deck.set(e.oracleId, (deck.get(e.oracleId) ?? 0) + take);
  }
  return { deck, missing, trimmed };
}

/** What to tell somebody after a list has been fitted to their pool. */
export function fitNote(fit: FittedDeck): string | null {
  const bits: string[] = [];
  if (fit.missing.length > 0) {
    const shown = fit.missing.slice(0, 3).join(', ');
    bits.push(
      fit.missing.length <= 3
        ? `Left out — not in your pool: ${shown}.`
        : `Left out ${fit.missing.length} cards not in your pool, including ${shown}.`,
    );
  }
  if (fit.trimmed > 0) bits.push(`${fit.trimmed} copies trimmed to what you own.`);
  return bits.length > 0 ? bits.join(' ') : null;
}

export function DeckBuilder({ viewer }: { viewer: PlayerId }) {
  const pool = useStore((s) => s.pool);
  const ready = useStore((s) => s.deckReady);
  const submitted = useStore((s) => s.deckSubmitted);
  const sendDeck = useStore((s) => s.sendDeck);
  const error = useStore((s) => s.error);
  const dismissError = useStore((s) => s.dismissError);

  // What the player owns, and how many of each are currently in the deck. The
  // deck starts as the shared mirror: the drafted cards are additions to it,
  // not a replacement for it.
  const owned = useMemo(() => {
    const m = new Map<OracleId, number>();
    for (const list of [pool?.base ?? [], pool?.drafted ?? [], pool?.lands ?? []]) {
      for (const e of list) m.set(e.oracleId, (m.get(e.oracleId) ?? 0) + e.count);
    }
    return m;
  }, [pool]);

  /*
   * Game two starts from the deck you just played, not from the shared sixty.
   *
   * Sideboarding is adjusting a list, and resetting to the mirror between games
   * threw away every drafted card the moment the second game began — you had to
   * rebuild the whole thing from scratch, and it was easy not to notice until
   * you were already playing. The mirror is still one button away.
   */
  const lastDeck = useStore((s) => s.lastDeck);
  const [deck, setDeck] = useState<Map<OracleId, number>>(() => {
    const m = new Map<OracleId, number>();
    for (const e of lastDeck ?? pool?.base ?? []) m.set(e.oracleId, e.count);
    return m;
  });

  // Sticky: the pane keeps showing the last card the pointer was over, so it
  // does not flash empty every time the mouse crosses a gap between rows.
  const [shown, setShown] = useState<OracleId | null>(null);
  const [sort, setSort] = useState<SortMode>(() => loadSort());
  useEffect(() => saveSort(sort), [sort]);
  /*
   * The same question the engine's own gate asks, so the two can never disagree:
   * "has a script" flagged Birds of Paradise (which works - the whole card is an
   * unconditional mana ability) while passing Chrome Mox (which handed out five
   * colours it had no right to). unimplementedReason knows the difference.
   */
  const isPlayable = (oracleId: OracleId): boolean => unimplementedReason(oracleId) === null;

  const rows: Row[] = useMemo(
    () =>
      [...owned].map(([oracleId, ownedCount]) => ({
        oracleId,
        owned: ownedCount,
        inDeck: deck.get(oracleId) ?? 0,
      })),
    [owned, deck],
  );

  const inDeck = sortRows(rows.filter((r) => r.inDeck > 0), sort);
  const bench = sortRows(rows.filter((r) => r.owned - r.inDeck > 0), sort);
  const size = [...deck.values()].reduce((n, c) => n + c, 0);

  const move = (oracleId: OracleId, delta: number) => {
    setDeck((prev) => {
      const next = new Map(prev);
      const have = owned.get(oracleId) ?? 0;
      const current = next.get(oracleId) ?? 0;
      const wanted = Math.max(0, Math.min(have, current + delta));
      if (wanted === 0) next.delete(oracleId);
      else next.set(oracleId, wanted);
      return next;
    });
  };

  const entries: DeckEntry[] = [...deck].map(([oracleId, count]) => ({ oracleId, count }));
  const legal = size >= MIN_DECK;

  // --- taking the list somewhere else, and bringing one back ----------------
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  // Just the deck's name: the count is on the next line of the file, and putting
  // it in the name only made the saved filename read `show-and-tell-60-cards`.
  const deckName = 'Show and Tell';

  const loadFile = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const loaded = await readDeckFile(file);
      if (loaded.entries.length === 0) {
        setNote(describeProblems(loaded) ?? `${file.name} has no cards in it.`);
        return;
      }
      const fit = fitToPool(loaded.entries, owned);
      setDeck(fit.deck);
      const total = [...fit.deck.values()].reduce((n, c) => n + c, 0);
      setNote(
        [`Loaded ${total} cards from ${file.name}.`, fitNote(fit), describeProblems(loaded)]
          .filter(Boolean)
          .join(' '),
      );
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  // Either the server has confirmed it or this client has just sent it; both
  // mean the same thing to the person looking at the button.
  const iAmReady = ready.includes(viewer) || submitted.includes(viewer);
  const opponent: PlayerId = viewer === 'p1' ? 'p2' : 'p1';

  // A drafted card with no engine script can be put in a list but not cast, so
  // the builder says so rather than letting it be discovered mid-game.
  const unplayableInDeck = inDeck.filter((r) => !isPlayable(r.oracleId));

  const rowProps = {
    isPlayable,
    shown,
    onShow: setShown,
    onMove: move,
  };

  return (
    <div className="build-screen">
      <header className="build-top">
        <h1>Build your deck</h1>
        <div className={`build-size${legal ? ' is-legal' : ''}`}>
          <b>{size}</b>
          <span>cards {legal ? '' : `· ${MIN_DECK - size} short`}</span>
        </div>
        <span className="spacer" />
        <span className="bid-note">
          {iAmReady
            ? 'Waiting for your opponent…'
            : ready.includes(opponent)
              ? 'They are ready and waiting for you.'
              : 'Both players must lock in before the game starts.'}
        </span>
        <button
          className="primary"
          data-testid="lock-deck"
          disabled={!legal || iAmReady}
          onClick={() => sendDeck(entries, viewer)}
        >
          {iAmReady ? 'You locked in your deck' : 'Lock in deck'}
        </button>
      </header>

      {unplayableInDeck.length > 0 && (
        <div className="build-warning" data-testid="unplayable-warning">
          <b>⚠ {unplayableInDeck.length} card{unplayableInDeck.length === 1 ? '' : 's'} in this deck cannot be played yet.</b>{' '}
          The draft pool is in the card database so it can be drafted and built with, but a card
          needs an engine script before it can actually be cast. Marked with ⚠ below.
        </div>
      )}

      <div className="build-sort">
        <span className="bid-note">Sort by</span>
        <div className="segmented" data-testid="sort-mode" role="group">
          {(['cost', 'type', 'name'] as SortMode[]).map((m) => (
            <button
              key={m}
              className={`chip-choice${sort === m ? ' is-picked' : ''}`}
              data-testid={`sort-${m}`}
              aria-pressed={sort === m}
              onClick={() => setSort(m)}
            >
              {SORT_LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      <main className="build-columns">
        <section className="build-col">
          <h2>
            Deck <span>{size}</span>
          </h2>
          <div className="build-list" data-testid="deck-list">
            <RowList rows={inDeck} side="deck" sort={sort} {...rowProps} />
          </div>
        </section>

        <section className="build-col">
          <h2>
            Bench <span>{[...owned].reduce((n, [id, c]) => n + c - (deck.get(id) ?? 0), 0)}</span>
          </h2>
          <div className="build-list" data-testid="bench-list">
            <RowList rows={bench} side="bench" sort={sort} {...rowProps} />
          </div>
        </section>

        <aside className="build-preview" data-testid="build-preview">
          {shown ? (
            <OracleCardDetail oracleId={shown} className="is-inline" />
          ) : (
            <p className="bid-note">Point at a card to read it.</p>
          )}
        </aside>
      </main>

      <footer className="build-bottom">
        <span className="bid-note">
          Click a card to move one across; right click to move the whole stack. Your drafted cards
          and the sixteen lands you were handed are all on the bench to start with.
        </span>
        <span className="spacer" />
        <div className="build-file">
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.dec,.dek,.mwdeck,text/plain"
            data-testid="import-deck-input"
            hidden
            onChange={(e) => {
              void loadFile(e.target.files?.[0]);
              // Cleared so picking the same file twice fires again.
              e.target.value = '';
            }}
          />
          <button data-testid="import-deck" onClick={() => fileRef.current?.click()}>
            Import a list
          </button>
          <button
            data-testid="export-deck"
            disabled={size === 0}
            title="Save this list as a text file"
            onClick={() => {
              const ok = downloadText(deckFilenameFor(deckName), deckToText(entries, deckName));
              if (!ok) setNote('This browser would not save the file — copy the list instead.');
            }}
          >
            Export
          </button>
          <button
            data-testid="copy-deck"
            disabled={size === 0}
            title="Copy this list to the clipboard"
            onClick={async () => {
              const ok = await copyText(deckToText(entries, deckName));
              setNote(ok ? 'Decklist copied.' : 'This browser would not let the page copy.');
            }}
          >
            Copy
          </button>
          {canShareFiles() && (
            <button
              data-testid="share-deck"
              disabled={size === 0}
              onClick={() => void shareDeck(deckFilenameFor(deckName), deckToText(entries, deckName))}
            >
              Send
            </button>
          )}
        </div>
        <button
          onClick={() => {
            const m = new Map<OracleId, number>();
            for (const e of pool?.base ?? []) m.set(e.oracleId, e.count);
            setDeck(m);
          }}
        >
          Reset to the mirror
        </button>
      </footer>

      {note && (
        <div className="toast" data-testid="deck-file-note">
          {note}
          <button onClick={() => setNote(null)}>Dismiss</button>
        </div>
      )}

      {error && (
        <div className="toast">
          {error}
          <button onClick={dismissError}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

/** Kept for the card preview panel, which resolves names from ids. */
export function cardName(oracleId: OracleId): string {
  return oracle(oracleId).name;
}
