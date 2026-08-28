import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { PlayerView, ChoiceView } from '@engine/redact';
import type { ChoiceResponse, IID, PlayerId, TargetRef } from '@engine/types';
import { cardsToBottom, handSizeAfter } from '@engine/state';
import { CardFace } from './CardView';
import { describePrompt } from './repeat';
import { cardTitle, targetName } from './ui';
import { useStore } from './store';

/**
 * Every prompt the engine can raise, rendered so that the common answer is one
 * click away and the reason a card is not selectable is always visible.
 */

/**
 * Shown while the other player is answering something.
 *
 * The mulligan is where this mattered most: both players are asked at once now,
 * but the London bottoming step still runs one at a time, and before this there
 * was nothing on screen at all during it.
 */
function WaitingOnOpponent({ view }: { view: PlayerView }) {
  const what =
    view.mode === 'mulligan'
      ? 'Your opponent is putting cards on the bottom…'
      : 'Waiting for your opponent…';
  return (
    <div className="overlay is-soft">
      <div className="dialog waiting-dialog">
        <MinimiseButton />
        <span className="spinner" aria-hidden />
        <div className="prompt">{what}</div>
      </div>
    </div>
  );
}

/**
 * Every decision can be put aside for a moment.
 *
 * A prompt is a modal over the board, and the board is usually exactly what you
 * need to look at before answering it: how many untapped lands they have, what
 * is in the graveyards, what the log says happened. Minimising hides the dialog
 * without answering it and leaves the table fully visible; the decision waits in
 * a bar at the top until you bring it back. Nothing is sent either way, so this
 * is safe at any point in any prompt.
 */
const MinimiseCtx = createContext<(() => void) | null>(null);

function MinimiseButton() {
  const minimise = useContext(MinimiseCtx);
  if (!minimise) return null;
  return (
    <button
      className="dialog-minimise"
      data-testid="minimise-choice"
      onClick={minimise}
      title="Look at the board (B). Nothing is answered — the decision waits for you."
      aria-label="Hide this decision and look at the board"
    >
      ⤢
    </button>
  );
}

function MinimisedBar({ prompt, onRestore }: { prompt: string; onRestore: () => void }) {
  return (
    <button className="choice-minimised" data-testid="restore-choice" onClick={onRestore}>
      <span className="pulse-dot" aria-hidden />
      <b>Decision waiting</b>
      <span className="choice-minimised-what">{prompt}</span>
      <span className="chip">Back to it</span>
    </button>
  );
}


export function ChoiceLayer({ view, viewer }: { view: PlayerView; viewer: PlayerId }) {
  const choice = view.choice;
  const respond = useStore((s) => s.respond);
  const revealing = useStore((s) => s.revealing);
  const clearReveal = useStore((s) => s.clearReveal);
  const animMs = useStore((s) => s.settings.animationMs);
  const [minimised, setMinimised] = useState(false);

  useEffect(() => {
    if (!revealing) return;
    const t = setTimeout(() => clearReveal(), Math.max(700, animMs * 4));
    return () => clearTimeout(t);
  }, [revealing, clearReveal, animMs]);

  // A new question is a new question: it always arrives in front of you.
  useEffect(() => setMinimised(false), [choice?.id]);

  // B for board, both ways. Deliberately not Escape, which already means
  // "back out of what I was doing" everywhere else.
  useEffect(() => {
    if (!choice) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return;
      if (e.key === 'b' || e.key === 'B') setMinimised((m) => !m);
      else if (e.key === 'Escape' && minimised) setMinimised(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choice, minimised]);

  if (revealing) {
    return <RevealOverlay view={view} viewer={viewer} reveal={revealing} />;
  }
  // A prompt that belongs to the other player is still something happening to
  // you. Silence here is what made a slow opponent look like a crashed client.
  if (!choice && view.waitingOnOpponentChoice) {
    return <WaitingOnOpponent view={view} />;
  }
  if (!choice) return null;

  if (minimised) {
    return <MinimisedBar prompt={describePrompt(choice)} onRestore={() => setMinimised(false)} />;
  }

  const answer = (r: ChoiceResponse) => respond(r, viewer);

  // Every dialog is keyed by the choice id. Without this React reuses the component
  // across two consecutive prompts of the same kind and the previous selection
  // survives — which sends a card that is not even an option for the new prompt.
  const key = choice.id;

  const dialog = (() => {
    switch (choice.kind) {
      case 'simultaneousSecret':
        return <ShowAndTellDialog key={key} view={view} viewer={viewer} choice={choice} onAnswer={answer} />;
      case 'chooseCards':
        return <ChooseCardsDialog key={key} view={view} viewer={viewer} choice={choice} onAnswer={answer} />;
      case 'chooseTargets':
        return <ChooseTargetsDialog key={key} view={view} viewer={viewer} choice={choice} onAnswer={answer} />;
      case 'chooseMode':
        return <ChooseModeDialog key={key} choice={choice} onAnswer={answer} />;
      case 'yesNo':
        return <YesNoDialog key={key} choice={choice} onAnswer={answer} />;
      case 'mulligan':
        return <MulliganDialog key={key} view={view} viewer={viewer} choice={choice} onAnswer={answer} />;
      case 'orderTriggers':
        return <OrderTriggersDialog key={key} view={view} choice={choice} onAnswer={answer} />;
      case 'declareAttackers':
        return <DeclareAttackersDialog key={key} view={view} viewer={viewer} choice={choice} onAnswer={answer} />;
      case 'declareBlockers':
        return <DeclareBlockersDialog key={key} view={view} viewer={viewer} choice={choice} onAnswer={answer} />;
      case 'distributeDamage':
        return <DistributeDamageDialog key={key} view={view} choice={choice} onAnswer={answer} />;
    }
  })();

  // Only a real decision gets the minimise control: the reveal and the "waiting
  // on them" spinner are above this and have nothing to come back to.
  return (
    <MinimiseCtx.Provider value={() => setMinimised(true)}>{dialog}</MinimiseCtx.Provider>
  );
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
  const selectable = choice.myOptions.filter((o) => !o.disabledReason);

  // Guard against a selection outliving its prompt even if the key above is lost.
  useEffect(() => setPicked(null), [choice.id]);

  return (
    <div className="overlay">
      <div className="dialog sat-dialog">
        <MinimiseButton />
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
              {choice.myOptions.length > 0 && selectable.length === 0 && (
                <div className="prompt">
                  Nothing in your hand can be put onto the battlefield this way.
                </div>
              )}
            </div>
            <div className="actions">
              <button onClick={() => onAnswer({ kind: 'secret', iid: null })}>
                Put nothing
              </button>
              <button
                className="primary"
                disabled={picked === null || !selectable.some((o) => o.iid === picked)}
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
        <MinimiseButton />
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
        <MinimiseButton />
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
          {/* Atraxa asks about one card type at a time and the answers depend on
              each other, so a question can be pushed to the back of the queue
              rather than guessed at. Nothing is taken and nothing is lost. */}
          {choice.deferrable && (
            <button
              data-testid="defer-choice"
              title="Skip to the other card types and come back to this one"
              onClick={() => onAnswer({ kind: 'cards', iids: [], deferred: true })}
            >
              {choice.deferrable}
            </button>
          )}
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
  /*
   * One target is a click; more than one is a selection.
   *
   * The request has always carried a count and this dialog has always sent
   * exactly one target, which was invisible for as long as every card in the
   * format targeted once. Mindbreak Trap exiles any number of the spells on the
   * stack, and sending one of the four they just cast is not that card.
   */
  const many = choice.count > 1;
  const [chosen, setChosen] = useState<TargetRef[]>([]);
  const isChosen = (t: TargetRef) => chosen.some((c) => sameRef(c, t));
  const pick = (t: TargetRef) => {
    if (!many) {
      onAnswer({ kind: 'targets', targets: [t] });
      return;
    }
    setChosen((prev) =>
      prev.some((c) => sameRef(c, t))
        ? prev.filter((c) => !sameRef(c, t))
        : prev.length < choice.count
          ? [...prev, t]
          : prev,
    );
  };
  const players = choice.candidates.filter((c) => c.kind === 'player');
  const cards = choice.candidates.filter((c) => c.kind !== 'player');

  return (
    <div className="overlay">
      <div className="dialog">
        <MinimiseButton />
        <h2>{many ? `Choose up to ${choice.count} targets` : 'Choose a target'}</h2>
        <div className="prompt">{choice.prompt}</div>
        {players.length > 0 && (
          <div className="row">
            {players.map((t) => (
              <button
                key={`p-${t.kind === 'player' ? t.id : ''}`}
                className={many && isChosen(t) ? 'primary' : undefined}
                onClick={() => pick(t)}
              >
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
                  selected={many && isChosen(t)}
                  onClick={() => pick(t)}
                />
              );
            })}
          </div>
        )}
        {many ? (
          <div className="actions">
            <button
              className="primary"
              disabled={chosen.length === 0 && !choice.optional}
              onClick={() => onAnswer({ kind: 'targets', targets: chosen })}
            >
              {chosen.length === 0 ? 'No targets' : `Confirm ${chosen.length}`}
            </button>
          </div>
        ) : (
          choice.optional && (
            <div className="actions">
              <button onClick={() => onAnswer({ kind: 'targets', targets: [] })}>No target</button>
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** Two target references pointing at the same thing. */
function sameRef(a: TargetRef, b: TargetRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'player' && b.kind === 'player') return a.id === b.id;
  return 'iid' in a && 'iid' in b && a.iid === b.iid;
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
        <MinimiseButton />
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
        <MinimiseButton />
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
  const bottoming = cardsToBottom(choice.mulligansTaken);
  // What shipping this hand would leave you with — seven, while the free one is
  // still going. Reading "Mulligan to 7" off the button is the whole feature.
  const next = handSizeAfter(choice.mulligansTaken + 1);
  return (
    <div className="overlay">
      <div className="dialog">
        <MinimiseButton />
        <h2>
          Opening hand
          {choice.mulligansTaken > 0 && ` · mulligan ${choice.mulligansTaken}`}
        </h2>
        {/* The single most keep-relevant fact after the cards themselves. */}
        <div className={`play-draw ${view.startingPlayer === viewer ? 'is-play' : 'is-draw'}`}>
          {view.startingPlayer === viewer
            ? 'You are on the play — you skip your first draw.'
            : 'You are on the draw.'}
        </div>
        <div className="prompt">
          {choice.iHaveDecided
            ? 'Decision locked in. Waiting for your opponent…'
            : bottoming > 0
              ? `Keep? You will put ${bottoming} card${bottoming > 1 ? 's' : ''} on the bottom.`
              : choice.prompt}
        </div>

        <div className="card-grid">
          {view.hand.map((iid) => (
            <CardFace key={iid} card={view.cards[iid] ?? null} viewer={viewer} size="large" />
          ))}
        </div>

        {/* Both players decide at the same time, so both states are worth showing. */}
        <div className="mulligan-status">
          <span className={choice.iHaveDecided ? 'is-done' : ''}>
            You {choice.iHaveDecided ? 'have decided' : 'are deciding'}
          </span>
          <span className={choice.opponentDecided ? 'is-done' : ''}>
            Opponent {choice.opponentDecided ? 'has decided' : 'is deciding'}
            {choice.opponentMulligansTaken > 0 &&
              ` · down to ${handSizeAfter(choice.opponentMulligansTaken)}`}
          </span>
        </div>

        {choice.iHaveDecided ? (
          <div className="actions">
            <span className="spinner" aria-label="waiting" />
          </div>
        ) : (
          <div className="actions">
            <button onClick={() => onAnswer({ kind: 'yesNo', value: false })}>
              {next === 7 ? 'Free mulligan' : `Mulligan to ${next}`}
            </button>
            <button className="primary" onClick={() => onAnswer({ kind: 'yesNo', value: true })}>
              Keep {view.hand.length - bottoming}
            </button>
          </div>
        )}
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
        <MinimiseButton />
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
        <MinimiseButton />
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

  /*
   * One attacker is not a question.
   *
   * The two clicks are "which creature blocks" and "what does it block", and a
   * playtester said the second was not intuitive when there was only ever one
   * answer to it — "it makes some sense but it still wasn't". It is right that
   * you say which attacker when there are several; with one, saying it is a
   * formality the game can carry out for you.
   */
  const onlyAttacker = choice.attackers.length === 1 ? choice.attackers[0] : null;

  const unblocked = choice.attackers.filter((a) => !Object.values(blocks).includes(a));
  const incoming = unblocked.reduce((n, a) => n + (view.cards[a]?.power ?? 0), 0);

  return (
    <div className="overlay">
      <div className="dialog">
        <MinimiseButton />
        <h2>Declare blockers</h2>
        <div className="prompt">
          {onlyAttacker !== null
            ? `Pick the creatures that block ${cardTitle(view, onlyAttacker)}. Pick one again to take it back.`
            : selecting === null
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
                  if (onlyAttacker !== null) {
                    setBlocks((b) => ({ ...b, [iid]: onlyAttacker }));
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
        <MinimiseButton />
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
