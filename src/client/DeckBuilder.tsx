import { useMemo, useState } from 'react';
import { frontFace, oracle } from '@engine/oracle';
import type { DeckEntry } from '@engine/state';
import type { OracleId, PlayerId } from '@engine/types';
import { scriptedOracleIds } from '@engine/cards/index';
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

function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const fa = frontFace(a.oracleId);
    const fb = frontFace(b.oracleId);
    const la = fa.types.includes('Land') ? 1 : 0;
    const lb = fb.types.includes('Land') ? 1 : 0;
    // Lands last, then by cost, then by name — the order a decklist is read in.
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

export function DeckBuilder({ viewer }: { viewer: PlayerId }) {
  const pool = useStore((s) => s.pool);
  const ready = useStore((s) => s.deckReady);
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

  const [deck, setDeck] = useState<Map<OracleId, number>>(() => {
    const m = new Map<OracleId, number>();
    for (const e of pool?.base ?? []) m.set(e.oracleId, e.count);
    return m;
  });

  const scripted = useMemo(() => new Set(scriptedOracleIds()), []);
  // Sticky: the pane keeps showing the last card the pointer was over, so it
  // does not flash empty every time the mouse crosses a gap between rows.
  const [shown, setShown] = useState<OracleId | null>(null);
  // A card is playable if the engine has a script for it — or if it is a basic
  // land, which has no rules text to script beyond producing mana. Flagging
  // Island as "not implemented" would be both wrong and alarming.
  const isPlayable = (oracleId: OracleId): boolean =>
    scripted.has(oracleId) || frontFace(oracleId).supertypes.includes('Basic');

  const rows: Row[] = useMemo(
    () =>
      [...owned].map(([oracleId, ownedCount]) => ({
        oracleId,
        owned: ownedCount,
        inDeck: deck.get(oracleId) ?? 0,
      })),
    [owned, deck],
  );

  const inDeck = sortRows(rows.filter((r) => r.inDeck > 0));
  const bench = sortRows(rows.filter((r) => r.owned - r.inDeck > 0));
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
  const iAmReady = ready.includes(viewer);
  const opponent: PlayerId = viewer === 'p1' ? 'p2' : 'p1';

  // A drafted card with no engine script can be put in a list but not cast, so
  // the builder says so rather than letting it be discovered mid-game.
  const unplayableInDeck = inDeck.filter((r) => !isPlayable(r.oracleId));

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
            ? 'Locked in. Waiting for your opponent…'
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
          {iAmReady ? 'Locked in' : 'Lock in deck'}
        </button>
      </header>

      {unplayableInDeck.length > 0 && (
        <div className="build-warning" data-testid="unplayable-warning">
          <b>⚠ {unplayableInDeck.length} card{unplayableInDeck.length === 1 ? '' : 's'} in this deck cannot be played yet.</b>{' '}
          The draft pool is in the card database so it can be drafted and built with, but a card
          needs an engine script before it can actually be cast. Marked with ⚠ below.
        </div>
      )}

      <main className="build-columns">
        <section className="build-col">
          <h2>
            Deck <span>{size}</span>
          </h2>
          <div className="build-list" data-testid="deck-list">
            {inDeck.map((r) => (
              <CardRow
                key={r.oracleId}
                row={r}
                side="deck"
                playable={isPlayable(r.oracleId)}
                shown={shown === r.oracleId}
                onMove={(n) => move(r.oracleId, n)}
                onShow={() => setShown(r.oracleId)}
              />
            ))}
          </div>
        </section>

        <section className="build-col">
          <h2>
            Bench <span>{[...owned].reduce((n, [id, c]) => n + c - (deck.get(id) ?? 0), 0)}</span>
          </h2>
          <div className="build-list" data-testid="bench-list">
            {bench.map((r) => (
              <CardRow
                key={r.oracleId}
                row={r}
                side="bench"
                playable={isPlayable(r.oracleId)}
                shown={shown === r.oracleId}
                onMove={(n) => move(r.oracleId, n)}
                onShow={() => setShown(r.oracleId)}
              />
            ))}
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
