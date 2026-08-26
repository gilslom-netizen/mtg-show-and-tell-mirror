import { useEffect, useMemo, useState } from 'react';
import { frontFace } from '@engine/oracle';
import type { OracleId, PlayerId } from '@engine/types';
import { CardFace, OracleCardDetail } from './CardView';
import { useStore } from './store';
import { opponentHasPassed, type DraftView } from '../draft/redact';
import { MAINDECK } from '@engine/deck';

/**
 * The draft table.
 *
 * Four cards a pile: two face up between the players, and one each that only
 * its owner can see. The layout puts your own hidden card low and to the right
 * and theirs high and to the left, so at a glance you can tell which unknown is
 * yours to reason about and which is the one they are bidding on.
 */

/** A pile card rendered from an oracle id, since the draft has its own instances. */
function DraftCardFace({
  oracleId,
  size = 'normal',
  selected,
  onClick,
  badge,
}: {
  oracleId: OracleId | null;
  size?: 'small' | 'normal' | 'large';
  selected?: boolean;
  onClick?: () => void;
  badge?: string;
}) {
  if (!oracleId) {
    // The badge sits above the card, and .card clips its own overflow — so the
    // face-down case needs the same wrapper as a real card rather than being
    // the card itself, or the label is sliced off at the top.
    return (
      <div className={`draft-card is-${size}`}>
        <div className="card facedown" aria-label="Hidden card" />
        {badge && <span className="draft-card-badge">{badge}</span>}
        <div className="draft-card-name is-unknown">Face down</div>
      </div>
    );
  }
  const face = frontFace(oracleId);
  return (
    <div
      className={`draft-card is-${size}`}
      // The draft's cards are its own instances, not the engine's, so the reader
      // beside the table follows them by oracle id rather than by instance.
      onMouseEnter={() => useStore.getState().setHoveredOracle(oracleId)}
      onMouseLeave={() => useStore.getState().setHoveredOracle(null)}
    >
      <CardFace
        card={{
          iid: -1,
          oracleId,
          controller: 'p1',
          owner: 'p1',
          zone: 'hand',
          tapped: false,
          summoningSick: false,
          attacking: false,
          damage: 0,
          counters: {},
          isToken: false,
          face: 'front',
          power: null,
          toughness: null,
        } as never}
        viewer="p1"
        size={size}
        selected={selected}
        onClick={onClick}
      />
      {badge && <span className="draft-card-badge">{badge}</span>}
      <div className="draft-card-name">{face.name}</div>
    </div>
  );
}

/**
 * The card you are reading while you decide what a pile is worth.
 *
 * Bidding on a pile means reading four cards you may never have seen, at a size
 * the pile itself cannot afford to show them at. Hovering fills this in; a
 * right-click holds one open, so you can look back at the table, the purses and
 * the piles-left count without losing the card you were weighing up.
 */
function DraftReader() {
  const pinned = useStore((s) => s.pinnedOracleId);
  const hovered = useStore((s) => s.hoveredOracleId);
  const togglePinnedCard = useStore((s) => s.togglePinnedCard);
  const showing = pinned ?? hovered;

  return (
    <aside className="draft-reader" data-testid="draft-reader">
      {showing ? (
        <>
          <OracleCardDetail oracleId={showing} className="is-inline" />
          <div className="draft-reader-foot">
            {pinned ? (
              <button data-testid="unpin-card" onClick={() => togglePinnedCard(null)}>
                Unpin
              </button>
            ) : (
              <span className="bid-note">Right-click to hold it open.</span>
            )}
          </div>
        </>
      ) : (
        <p className="bid-note">
          Point at a card to read it. Right-click one to hold it open here while you
          look at the rest of the table.
        </p>
      )}
    </aside>
  );
}

function Coins({ n, label, highlight }: { n: number; label: string; highlight?: boolean }) {
  return (
    <div className={`coin-stack${highlight ? ' is-you' : ''}`}>
      <span className="coin-amount">{n}</span>
      <span className="coin-label">{label}</span>
    </div>
  );
}

/** The pile on the table, laid out as described: yours low-right, theirs high-left. */
function PileTable({ draft }: { draft: DraftView }) {
  const pile = draft.pile;
  if (!pile) return null;
  const oracleOf = (iid: number): OracleId | null => draft.cards[iid]?.oracleId ?? null;
  const picking = draft.phase === 'picking' && draft.pickingBy === draft.viewer;

  return (
    <div className="pile-table">
      <div className="pile-slot is-theirs">
        <DraftCardFace
          oracleId={picking ? oracleOf(theirCard(draft)) : null}
          badge="Only they see this"
        />
      </div>
      <div className="pile-slot is-public">
        {pile.publicCards.map((iid) => (
          <DraftCardFace key={iid} oracleId={oracleOf(iid)} badge="Both see this" />
        ))}
      </div>
      <div className="pile-slot is-mine">
        <DraftCardFace oracleId={oracleOf(pile.myPrivateCard)} badge="Only you see this" />
      </div>
    </div>
  );
}

/**
 * The fourth card: known to the buyer once they have won, and otherwise not in
 * the view at all — the redaction layer never sends it.
 */
function theirCard(draft: DraftView): number {
  const known = new Set([...(draft.pile?.publicCards ?? []), draft.pile?.myPrivateCard]);
  const extra = Object.keys(draft.cards)
    .map(Number)
    .filter((iid) => !known.has(iid) && !draft.myPicks.includes(iid) && !draft.myDiscards.includes(iid));
  return extra[0] ?? -1;
}

function BidControls({ draft, onBid }: { draft: DraftView; onBid: (n: number) => void }) {
  const mine = draft.toAct === draft.viewer;
  const min = draft.minimumBid;
  const max = draft.myCoins;
  const [amount, setAmount] = useState(min);
  // They opened by passing: a different auction from an empty one, and the amount
  // box has nothing left to ask — above the minimum you would only be outbidding
  // yourself. See opponentHasPassed.
  const theyPassed = opponentHasPassed(draft);

  // A new auction, or the opponent raising, moves the floor under the box.
  useEffect(() => {
    setAmount((a) => (a < min || a > max ? Math.min(min, max) : a));
  }, [min, max]);

  if (!mine) {
    return (
      <div className="bid-bar is-waiting">
        <span className="spinner" aria-hidden />
        <span>
          {draft.phase === 'picking'
            ? 'They are choosing which two to keep…'
            : 'Waiting for their bid…'}
        </span>
      </div>
    );
  }

  if (theyPassed) {
    return (
      <div className="bid-bar" data-testid="they-passed">
        <div className="bid-passed">
          <b>They bid 0</b>
          <span>They passed on this pile — they are out of the bidding for it.</span>
        </div>
        <div className="bid-quick">
          <button
            className="primary"
            data-testid="bid-take-unopposed"
            disabled={min > max}
            onClick={() => onBid(min)}
          >
            Take the pile for {min}
          </button>
          <button data-testid="bid-withdraw" onClick={() => onBid(0)}>
            Withdraw
          </button>
        </div>
        <div className="bid-note">
          {min > max
            ? 'You have no coins left, so withdrawing is your only move — and the pile goes with it.'
            : `Nobody is left to outbid you, so ${min} buys it. Withdraw as well and nobody takes it: all four cards leave the draft.`}
        </div>
      </div>
    );
  }

  const canAfford = min <= max;
  // The quick buttons are the bids people actually make: the smallest one that
  // wins, and a few small raises on top of it.
  const quick = [0, 1, 2, 3].map((i) => min + i).filter((n) => n <= max).slice(0, 4);

  return (
    <div className="bid-bar">
      {/* Their standing bid, as loud as the input box. A playtester mistook the
          default in his own amount box for the opponent's bid - the real number
          was a small line of text at the bottom. */}
      <div className={`bid-theirs${draft.highestBid > 0 ? ' is-live' : ''}`} data-testid="their-bid">
        {draft.highestBid > 0 ? (
          <>
            They bid <b>{draft.highestBid}</b>
          </>
        ) : (
          <>No bid yet — you open</>
        )}
      </div>
      <div className="bid-main">
        <label className="bid-field">
          <span>Your bid</span>
          <input
            type="number"
            min={0}
            max={max}
            value={amount}
            data-testid="bid-amount"
            onChange={(e) => setAmount(Math.max(0, Math.min(max, Number(e.target.value) || 0)))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (amount === 0 || amount >= min)) onBid(amount);
            }}
          />
        </label>
        <button
          className="primary bid-go"
          data-testid="bid-submit"
          disabled={amount !== 0 && (amount < min || amount > max)}
          onClick={() => onBid(amount)}
        >
          {amount === 0 ? 'Withdraw' : `Bid ${amount}`}
        </button>
      </div>

      <div className="bid-quick">
        <button data-testid="bid-withdraw" onClick={() => onBid(0)}>
          Withdraw
        </button>
        {quick.map((n) => (
          <button key={n} data-testid={`bid-quick-${n}`} onClick={() => onBid(n)}>
            {n}
          </button>
        ))}
        {!canAfford && <span className="bid-note">You cannot outbid this — withdrawing is your only move.</span>}
      </div>

      <div className="bid-note">
        {draft.highestBid > 0
          ? `They bid ${draft.highestBid}. Beat it with ${min}, or withdraw and let them have it.`
          : 'Open the bidding, or withdraw and let them take it for one.'}
      </div>
    </div>
  );
}

function PickControls({ draft, onKeep }: { draft: DraftView; onKeep: (iids: number[]) => void }) {
  const [picked, setPicked] = useState<number[]>([]);
  const pile = draft.pile;
  // A new pile clears the selection, so a stale pick can never be submitted.
  useEffect(() => setPicked([]), [pile?.number]);
  if (!pile) return null;

  const all = [...pile.publicCards, pile.myPrivateCard, theirCard(draft)].filter(
    (iid) => draft.cards[iid],
  );
  const need = draft.picksRequired;

  const toggle = (iid: number) =>
    setPicked((p) =>
      p.includes(iid) ? p.filter((x) => x !== iid) : p.length >= need ? p : [...p, iid],
    );

  return (
    <div className="pick-panel">
      <h3>
        You won pile {pile.number}. Keep {need}, throw the rest away.
      </h3>
      <div className="pick-grid">
        {all.map((iid) => (
          <DraftCardFace
            key={iid}
            oracleId={draft.cards[iid].oracleId}
            size="large"
            selected={picked.includes(iid)}
            onClick={() => toggle(iid)}
            badge={picked.includes(iid) ? `Keeping (${picked.indexOf(iid) + 1})` : undefined}
          />
        ))}
      </div>
      <div className="actions">
        <span className="bid-note">
          {picked.length}/{need} chosen
        </span>
        <button
          className="primary"
          data-testid="confirm-picks"
          disabled={picked.length !== need}
          onClick={() => onKeep(picked)}
        >
          Keep these {need}
        </button>
      </div>
    </div>
  );
}

/** A scrollable list of cards, used for your picks, your discards and the mirror. */
function CardListDialog({
  title,
  subtitle,
  oracleIds,
  onClose,
}: {
  title: string;
  subtitle?: string;
  oracleIds: OracleId[];
  onClose: () => void;
}) {
  const grouped = useMemo(() => {
    const counts = new Map<OracleId, number>();
    for (const id of oracleIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...counts].sort((a, b) => frontFace(a[0]).name.localeCompare(frontFace(b[0]).name));
  }, [oracleIds]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog draft-list-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {subtitle && <div className="prompt">{subtitle}</div>}
        {grouped.length === 0 ? (
          <p className="bid-note">Nothing here yet.</p>
        ) : (
          <div className="card-grid draft-list-grid">
            {grouped.map(([oracleId, count]) => (
              <DraftCardFace
                key={oracleId}
                oracleId={oracleId}
                badge={count > 1 ? `x${count}` : undefined}
              />
            ))}
          </div>
        )}
        <div className="actions">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function DraftScreen({ viewer }: { viewer: PlayerId }) {
  const draft = useStore((s) => s.draft);
  const sendDraft = useStore((s) => s.sendDraft);
  const error = useStore((s) => s.error);
  const dismissError = useStore((s) => s.dismissError);
  const [open, setOpen] = useState<'picks' | 'discards' | 'maindeck' | null>(null);

  if (!draft) {
    return (
      <div className="lobby">
        <div className="lobby-card">
          <h1>Setting up the draft…</h1>
        </div>
      </div>
    );
  }

  const opponent: PlayerId = viewer === 'p1' ? 'p2' : 'p1';
  const myPick = draft.phase === 'picking' && draft.pickingBy === viewer;
  const avg = draft.averagePileValue;
  const names = (iids: number[]) => iids.map((i) => draft.cards[i]?.oracleId).filter(Boolean) as OracleId[];

  return (
    <div className="draft-screen">
      <header className="draft-top">
        <h1>Draft</h1>
        <div className="draft-stats">
          <div className="stat-tile">
            <b>{draft.pile ? `${draft.pile.number} of ${draft.pilesTotal}` : '—'}</b>
            <span>this pile</span>
          </div>
          <div className="stat-tile">
            {/* Counts the pile on the table. Two numbers this close bred a real
                argument about the average pile value - label them so neither can
                be mistaken for the other. */}
            <b>{draft.pilesRemaining}</b>
            <span>piles left (incl. this)</span>
          </div>
          <div className="stat-tile">
            <b>{draft.cardsRemaining}</b>
            <span>cards left</span>
          </div>
          <div className="stat-tile" title="Both purses divided by the piles still to buy">
            <b>{avg === null ? '—' : avg.toFixed(1)}</b>
            <span>avg pile worth</span>
          </div>
        </div>
        <div className="draft-purses">
          <Coins n={draft.coins[viewer]} label="your coins" highlight />
          <Coins n={draft.coins[opponent]} label="their coins" />
        </div>
      </header>

      <div className="draft-body">
        <main className="draft-main">
        {/* While you are picking, the panel below shows all four cards larger —
            keeping the table above it as well would be the same pile twice, and
            pushes the confirm button off the bottom of the screen. */}
          {myPick ? null : <PileTable draft={draft} />}

          {myPick ? (
            <PickControls draft={draft} onKeep={(iids) => sendDraft({ t: 'keep', iids }, viewer)} />
          ) : (
            <BidControls
              /*
               * Rebuilt from scratch every pile. The amount box is useState(min),
               * which runs once for the component's whole life - so a 4 typed two
               * piles ago sat in the box looking like a default, and a playtester
               * read it as the opponent's standing bid. A key makes React tear the
               * component down between auctions, which is exactly what an auction
               * deserves: no state carried over.
               */
              key={draft.pile?.number ?? 0}
              draft={draft}
              onBid={(amount) => sendDraft({ t: 'bid', amount }, viewer)}
            />
          )}
        </main>
        <DraftReader />
      </div>

      <footer className="draft-bottom">
        <button data-testid="open-picks" onClick={() => setOpen('picks')}>
          Your picks <b>{draft.myPicks.length}</b>
        </button>
        <button data-testid="open-discards" onClick={() => setOpen('discards')}>
          Thrown away <b>{draft.myDiscards.length}</b>
        </button>
        <button data-testid="open-maindeck" onClick={() => setOpen('maindeck')}>
          Main deck
        </button>
        <span className="spacer" />
        <span className="bid-note">
          They have taken {draft.opponentPickCount}
          {draft.setAsideCount > 0 &&
            ` · ${draft.setAsideCount} random card${
              draft.setAsideCount === 1 ? '' : 's'
            } sat this draft out`}
        </span>
      </footer>

      {open === 'picks' && (
        <CardListDialog
          title="Cards you have taken"
          subtitle="These become your pool once the draft ends."
          oracleIds={names(draft.myPicks)}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'discards' && (
        <CardListDialog
          title="Cards you threw away"
          subtitle="Out of the draft for good — but worth remembering."
          oracleIds={names(draft.myDiscards)}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'maindeck' && (
        <CardListDialog
          title="The main deck"
          subtitle="Both players run these sixty. What you draft goes around them."
          oracleIds={MAINDECK.flatMap((e) => Array<OracleId>(e.count).fill(e.oracleId))}
          onClose={() => setOpen(null)}
        />
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
