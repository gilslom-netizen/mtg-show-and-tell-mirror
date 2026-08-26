import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { frontFace, oracle } from '@engine/oracle';
import type { PlayerView } from '@engine/redact';
import { MANA_KINDS } from '@engine/mana';
import type { ManaKind, ManaPool, PlayerId, Step } from '@engine/types';
import { CardFace } from './CardView';
import { Pip } from './mana';
import { useStore } from './store';

/** Small, shared pieces of chrome. */

export const STEP_LABEL: Record<Step, string> = {
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  main: 'Main',
  begin_combat: 'Begin combat',
  declare_attackers: 'Attackers',
  declare_blockers: 'Blockers',
  combat_damage: 'Damage',
  end_of_combat: 'End of combat',
  end_step: 'End step',
  cleanup: 'Cleanup',
};

export function seatClass(seat: PlayerId, viewer: PlayerId): string {
  return seat === viewer ? 'seat-mine' : 'seat-theirs';
}

/**
 * A dialog that is actually on top of everything.
 *
 * `.overlay` is `position: fixed` with a high z-index, which is enough right up
 * until it is rendered inside something that has made its own stacking context.
 * The player bar is `position: sticky; z-index: 4`, so the graveyard opened from
 * it was painted *inside* that layer: the turn divider and the bar itself came
 * out on top of the dialog, and the cards in it were sliced in half. z-index 60
 * cannot beat z-index 5 when the 60 is nested inside a 4.
 *
 * A portal moves the markup to the end of `document.body`, where there is no
 * ancestor to be trapped under. Nothing changes visually — the overlay was
 * already `fixed` — so this is safe for any dialog, and the ones that are
 * already at the top level lose nothing by using it.
 */
export function Overlay({
  children,
  className = '',
  style,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className={`overlay ${className}`.trim()} style={style} onClick={onClick}>
      {children}
    </div>,
    document.body,
  );
}

export function ManaWidget({ pool, floating }: { pool: ManaPool; floating: boolean }) {
  const total = MANA_KINDS.reduce((n, k) => n + pool[k], 0);
  if (total === 0) return null;
  return (
    <span
      className={`mana-widget${floating ? ' floating' : ''}`}
      title={floating ? 'This mana empties at the end of the phase' : 'Mana pool'}
    >
      {/*
        The same pip the costs are drawn with, rather than a bare `pip W` that
        matched no colour rule at all — the pool was a row of identical grey
        circles, so floating {U}{U}{B} could not be told from {B}{B}{B}.
      */}
      {MANA_KINDS.flatMap((k) =>
        Array.from({ length: pool[k] }, (_, i) => (
          <Pip key={`${k}${i}`} symbol={{ raw: k, kind: 'colour', colours: [k], label: k }} />
        )),
      )}
      {floating && <span style={{ fontSize: 11 }}>empties at end of phase</span>}
    </span>
  );
}

/**
 * The graveyard, opened from the number that says how big it is.
 *
 * There used to be a separate "Graveyard N" chip somewhere else on the board,
 * which a playtester never found — he asked for a way to click the yard and see
 * what was in it, about a feature that existed. The count *is* the button now:
 * the thing you were already looking at is the thing you click.
 */
function YardStat({
  view,
  seat,
  viewer,
}: {
  view: PlayerView;
  seat: PlayerId;
  viewer: PlayerId;
}) {
  const [open, setOpen] = useState(false);
  const gy = view.graveyard[seat];
  const ex = view.exile[seat];
  return (
    <>
      <button
        className="stat as-button"
        disabled={gy.length === 0 && ex.length === 0}
        title={gy.length === 0 ? 'Nothing in the graveyard yet' : 'Look through the graveyard'}
        onClick={() => setOpen(true)}
      >
        <b>{view.players[seat].graveyardCount}</b> yard
      </button>
      {open && (
        <Overlay onClick={() => setOpen(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{seat === viewer ? 'Your graveyard' : "Opponent's graveyard"}</h2>
            {gy.length === 0 ? (
              <div className="prompt">Nothing there yet.</div>
            ) : (
              <div className="card-grid">
                {gy.map((iid) => (
                  <CardFace key={iid} card={view.cards[iid] ?? null} viewer={viewer} size="small" />
                ))}
              </div>
            )}
            {ex.length > 0 && (
              <>
                <h2 style={{ marginTop: 12 }}>Exile</h2>
                <div className="card-grid">
                  {ex.map((iid) => (
                    <CardFace key={iid} card={view.cards[iid] ?? null} viewer={viewer} size="small" />
                  ))}
                </div>
              </>
            )}
            <div className="actions">
              <button onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        </Overlay>
      )}
    </>
  );
}

export function PlayerBar({
  view,
  seat,
  viewer,
}: {
  view: PlayerView;
  seat: PlayerId;
  viewer: PlayerId;
}) {
  const p = view.players[seat];
  const isActive = view.activePlayer === seat;
  const hasPriority = view.priorityPlayer === seat;
  const drained = view.delayedMana.filter((d) => d.controller === seat);
  return (
    <div className={`playerbar ${seatClass(seat, viewer)}${hasPriority ? ' has-priority' : ''}`}>
      <span className="seat-name">{seat === viewer ? 'You' : 'Opponent'}</span>
      <span className={`stat life${p.life <= 5 ? ' low' : ''}`}>
        <b>{p.life}</b> life
      </span>
      <span className="stat">
        <b>{p.handCount}</b> hand
      </span>
      <span className="stat">
        <b>{p.libraryCount}</b> library
      </span>
      <YardStat view={view} seat={seat} viewer={viewer} />
      {/*
        Who was on the play is public and permanent — a playtester who could not
        see it read his own legal first draw as a bug — but it never changes, and
        sitting between the name and the life total it pushed every number that
        does change a chip's width further away from the player it belongs to.
        It reads just as well after them.
      */}
      <span className="chip dim" title="Decided before the first mulligan">
        {view.startingPlayer === seat ? 'on the play' : 'on the draw'}
      </span>
      {p.spellsCastThisTurnCount > 0 && (
        <span className="chip" title="Spells cast this turn — Hullbreaker Horror counts these">
          {p.spellsCastThisTurnCount} cast
        </span>
      )}
      <ManaWidget pool={p.manaPool} floating />
      {drained.length > 0 && (
        <span className="chip warn" title="Mana Drain will add this at the start of your next main phase">
          +{drained.reduce((n, d) => n + d.amount, 0)} next main
        </span>
      )}
      <span className="spacer" />
      {isActive && <span className="active-marker">turn</span>}
      {hasPriority && <span className="chip on">priority</span>}
    </div>
  );
}

export function PhaseTrack({ view }: { view: PlayerView }) {
  /*
   * Big enough to play by. "I meant to surveil and did not understand what phase
   * it was" is a quote from a real game - the phase existed on screen, in a chip
   * sized for people who already knew where they were.
   */
  return (
    <span className="phase-track" title={`${view.phase} / ${view.step}`}>
      <span className="phase-turn">Turn {view.turn}</span>
      <b>{STEP_LABEL[view.step]}</b>
    </span>
  );
}

export function StackPanel({ view, viewer }: { view: PlayerView; viewer: PlayerId }) {
  const setHighlight = useStore((s) => s.setHighlight);
  return (
    <div className="panel">
      <h3>Stack {view.stack.length > 0 && `(${view.stack.length})`}</h3>
      {view.stack.length === 0 ? (
        <div className="stack-empty">empty</div>
      ) : (
        <div className="stack-list">
          {view.stack.map((iid) => {
            const c = view.cards[iid];
            if (!c) return null;
            const name = c.isAbility
              ? `${c.abilitySourceName ?? labelFor(view, c.abilitySource)}: ${c.abilityLabel ?? 'ability'}`
              : cardTitle(view, iid);
            const art = frontFace(c.oracleId)?.imageUri ?? null;
            return (
              <div
                key={iid}
                className={`stack-item ${seatClass(c.controller, viewer)}`}
                onMouseEnter={() => setHighlight([iid, ...(c.abilitySource ? [c.abilitySource] : [])])}
                onMouseLeave={() => setHighlight([])}
              >
                {/* The card itself, not only its name - an ability shows the card
                    it came from. Reading the stack should not require the log. */}
                {art && <img className="stack-thumb" src={art} alt="" loading="lazy" />}
                <div>
                  {name}
                  {c.castForFree && <span className="chip free" style={{ marginLeft: 6 }}>free</span>}
                </div>
                {c.targets && c.targets.length > 0 && (
                  <div className="targets">
                    → {c.targets.map((t) => targetName(view, t)).join(', ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function labelFor(view: PlayerView, iid?: number): string {
  if (iid === undefined) return 'Ability';
  return cardTitle(view, iid);
}

export function cardTitle(view: PlayerView, iid: number): string {
  const c = view.cards[iid];
  if (!c) return 'a card';
  if (c.isToken) return c.tokenName ?? 'Token';
  const card = oracle(c.oracleId);
  return card.faces ? card.faces[c.face === 'back' ? 1 : 0].name : card.name;
}

export function targetName(view: PlayerView, t: { kind: string; iid?: number; id?: string }): string {
  if (t.kind === 'player') return t.id === view.viewer ? 'you' : 'opponent';
  return cardTitle(view, t.iid!);
}

export function LogPanel({ view, viewer }: { view: PlayerView; viewer: PlayerId }) {
  const setHighlight = useStore((s) => s.setHighlight);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [view.log.length]);

  /*
   * The log is the longest list on screen — up to two hundred lines — and the
   * view is a fresh object on every poll, so without this it was two hundred
   * elements and four hundred handlers rebuilt every time anything happened.
   * Log lines are append-only and never change once written, so the length
   * together with the newest sequence number identifies the whole list: it is
   * only rebuilt when a line is actually added, or when a new game restarts the
   * numbering.
   */
  const newest = view.log.length > 0 ? view.log[view.log.length - 1].seq : 0;
  const lines = useMemo(
    () =>
      view.log.map((line) => {
        const isTurnMarker = line.text.startsWith('—');
        return (
          <div
            key={line.seq}
            className={`log-line ${isTurnMarker ? 'turn-marker' : line.player ? seatClass(line.player, viewer) : ''}`}
            onMouseEnter={() => setHighlight(line.iids)}
            onMouseLeave={() => setHighlight([])}
          >
            {!isTurnMarker && line.player && (
              <span className="who">{line.player === viewer ? 'You' : 'Opp'}</span>
            )}
            {line.text}
          </div>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view.log.length, newest, viewer, setHighlight],
  );

  return (
    <div className="panel" ref={ref} style={{ borderBottom: 'none' }}>
      <h3>Game log</h3>
      <div className="log">{lines}</div>
    </div>
  );
}

/**
 * The known-top-of-library tracker.
 *
 * This is memory, not information: it only ever lists cards the player was shown,
 * and it wipes itself the moment anything shuffles.
 */
export function KnownTopPanel({ view, viewer }: { view: PlayerView; viewer: PlayerId }) {
  const known = useStore((s) => s.knownTop[viewer]);
  const setHighlight = useStore((s) => s.setHighlight);
  const visible = known;
  return (
    <div className="panel">
      <h3>Top of your library</h3>
      {visible.length === 0 ? (
        <div className="stack-empty">nothing known — the last shuffle cleared it</div>
      ) : (
        <div className="known-top">
          {visible.slice(0, 6).map((e, i) => (
            <div
              key={`${e.iid}-${i}`}
              className="entry"
              onMouseEnter={() => setHighlight([e.iid])}
              onMouseLeave={() => setHighlight([])}
            >
              <span className="idx">{i + 1}.</span>
              {/* From the entry's own memory, never from the live view - the view
                  forgets the card the moment redaction stops including it. */}
              <span>{e.oracleId ? frontFace(e.oracleId).name : cardTitle(view, e.iid)}</span>
            </div>
          ))}
          <div className="entry">
            <span className="idx">{visible.length + 1}.</span>
            <span className="unknown">unknown</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function ManaPips({ pool }: { pool: ManaPool }) {
  const kinds = MANA_KINDS.filter((k: ManaKind) => pool[k] > 0);
  if (kinds.length === 0) return <span style={{ color: 'var(--text-faint)' }}>—</span>;
  return (
    <>
      {kinds.map((k) => (
        <span key={k} className={`pip ${k}`}>
          {pool[k] > 1 ? pool[k] : k}
        </span>
      ))}
    </>
  );
}
