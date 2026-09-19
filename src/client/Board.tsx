import { useEffect, useMemo, useRef, useState } from 'react';
import type { LegalAction } from '@engine/game';
import type { PlayerView } from '@engine/redact';
import { isType } from '@engine/state';
import { unimplementedReason } from '@engine/cards/index';
import { frontFace, oracle } from '@engine/oracle';
import type { IID, PlayerId } from '@engine/types';
import { CardFace, CardPreview } from './CardView';
import { ManaText } from './mana';
import { ChoiceLayer } from './dialogs';
import { KnownTopPanel, LogPanel, Overlay, PhaseTrack, PlayerBar, StackPanel, cardTitle } from './ui';
import { Splitter, clampSize } from './Splitter';
import { canAct, useStore } from './store';
import { DEFAULT_SETTINGS } from './settings';

/**
 * The table.
 *
 * Layout never moves: the viewer is always on the bottom half, the opponent always
 * on the top, and the midline never flips. In a mirror where every permanent exists
 * twice, a stable board and a strong seat colour are what make it readable.
 */

/**
 * Make a half fit the room it has.
 *
 * A playtester could not see his opponent's lands, and the arithmetic says why:
 * at the default size one row of permanents and one row of lands need 260px, and
 * half a 720px window is 209px. So the board did not fit before a single card
 * was played — and what fell off was whichever row came last, the lands on the
 * opponent's side and the creatures on yours.
 *
 * Meanwhile each row was using about two thirds of its width. "There is lots of
 * space on the sides, no reason it should not spread across the whole row" is
 * exactly right, and it is the way out: smaller cards fit more per line, so the
 * wasted width buys back the height that was cutting the board in half.
 *
 * Measured rather than guessed at, because the card size is a clamp on the
 * viewport, the lands are a fraction of the spells, and both are a user setting.
 * The floor is there so a huge board goes back to scrolling rather than becoming
 * a row of specks.
 */
/*
 * Down to 0.46, which is where a land is still a coloured rectangle you can tell
 * tapped from untapped — that is all a land is ever read for. Below it the board
 * goes back to scrolling, because specks you cannot identify are worse than a
 * scrollbar that says there is more.
 *
 * Up to 1.3, which is the other half of the same idea and the newer one. A half
 * only ever shrank to fit, so a board with two permanents on it sat in the top
 * corner of a half-screen of nothing — the empty band under your own player bar
 * that made the table look broken while the opponent's side was being cut off
 * for want of the very room going to waste. Spare height now buys a bigger,
 * more readable card instead of being held empty. The cap is there because a
 * board with one land on it should still look like a board.
 */
const FIT_STEPS = [
  1.3, 1.2, 1.12, 1.06, 1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58, 0.52, 0.46,
];

/** The smallest step, below which a board scrolls instead of shrinking further. */
export const MIN_FIT = FIT_STEPS[FIT_STEPS.length - 1];

/** One row of the board, measured at full size. */
export interface FitRow {
  /** How many cards are in it. */
  n: number;
  /** Card width and height at `--fit: 1`. */
  w: number;
  h: number;
  /** Gap between cards in the row. */
  gap: number;
}

/**
 * The largest scale at which every row fits the height available.
 *
 * Pure arithmetic, kept out of the hook so it can be checked against boards
 * nobody wants to build by hand in a browser. Cards scale linearly and the
 * number that fit on a line is a floor division, so a candidate's height is
 * exact — no measuring per candidate, and no oscillating.
 */
export function heightOfRows(availW: number, rows: FitRow[], fit: number): number {
  return rows.reduce((total, row) => {
    const w = row.w * fit;
    const perLine = Math.max(1, Math.floor((availW + row.gap) / (w + row.gap)));
    return total + Math.ceil(row.n / perLine) * row.h * fit;
  }, 0);
}

export function fitScale(availW: number, room: number, rows: FitRow[]): number {
  if (availW <= 0 || room <= 0 || rows.length === 0) return 1;
  return (
    FIT_STEPS.find((fit) => heightOfRows(availW, rows, fit) <= room) ?? MIN_FIT
  );
}

/**
 * A part of a half whose height scales with the cards but which never wraps.
 *
 * The opponent's hand strip is the only one, and counting it as fixed chrome was
 * wrong in a way that showed: it is sized off `--card-w`, so it shrinks with the
 * board, but it was measured once at full size and then subtracted from the room
 * as though it would not. The half with a hand strip above it therefore always
 * believed it had less room than it did — it shrank its cards further than it
 * needed to *and* still ended up with a band of empty table under them, which is
 * both halves of the complaint this fitting exists to answer.
 *
 * Modelled as a row of one card exactly as wide as nothing, so the line count is
 * always one and the height is the strip's own, scaled.
 */
export function unwrappingRow(h: number): FitRow {
  return { n: 1, w: 1, h, gap: 0 };
}

/** Measure one half at full size: what its rows need, and its fixed chrome. */
function measureHalf(half: HTMLElement): { rows: FitRow[]; chrome: number; availW: number } {
  const style = getComputedStyle(half);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const stackGap = parseFloat(style.rowGap) || 0;
  const children = [...half.children] as HTMLElement[];
  const rows: FitRow[] = [];
  let fixed = 0;
  for (const child of children) {
    if (child.classList.contains('zone-row')) {
      const first = child.firstElementChild as HTMLElement | null;
      if (!first) continue;
      const r = first.getBoundingClientRect();
      rows.push({
        n: child.children.length,
        w: r.width,
        h: r.height,
        gap: parseFloat(getComputedStyle(child).columnGap) || 0,
      });
    } else if (child.classList.contains('hand-strip')) {
      rows.push(unwrappingRow(child.getBoundingClientRect().height));
    } else {
      fixed += child.getBoundingClientRect().height;
    }
  }
  return {
    rows,
    chrome: padY + fixed + stackGap * Math.max(0, children.length - 1),
    availW: half.clientWidth - padX,
  };
}

/**
 * Fit both halves into the table at once.
 *
 * Together rather than one at a time, because a half is sized by what is on it:
 * making its cards bigger makes the half bigger, so measuring one on its own
 * asks a question whose answer changes the question. Measured separately it
 * settled on "everything fits" at full size while three cards sat below the
 * fold.
 *
 * So the fixed quantity is the table, and the two boards share it in proportion
 * to what they need — an empty opponent side gives its room away rather than
 * holding it.
 */
function useFitBoard(
  fieldRef: React.RefObject<HTMLDivElement | null>,
  theirsRef: React.RefObject<HTMLDivElement | null>,
  mineRef: React.RefObject<HTMLDivElement | null>,
  signature: string,
  /** False once the player has dragged the midline: their split wins over ours. */
  autoSplit: boolean,
) {
  useEffect(() => {
    const field = fieldRef.current;
    const halves = [theirsRef.current, mineRef.current].filter(
      (h): h is HTMLDivElement => h !== null,
    );
    if (!field || halves.length === 0) return;

    const measureAndFit = () => {
      for (const half of halves) half.style.setProperty('--fit', '1');
      const midline = field.querySelector('.midline') as HTMLElement | null;
      const total = field.clientHeight - (midline?.getBoundingClientRect().height ?? 0);
      if (total <= 0) return;

      const measured = halves.map((half) => ({ half, ...measureHalf(half) }));
      const needs = measured.map((m) => m.chrome + heightOfRows(m.availW, m.rows, 1));
      const wanted = needs.reduce((a, b) => a + b, 0);

      /*
       * Give each half the table in proportion to what is on it.
       *
       * The CSS could not: two `auto` tracks under `align-content: stretch`
       * share the spare height equally, which is the wrong answer whenever the
       * two boards differ — and in this format they differ from turn one, since
       * only one side has an opponent's-hand strip above it. That equal split is
       * what produced both halves of the same complaint at once: the busier side
       * scrolling with its lands cut off, while the quieter one held a band of
       * empty table nobody could put anything in.
       *
       * The proportions are measured at `--fit: 1`, which does not depend on the
       * fit we are about to choose, so this settles in one pass.
       */
      if (autoSplit && wanted > 0) {
        field.style.gridTemplateRows = `minmax(0, ${needs[0]}fr) auto minmax(0, ${
          needs[needs.length - 1]
        }fr)`;
      }

      for (const [i, m] of measured.entries()) {
        // Its share of the table, whether that is more than it asked for or
        // less: a half with room to spare grows into it rather than leaving a
        // dead band under the player bar.
        const cap = wanted > 0 ? (total * needs[i]) / wanted : total / measured.length;
        m.half.style.setProperty('--fit', String(fitScale(m.availW, cap - m.chrome, m.rows)));
      }
    };

    measureAndFit();
    /*
     * And again on the next frame: the first run can land before the grid has
     * given the halves their real height, and nothing resizes afterwards to say
     * otherwise.
     */
    const frame = requestAnimationFrame(measureAndFit);
    const observer = new ResizeObserver(measureAndFit);
    observer.observe(field);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fieldRef, theirsRef, mineRef, signature, autoSplit]);
}

/** What the board holds, as one string: recompute when this changes. */
function boardSignature(view: PlayerView, seat: PlayerId): string {
  return view.battlefield[seat]
    .map((iid) => {
      const c = view.cards[iid];
      if (!c) return '';
      // A face-down permanent is a creature, whatever the card under it is —
      // and for the opponent its id is a placeholder that resolves to nothing.
      return !c.isToken && !c.faceDown && frontFace(c.oracleId).types.includes('Land') ? 'L' : 'N';
    })
    .join('');
}

export function Board({ viewer }: { viewer: PlayerId }) {
  const view = useStore((s) => s.views[viewer]);
  const logOpen = useStore((s) => s.logOpen);
  const layout = useStore((s) => s.settings.layout);
  const update = useStore((s) => s.updateSettings);
  const theirsRef = useRef<HTMLDivElement>(null);
  const mineRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const handRef = useRef<HTMLDivElement>(null);

  const opponent: PlayerId = viewer === 'p1' ? 'p2' : 'p1';
  // Hooks run before the early return, so the signature is safe when there is
  // no view yet.
  useFitBoard(
    fieldRef,
    theirsRef,
    mineRef,
    view ? `${boardSignature(view, opponent)}|${boardSignature(view, viewer)}` : '',
    layout.fieldSplit === null,
  );

  if (!view) return null;
  const setLayout = (patch: Partial<typeof layout>) =>
    update({ layout: { ...layout, ...patch } });

  /*
   * The midline drag works in pixels of the opponent's half and is stored as a
   * fraction, so the split survives a resized window: measuring both halves at
   * the moment the drag starts is also what lets the layout stay automatic
   * until someone actually drags it.
   */
  const halvesHeight = () =>
    (theirsRef.current?.offsetHeight ?? 0) + (mineRef.current?.offsetHeight ?? 0);

  return (
    <>
      <div
        className="table"
        style={{ '--side-w': `${layout.sideWidth}px` } as React.CSSProperties}
      >
        <div
          className="field"
          ref={fieldRef}
          style={
            layout.fieldSplit === null
              ? undefined
              : {
                  gridTemplateRows: `minmax(0, ${layout.fieldSplit}fr) auto minmax(0, ${
                    1 - layout.fieldSplit
                  }fr)`,
                }
          }
        >
          <div className="half theirs" ref={theirsRef}>
            <PlayerBar view={view} seat={opponent} viewer={viewer} />
            <OpponentHand view={view} seat={opponent} />
            <PermanentRow view={view} viewer={viewer} seat={opponent} landsFirst={false} />
          </div>

          {/* The line between the two boards is also the handle that moves it. */}
          <Splitter
            axis="y"
            className="midline"
            label="Split between the two boards"
            getBase={() => theirsRef.current?.offsetHeight ?? 0}
            onResize={(next) => {
              const total = halvesHeight();
              if (total <= 0) return;
              setLayout({ fieldSplit: Math.min(0.85, Math.max(0.15, next / total)) });
            }}
            onReset={() => setLayout({ fieldSplit: null })}
          >
            <span className="midline-label">Turn {view.turn}</span>
          </Splitter>

          <div className="half mine" ref={mineRef}>
            <PermanentRow view={view} viewer={viewer} seat={viewer} landsFirst />
            <PlayerBar view={view} seat={viewer} viewer={viewer} />
          </div>
        </div>

        <Splitter
          axis="x"
          className="side-splitter"
          label="Width of the stack and log"
          // The panel is on the right, so it grows as the pointer moves left.
          direction={-1}
          getBase={() => layout.sideWidth}
          onResize={(next) => setLayout({ sideWidth: clampSize(next, 180, 620) })}
          onReset={() => setLayout({ sideWidth: DEFAULT_SETTINGS.layout.sideWidth })}
        />

        <div className="side">
          <div style={{ overflowY: 'auto' }}>
            <StackPanel view={view} viewer={viewer} />
            <KnownTopPanel view={view} viewer={viewer} />
            {!logOpen && <PhaseSummary view={view} />}
          </div>
          <LogPanel view={view} viewer={viewer} />
        </div>
      </div>

      {/* Dialogs render as fixed overlays, so the only thing this position
          decides is where a put-aside decision waits: in its own strip between
          the board and the hand, rather than floating over either of them. */}
      <ChoiceLayer view={view} viewer={viewer} />
      <Splitter
        axis="y"
        className="hand-splitter"
        label="Height of your hand"
        // Dragging up makes the hand taller, which is the direction that feels
        // like pulling it open.
        direction={-1}
        getBase={() => handRef.current?.offsetHeight ?? 0}
        onResize={(next) => setLayout({ handHeight: clampSize(next, 84, 520) })}
        onReset={() => setLayout({ handHeight: null })}
      />
      <Hand view={view} viewer={viewer} height={layout.handHeight} innerRef={handRef} />
      <CardPreview viewer={viewer} />
    </>
  );
}

function PhaseSummary({ view }: { view: PlayerView }) {
  return (
    <div className="panel">
      <h3>Phase</h3>
      <PhaseTrack view={view} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** Whether this permanent is a land, which is what used to decide its row. */
function isLandPermanent(view: PlayerView, iid: IID): boolean {
  const c = view.cards[iid];
  if (!c) return false;
  return !c.isToken && !c.faceDown && frontFace(c.oracleId).types.includes('Land');
}

/**
 * Everything one player controls, on one line for as long as one line holds it.
 *
 * Lands used to be a second row of their own, two thirds the size, and that cost
 * more than it saved. Two rows are two chances to wrap, and a half is scaled to
 * whatever both of them need: five lands and two creatures took two lines and
 * 160px of height to show seven cards that fit across a quarter of the width.
 * One row wraps once instead of twice, so the same board fits at a larger card
 * size — which is the whole trade the fitting was making in the first place.
 *
 * Lands are ordered towards the midline on both sides, which is where they
 * already sat: the mirror's reading is that the two boards face each other, and
 * that survives the merge because it was only ever about order.
 */
function PermanentRow({
  view,
  viewer,
  seat,
  landsFirst,
}: {
  view: PlayerView;
  viewer: PlayerId;
  seat: PlayerId;
  /** True for the near half, whose lands sit at the top against the midline. */
  landsFirst: boolean;
}) {
  const all = view.battlefield[seat].filter((iid) => view.cards[iid]);
  const lands = all.filter((iid) => isLandPermanent(view, iid));
  const rest = all.filter((iid) => !isLandPermanent(view, iid));
  const iids = landsFirst ? [...lands, ...rest] : [...rest, ...lands];
  if (iids.length === 0) return null;

  return (
    <div className="zone-row">
      {iids.map((iid) => (
        <PermanentCard key={iid} view={view} viewer={viewer} iid={iid} />
      ))}
    </div>
  );
}

function PermanentCard({ view, viewer, iid }: { view: PlayerView; viewer: PlayerId; iid: IID }) {
  const send = useStore((s) => s.send);
  const [menu, setMenu] = useState(false);
  const card = view.cards[iid];
  const actions = useCardActions(view, iid);

  if (!card) return null;

  const onClick = () => {
    if (actions.length === 0) return;
    if (actions.length === 1) {
      send(actions[0].intent, viewer);
      return;
    }
    setMenu(true);
  };

  return (
    <div style={{ position: 'relative' }}>
      <CardFace
        card={card}
        viewer={viewer}
        onClick={actions.length > 0 ? onClick : undefined}
        castable={actions.length > 0}
      />
      {menu && (
        <ActionMenu
          actions={actions}
          onPick={(a) => {
            setMenu(false);
            send(a.intent, viewer);
          }}
          onClose={() => setMenu(false)}
        />
      )}
    </div>
  );
}

function ActionMenu({
  actions,
  onPick,
  onClose,
}: {
  actions: LegalAction[];
  onPick: (a: LegalAction) => void;
  onClose: () => void;
}) {
  return (
    <Overlay onClick={onClose} style={{ background: 'rgba(5,7,11,0.5)' }}>
      <div className="dialog" style={{ minWidth: 320 }} onClick={(e) => e.stopPropagation()}>
        <h2>Choose an action</h2>
        <div className="mode-grid">
          {actions.map((a, i) => (
            <button key={i} className="mode-option" onClick={() => onPick(a)}>
              {/* The label carries its mana in braces; drawn, it says which
                  colour a dual land is about to make. */}
              <b>
                <ManaText text={a.label} />
              </b>
            </button>
          ))}
        </div>
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Overlay>
  );
}

function OpponentHand({ view, seat }: { view: PlayerView; seat: PlayerId }) {
  const n = view.players[seat].handCount;
  if (n === 0) return null;
  return (
    <div className="hand-strip" aria-label={`Opponent hand: ${n} cards`} title={`${n} cards in hand`}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="card facedown" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hand
// ---------------------------------------------------------------------------

function Hand({
  view,
  viewer,
  height,
  innerRef,
}: {
  view: PlayerView;
  viewer: PlayerId;
  /** Dragged height, or null to size the hand from the cards in it. */
  height: number | null;
  innerRef: React.RefObject<HTMLDivElement>;
}) {
  const send = useStore((s) => s.send);
  const hold = useStore((s) => s.holdPriority);
  const [menu, setMenu] = useState<IID | null>(null);
  const [modifier, setModifier] = useState(false);

  // Shift is the "give me the other options" modifier. Under Omniscience almost
  // every card has both a free cast and a paid cast, and raising a menu on every
  // click would put a modal in front of every spell of the combo turn.
  useEffect(() => {
    const down = (e: KeyboardEvent) => e.key === 'Shift' && setModifier(true);
    const up = (e: KeyboardEvent) => e.key === 'Shift' && setModifier(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  return (
    <div
      ref={innerRef}
      // The cards follow the height rather than the other way round: dragging the
      // divider is how you make the hand bigger to read it or smaller to see the
      // board, and a taller strip of the same small cards would do neither.
      className={`hand${view.omniscienceActive ? ' omniscience' : ''}${
        height === null ? '' : ' is-sized'
      }`}
      style={height === null ? undefined : ({ '--hand-h': `${height}px` } as React.CSSProperties)}
    >
      {view.hand.map((iid, i) => {
        const card = view.cards[iid];
        if (!card) return null;
        const actions = handActions(view, iid);
        const free = actions.some((a) => a.intent.t === 'castSpell' && a.intent.free);
        const playable = actions.length > 0;
        const why = playable ? undefined : whyNotPlayable(view, iid);

        const act = () => {
          if (actions.length === 0) return;
          // One obvious action, or a preferred one (free beats paying mana) — do it.
          // Hold Shift to be offered the alternatives instead.
          if (actions.length === 1 || (!modifier && free)) {
            const intent = actions[0].intent;
            send(intent.t === 'castSpell' ? { ...intent, holdPriority: hold } : intent, viewer);
            return;
          }
          setMenu(iid);
        };

        return (
          <div key={iid} style={{ position: 'relative' }}>
            <CardFace
              card={card}
              viewer={viewer}
              onClick={playable ? act : undefined}
              castable={playable}
              free={free}
            />
            <span
              style={{
                position: 'absolute',
                bottom: -2,
                left: 4,
                fontSize: 9,
                color: 'var(--text-faint)',
              }}
            >
              {i < 9 ? i + 1 : ''}
            </span>
            {free && actions.length > 1 && modifier && (
              <span
                className="chip"
                style={{ position: 'absolute', top: -18, left: 0, fontSize: 9 }}
              >
                shift: pay mana
              </span>
            )}
            {why && (
              <div
                style={{
                  position: 'absolute',
                  inset: 'auto 0 0 0',
                  background: 'rgba(10,12,17,0.85)',
                  fontSize: 8,
                  padding: '2px 3px',
                  color: 'var(--text-faint)',
                  pointerEvents: 'none',
                }}
              >
                {why}
              </div>
            )}
            {menu === iid && (
              <ActionMenu
                actions={actions}
                onPick={(a) => {
                  setMenu(null);
                  send(
                    a.intent.t === 'castSpell' ? { ...a.intent, holdPriority: hold } : a.intent,
                    viewer,
                  );
                }}
                onClose={() => setMenu(null)}
              />
            )}
          </div>
        );
      })}
      {view.hand.length === 0 && (
        <div style={{ color: 'var(--text-faint)', fontSize: 12, alignSelf: 'center' }}>
          Your hand is empty
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action lookup
// ---------------------------------------------------------------------------

/**
 * Actions are only offered while this seat can actually act. Leaving cards looking
 * clickable while the opponent answers a prompt just earns the player an error.
 */
function usable(view: PlayerView): LegalAction[] {
  return canAct(view, view.viewer) ? view.legalActions : [];
}

function useCardActions(view: PlayerView, iid: IID): LegalAction[] {
  return useMemo(
    () =>
      usable(view).filter((a) => {
        if (a.intent.t === 'passPriority' || a.intent.t === 'concede') return false;
        return a.intent.iid === iid;
      }),
    [view, iid],
  );
}

function handActions(view: PlayerView, iid: IID): LegalAction[] {
  const all = usable(view).filter(
    (a) =>
      (a.intent.t === 'castSpell' || a.intent.t === 'playLand') && a.intent.iid === iid,
  );
  // If a free cast is available, that is what a click should do; paying mana for
  // the same spell stays reachable through the menu.
  const free = all.filter((a) => a.intent.t === 'castSpell' && a.intent.free);
  if (free.length > 0 && all.length > 1) return [...free, ...all.filter((a) => !free.includes(a))];
  return all;
}

/** A short reason the card is greyed out, so the player never has to guess. */
function whyNotPlayable(view: PlayerView, iid: IID): string | undefined {
  const c = view.cards[iid];
  if (!c) return undefined;
  // Before timing and mana: a card the engine cannot resolve is never playable,
  // and "not enough mana" would be a lie about it.
  const gap = unimplementedReason(c.oracleId);
  if (gap) return gap;
  if (!canAct(view, view.viewer)) return undefined;
  const face = frontFace(c.oracleId);
  const full = oracle(c.oracleId);
  const isLand = face.types.includes('Land') || (full.faces?.[1]?.types.includes('Land') ?? false);
  const sorcerySpeed =
    !face.types.includes('Instant') && !face.keywords.includes('Flash');
  const myMainEmpty =
    view.activePlayer === view.viewer &&
    (view.phase === 'precombat_main' || view.phase === 'postcombat_main') &&
    view.stack.length === 0;

  if (isLand && !face.types.includes('Instant')) {
    if (!myMainEmpty) return 'main phase only';
    if (view.players[view.viewer].landDropsUsed >= view.players[view.viewer].landDropsAllowed) {
      return 'land drop used';
    }
  }
  if (sorcerySpeed && !myMainEmpty) return 'sorcery speed';
  return 'not enough mana';
}

export { isType, cardTitle };
