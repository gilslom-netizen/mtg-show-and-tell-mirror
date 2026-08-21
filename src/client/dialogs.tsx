import { useEffect, useMemo, useState } from 'react';
import type { PlayerView, ChoiceView } from '@engine/redact';
import type { ChoiceResponse, IID, PlayerId, TargetRef } from '@engine/types';
import { CardFace } from './CardView';
import { cardTitle, targetName } from './ui';
import { useStore } from './store';

/**
 * Every prompt the engine can raise, rendered so that the common answer is one
 * click away and the reason a card is not selectable is always visible.
 */

export function ChoiceLayer({ view, viewer }: { view: PlayerView; viewer: PlayerId }) {
  const choice = view.choice;
  const respond = useStore((s) => s.respond);
  const revealing = useStore((s) => s.revealing);
  const clearReveal = useStore((s) => s.clearReveal);
  const animMs = useStore((s) => s.settings.animationMs);

  useEffect(() => {
    if (!revealing) return;
    const t = setTimeout(() => clearReveal(), Math.max(700, animMs * 4));
    return () => clearTimeout(t);
  }, [revealing, clearReveal, animMs]);

  if (revealing) {
    return <RevealOverlay view={view} viewer={viewer} reveal={revealing} />;
  }
  if (!choice) return null;

  const answer = (r: ChoiceResponse) => respond(r, viewer);

  switch (choice.kind) {
    case 'simultaneousSecret':
      return <ShowAndTellDialog view={view} viewer={viewer} choice={choice} onAnswer={answer} />;
    case 'chooseCards':
      return <ChooseCardsDialog view={view} viewer={viewer} choice={choice} onAnswer={answer} />;
    case 'chooseTargets':
      return <ChooseTargetsDialog view={view} viewer={viewer} choice={choice} onAnswer={answer} />;
    case 'chooseMode':
      return <ChooseModeDialog choice={choice} onAnswer={answer} />;
    case 'yesNo':
      return <YesNoDialog choice={choice} onAnswer={answer} />;
    case 'mulligan':
      return <MulliganDialog view={view} viewer={viewer} choice={choice} onAnswer={answer} />;
    case 'orderTriggers':
      return <OrderTriggersDialog view={view} choice={choice} onAnswer={answer} />;
    case 'declareAttackers':
      return <DeclareAttackersDialog view={view} viewer={viewer} choice={choice} onAnswer={answer} />;
    case 'declareBlockers':
      return <DeclareBlockersDialog view={view} viewer={viewer} choice={choice} onAnswer={answer} />;
    case 'distributeDamage':
      return <DistributeDamageDialog view={view} choice={choice} onAnswer={answer} />;
  }
}

type Answer = (r: ChoiceResponse) => void;

// ---------------------------------------------------------------------------
// Show and Tell — the format's signature moment
// ---------------------------------------------------------------------------

function ShowAndTellDialog({
  view,
  viewer,
  choice,
  onAnswer,
}: {
  view: PlayerView;
  viewer: PlayerId;
  choice: Extract<ChoiceView, { kind: 'simultaneousSecret' }>;
  onAnswer: Answer;
}) {
  const [picked, setPicked] = useState<IID | null>(null);
  const locked = choice.iHaveLockedIn;

  return (
    <div className="overlay">
      <div className="dialog sat-dialog">
        <h2>Show and Tell</h2>
        <div className={`sat-status${choice.opponentLockedIn ? ' locked' : ''}`}>
          {choice.opponentLockedIn ? '🔒 Opponent has locked in' : '⏳ Opponent is choosing…'}
          <span className="spacer" />
          {locked && <span>Waiting for them…</span>}
        </div>

        {locked ? (
          <div className="prompt">
            Your choice is locked. Neither of you can see the other&apos;s pick until both
            have committed.
          </div>
        ) : (
          <>
            <div className="prompt">{choice.myPrompt}</div>
            <div className="card-grid">
              {choice.myOptions.map((o) => (
                <CardFace
                  key={o.iid}
                  card={view.cards[o.iid] ?? null}
                  viewer={viewer}
                  selected={picked === o.iid}
                  disabledReason={o.disabledReason}
                  onClick={() => setPicked(picked === o.iid ? null : o.iid)}
                />
              ))}
              {choice.myOptions.length === 0 && (
                <div className="prompt">Your hand is empty.</div>
              )}
            </div>
            <div className="actions">
              <button onClick={() => onAnswer({ kind: 'secret', iid: null })}>
                Put nothing
              </button>
              <button
                className="primary"
                disabled={picked === null}
                onClick={() => onAnswer({ kind: 'secret', iid: picked })}
              >
                Lock in {picked !== null ? cardTitle(view, picked) : ''}
              </button>
            </div>
            <div className="prompt" style={{ fontSize: 11 }}>
              Locking in cannot be undone.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RevealOverlay({
  view,
  viewer,
  reveal,
}: {
  view: PlayerView;
  viewer: PlayerId;
  reveal: { p1: IID | null; p2: IID | null };
}) {
  const mine = viewer === 'p1' ? reveal.p1 : reveal.p2;
  const theirs = viewer === 'p1' ? reveal.p2 : reveal.p1;
  return (
    <div className="overlay" style={{ pointerEvents: 'none' }}>
      <div className="dialog sat-dialog" style={{ alignItems: 'center' }}>
        <h2>Show and Tell</h2>
        <div className="sat-reveal">
          <div>
            <div className="side-label">You</div>
            <div className="flip-in">
              <CardFace card={mine ? (view.cards[mine] ?? null) : null} viewer={viewer} size="large" />
            </div>
          </div>
          <div>
            <div className="side-label">Opponent</div>
            <div className="flip-in" style={{ animationDelay: '80ms' }}>
              <CardFace
                card={theirs ? (view.cards[theirs] ?? null) : null}
                viewer={viewer}
                size="large"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic prompts
// ---------------------------------------------------------------------------

function ChooseCardsDialog({
  view,
  viewer,
  choice,
  onAnswer,
}: {
  view: PlayerView;
  viewer: PlayerId;
  choice: Extract<ChoiceView, { kind: 'chooseCards' }>;
  onAnswer: Answer;
}) {
  const selectable = useMemo(
    () => choice.options.filter((o) => !o.disabledReason).map((o) => o.iid),
    [choice.options],
  );
  // When the whole list has to be ordered, start with the order already shown so
  // "keep this order" is a single click.
  const initial = choice.ordered && choice.min === selectable.length ? selectable : [];
  const [chosen, setChosen] = useState<IID[]>(initial);

  useEffect(() => setChosen(initial), [choice.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (iid: IID) => {
    setChosen((cur) => {
      if (cur.includes(iid)) return cur.filter((x) => x !== iid);
      if (cur.length >= choice.max) {
        // Replace the oldest pick rather than silently ignoring the click.
        return choice.max === 1 ? [iid] : [...cur.slice(1), iid];
      }
      return [...cur, iid];
    });
  };

  const ready = chosen.length >= choice.min && chosen.length <= choice.max;
  const isOrderOnly = choice.ordered && choice.min === selectable.length && choice.min > 1;

  return (
    <div className="overlay">
      <div className="dialog">
        <h2>{isOrderOnly ? 'Choose an order' : 'Choose'}</h2>
        <div className="prompt">
          {choice.prompt}
          {choice.publicReveal && ' — both players can see these cards'}
        </div>
        <div className="card-grid">
          {choice.options.map((o) => (
            <CardFace
              key={o.iid}
              card={view.cards[o.iid] ?? null}
              viewer={viewer}
              selected={chosen.includes(o.iid)}
              selectionIndex={
                choice.ordered && chosen.includes(o.iid) ? chosen.indexOf(o.iid) : undefined
              }
              disabledReason={o.disabledReason}
              onClick={() => toggle(o.iid)}
            />
          ))}
        </div>
        <div className="actions">
          <span className="chip">
            {chosen.length} / {choice.min === choice.max ? choice.min : `${choice.min}–${choice.max}`}
          </span>
          {choice.min === 0 && (
            <button onClick={() => onAnswer({ kind: 'cards', iids: [] })}>Choose none</button>
          )}
          <button className="primary" disabled={!ready} onClick={() => onAnswer({ kind: 'cards', iids: chosen })}>
            {isOrderOnly ? 'Confirm order' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChooseTargetsDialog({
  view,
  viewer,
  choice,
  onAnswer,
}: {
  view: PlayerView;
  viewer: PlayerId;
  choice: Extract<ChoiceView, { kind: 'chooseTargets' }>;
  onAnswer: Answer;
}) {
  const pick = (t: TargetRef) => onAnswer({ kind: 'targets', targets: [t] });
  const players = choice.candidates.filter((c) => c.kind === 'player');
  const cards = choice.candidates.filter((c) => c.kind !== 'player');

  return (
    <div className="overlay">
      <div className="dialog">
        <h2>Choose a target</h2>
        <div className="prompt">{choice.prompt}</div>
        {players.length > 0 && (
          <div className="row">
            {players.map((t) => (
              <button key={`p-${t.kind === 'player' ? t.id : ''}`} onClick={() => pick(t)}>
                {targetName(view, t)}
              </button>
            ))}
          </div>
        )}
        {cards.length > 0 && (
          <div className="card-grid">
            {cards.map((t) => {
              const iid = (t as { iid: IID }).iid;
              return (
                <CardFace
                  key={iid}
                  card={view.cards[iid] ?? null}
                  viewer={viewer}
                  onClick={() => pick(t)}
                />
              );
            })}
          </div>
        )}
        {choice.optional && (
          <div className="actions">
            <button onClick={() => onAnswer({ kind: 'targets', targets: [] })}>No target</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ChooseModeDialog({
  choice,
  onAnswer,
}: {
  choice: Extract<ChoiceView, { kind: 'chooseMode' }>;
  onAnswer: Answer;
}) {
  return (
    <div className="overlay">
      <div className="dialog" style={{ minWidth: 420 }}>
        <h2>Choose a mode</h2>
        <div className="prompt">{choice.prompt}</div>
        <div className="mode-grid">
          {choice.modes.map((m) => (
            <button
              key={m.index}
              className="mode-option"
              disabled={!m.enabled}
              onClick={() => onAnswer({ kind: 'modes', modes: [m.index] })}
            >
              <b>{m.text}</b>
              {!m.enabled && <span>{m.disabledReason}</span>}
            </button>
          ))}
          {choice.min === 0 && (
            <button className="mode-option" onClick={() => onAnswer({ kind: 'modes', modes: [] })}>
              <b>Choose nothing</b>
              <span>&ldquo;Up to one&rdquo; allows zero</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function YesNoDialog({
  choice,
  onAnswer,
}: {
  choice: Extract<ChoiceView, { kind: 'yesNo' }>;
  onAnswer: Answer;
}) {
  return (
    <div className="overlay">
      <div className="dialog" style={{ minWidth: 360 }}>
        <h2>{choice.prompt}</h2>
        <div className="actions">
          <button onClick={() => onAnswer({ kind: 'yesNo', value: false })}>
            {choice.noLabel ?? 'No'}
          </button>
          <button className="primary" onClick={() => onAnswer({ kind: 'yesNo', value: true })}>
            {choice.yesLabel ?? 'Yes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function MulliganDialog({
  view,
  viewer,
  choice,
  onAnswer,
}: {
  view: PlayerView;
  viewer: PlayerId;
  choice: Extract<ChoiceView, { kind: 'mulligan' }>;
  onAnswer: Answer;
}) {
  return (
    <div className="overlay">
      <div className="dialog">
        <h2>Opening hand</h2>
        <div className="prompt">
          {choice.prompt}
          {choice.mulligansTaken > 0 && ` (mulligan ${choice.mulligansTaken})`}
        </div>
        <div className="card-grid">
          {view.hand.map((iid) => (
            <CardFace key={iid} card={view.cards[iid] ?? null} viewer={viewer} />
          ))}
        </div>
        <div className="actions">
          <button onClick={() => onAnswer({ kind: 'yesNo', value: false })}>Mulligan</button>
          <button className="primary" onClick={() => onAnswer({ kind: 'yesNo', value: true })}>
            Keep
          </button>
        </div>
      </div>
    </div>
  );
}

function OrderTriggersDialog({
  view,
  choice,
  onAnswer,
}: {
  view: PlayerView;
  choice: Extract<ChoiceView, { kind: 'orderTriggers' }>;
  onAnswer: Answer;
}) {
  const [order, setOrder] = useState<number[]>(choice.triggers.map((t) => t.id));
  useEffect(() => setOrder(choice.triggers.map((t) => t.id)), [choice.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (id: number, dir: -1 | 1) => {
    setOrder((cur) => {
      const i = cur.indexOf(id);
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  return (
    <div className="overlay">
      <div className="dialog" style={{ minWidth: 440 }}>
        <h2>Order your triggers</h2>
        <div className="prompt">
          {choice.prompt}. These are identical unless you need a specific order.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {order.map((id, i) => {
            const t = choice.triggers.find((x) => x.id === id)!;
            return (
              <div key={id} className="stack-item">
                <div className="row">
                  <span className="chip">{i + 1}</span>
                  <span>
                    {cardTitle(view, t.sourceIid)} — {t.label}
                  </span>
                  <span className="spacer" />
                  <button onClick={() => move(id, -1)} disabled={i === 0}>
                    ↑
                  </button>
                  <button onClick={() => move(id, 1)} disabled={i === order.length - 1}>
                    ↓
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="actions">
          <button className="primary" onClick={() => onAnswer({ kind: 'order', ids: order })}>
            Confirm order
          </button>
        </div>
      </div>
    </div>
  );
}

function DeclareAttackersDialog({
  view,
  viewer,
  choice,
  onAnswer,
}: {
  view: PlayerView;
  viewer: PlayerId;
  choice: Extract<ChoiceView, { kind: 'declareAttackers' }>;
  onAnswer: Answer;
}) {
  const [chosen, setChosen] = useState<IID[]>([]);
  useEffect(() => setChosen([]), [choice.id]);
  const total = chosen.reduce((n, iid) => n + (view.cards[iid]?.power ?? 0), 0);

  return (
    <div className="overlay">
      <div className="dialog">
        <h2>Declare attackers</h2>
        <div className="prompt">Click the creatures that should attack.</div>
        <div className="card-grid">
          {choice.candidates.map((iid) => (
            <CardFace
              key={iid}
              card={view.cards[iid] ?? null}
              viewer={viewer}
              selected={chosen.includes(iid)}
              onClick={() =>
                setChosen((c) => (c.includes(iid) ? c.filter((x) => x !== iid) : [...c, iid]))
              }
            />
          ))}
        </div>
        <div className="actions">
          {chosen.length > 0 && <span className="chip">{total} damage incoming</span>}
          <button onClick={() => onAnswer({ kind: 'attackers', iids: [] })}>Attack with none</button>
          <button
            className="primary"
            disabled={chosen.length === 0}
            onClick={() => onAnswer({ kind: 'attackers', iids: chosen })}
          >
            Attack with {chosen.length}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeclareBlockersDialog({
  view,
  viewer,
  choice,
  onAnswer,
}: {
  view: PlayerView;
  viewer: PlayerId;
  choice: Extract<ChoiceView, { kind: 'declareBlockers' }>;
  onAnswer: Answer;
}) {
  const [blocks, setBlocks] = useState<Record<IID, IID>>({});
  const [selecting, setSelecting] = useState<IID | null>(null);
  useEffect(() => {
    setBlocks({});
    setSelecting(null);
  }, [choice.id]);

  const assign = (attacker: IID) => {
    if (selecting === null) return;
    setBlocks((b) => ({ ...b, [selecting]: attacker }));
    setSelecting(null);
  };

  const unblocked = choice.attackers.filter((a) => !Object.values(blocks).includes(a));
  const incoming = unblocked.reduce((n, a) => n + (view.cards[a]?.power ?? 0), 0);

  return (
    <div className="overlay">
      <div className="dialog">
        <h2>Declare blockers</h2>
        <div className="prompt">
          {selecting === null
            ? 'Pick one of your creatures, then pick the attacker it blocks.'
            : `Now pick the attacker ${cardTitle(view, selecting)} should block.`}
        </div>

        <div>
          <div className="zone-label">Attackers</div>
          <div className="card-grid">
            {choice.attackers.map((iid) => {
              const blockedBy = Object.entries(blocks)
                .filter(([, a]) => a === iid)
                .map(([b]) => Number(b));
              return (
                <div key={iid} style={{ textAlign: 'center' }}>
                  <CardFace
                    card={view.cards[iid] ?? null}
                    viewer={viewer}
                    onClick={selecting !== null ? () => assign(iid) : undefined}
                    className={selecting !== null ? 'castable' : ''}
                  />
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                    {blockedBy.length > 0
                      ? `blocked by ${blockedBy.map((b) => cardTitle(view, b)).join(', ')}`
                      : 'unblocked'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div className="zone-label">Your creatures</div>
          <div className="card-grid">
            {choice.blockers.map((iid) => (
              <CardFace
                key={iid}
                card={view.cards[iid] ?? null}
                viewer={viewer}
                selected={selecting === iid || blocks[iid] !== undefined}
                onClick={() => {
                  if (blocks[iid] !== undefined) {
                    setBlocks((b) => {
                      const next = { ...b };
                      delete next[iid];
                      return next;
                    });
                    return;
                  }
                  setSelecting(selecting === iid ? null : iid);
                }}
              />
            ))}
          </div>
        </div>

        <div className="actions">
          <span className={`chip${incoming >= view.players[viewer].life ? ' warn' : ''}`}>
            {incoming} damage would get through
          </span>
          <button onClick={() => onAnswer({ kind: 'blockers', blocks: [] })}>No blocks</button>
          <button
            className="primary"
            onClick={() =>
              onAnswer({
                kind: 'blockers',
                blocks: Object.entries(blocks).map(([b, a]) => ({
                  blocker: Number(b),
                  attacker: a,
                })),
              })
            }
          >
            Confirm blocks
          </button>
        </div>
      </div>
    </div>
  );
}

function DistributeDamageDialog({
  view,
  choice,
  onAnswer,
}: {
  view: PlayerView;
  choice: Extract<ChoiceView, { kind: 'distributeDamage' }>;
  onAnswer: Answer;
}) {
  const [amounts, setAmounts] = useState<Record<IID, number>>(() => {
    const first = choice.blockers[0];
    return { [first]: choice.total };
  });
  const assigned = Object.values(amounts).reduce((a, b) => a + b, 0);

  return (
    <div className="overlay">
      <div className="dialog" style={{ minWidth: 420 }}>
        <h2>Assign combat damage</h2>
        <div className="prompt">{choice.prompt}</div>
        {choice.blockers.map((iid) => (
          <div key={iid} className="setting-row">
            <span>{cardTitle(view, iid)}</span>
            <input
              type="number"
              min={0}
              max={choice.total}
              value={amounts[iid] ?? 0}
              onChange={(e) =>
                setAmounts((a) => ({ ...a, [iid]: Math.max(0, Number(e.target.value)) }))
              }
            />
          </div>
        ))}
        <div className="actions">
          <span className="chip">
            {assigned} / {choice.total}
          </span>
          <button
            className="primary"
            disabled={assigned !== choice.total}
            onClick={() => onAnswer({ kind: 'damage', assignment: amounts })}
          >
            Assign
          </button>
        </div>
      </div>
    </div>
  );
}
