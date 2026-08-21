import { useEffect, useState } from 'react';
import { MANA_KINDS } from '@engine/mana';
import { SCENARIOS, type ScenarioSpec } from '@engine/scenario';
import type { PlayerId } from '@engine/types';
import { Board } from './Board';
import { probeCardArt } from './CardView';
import { LocalConnection, RemoteConnection, type Connection } from './connection';
import { useAutoPass, useHotkeys, useOmniscienceHold, useTriggerPolicy } from './hooks';
import { SettingsPanel, HelpPanel } from './panels';
import { useStore } from './store';
import { PhaseTrack } from './ui';

/**
 * Shell: lobby, the two chrome bars and the always-visible state of the comfort
 * features. Everything the hotkeys do is also a button here, on purpose.
 */

type Mode = 'lab' | 'goldfish' | 'online';

export function App() {
  const connection = useStore((s) => s.connection);
  const viewSeat = useStore((s) => s.viewSeat);
  const setArtAvailable = useStore((s) => s.setArtAvailable);
  const [mode, setMode] = useState<Mode>('lab');

  // One probe decides art vs text cards for the whole session.
  useEffect(() => {
    let cancelled = false;
    probeCardArt().then((ok) => {
      if (!cancelled) setArtAvailable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [setArtAvailable]);

  if (!connection) return <Lobby onStart={setMode} />;
  return <Game viewer={viewSeat} mode={mode} />;
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function Lobby({ onStart }: { onStart: (m: Mode) => void }) {
  const attach = useStore((s) => s.attach);
  const [room, setRoom] = useState('');

  const startLocal = (mode: Mode, scenario?: ScenarioSpec) => {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const conn = new LocalConnection({
      seed,
      startingPlayer: Math.random() < 0.5 ? 'p1' : 'p2',
      seats: ['p1', 'p2'],
      scenario,
    });
    onStart(mode);
    attach(conn as Connection, 'p1');
  };

  const startOnline = () => {
    const code = room.trim() || Math.random().toString(36).slice(2, 7).toUpperCase();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const conn = new RemoteConnection({
      url: `${proto}://${location.host}/ws`,
      room: code,
      playerName: 'player',
    });
    onStart('online');
    attach(conn as Connection, 'p1');
  };

  return (
    <div className="lobby">
      <div className="lobby-card">
        <h1>Show and Tell — the mirror</h1>
        <p>
          Both players run the same sixty cards. The only secrets left are order,
          count, and what you are about to put onto the battlefield.
        </p>

        <div className="mode-grid">
          <button className="mode-option" onClick={() => startLocal('lab')}>
            <b>Lab</b>
            <span>
              Play both seats yourself. Best for learning lines and testing interactions.
            </span>
          </button>
          <button className="mode-option" onClick={() => startLocal('goldfish')}>
            <b>Goldfish</b>
            <span>
              You play, the other seat does nothing. For drilling the combo turn.
            </span>
          </button>
        </div>

        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-dim)' }}>
            Drills — jump straight to a decision this deck actually faces
          </summary>
          <div className="mode-grid" style={{ marginTop: 10 }}>
            {Object.entries(SCENARIOS).map(([key, spec]) => (
              <button
                key={key}
                className="mode-option"
                data-testid={`drill-${key}`}
                onClick={() => startLocal('lab', spec)}
              >
                <b>{spec.name}</b>
                <span>{spec.description}</span>
              </button>
            ))}
          </div>
        </details>

        <div className="row">
          <input
            type="text"
            placeholder="room code (blank makes one)"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={startOnline}>
            Play online
          </button>
        </div>
        <p style={{ fontSize: 11 }}>
          Online needs the server running: <code>npm run server</code>. Card images
          come from Scryfall; this is an unofficial fan project.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

function Game({ viewer, mode }: { viewer: PlayerId; mode: Mode }) {
  const view = useStore((s) => s.views[viewer]);
  const error = useStore((s) => s.error);
  const dismissError = useStore((s) => s.dismissError);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const helpOpen = useStore((s) => s.helpOpen);

  useFollowActingSeat(mode === 'lab');
  useAutoPass(viewer);
  useTriggerPolicy(viewer);
  useHotkeys(viewer);
  useOmniscienceHold(viewer);
  useGoldfishOpponent(mode === 'goldfish' ? (viewer === 'p1' ? 'p2' : 'p1') : null);

  if (!view) {
    return (
      <div className="lobby">
        <div className="lobby-card">
          <h1>Waiting for the other player…</h1>
          <p>Share your room code. The game starts when both seats are filled.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar viewer={viewer} mode={mode} />
      <Board viewer={viewer} />
      <BottomBar viewer={viewer} />
      {view.winner !== null && <GameOver viewer={viewer} />}
      {settingsOpen && <SettingsPanel />}
      {helpOpen && <HelpPanel />}
      {error && (
        <div className="toast">
          {error}
          <button onClick={dismissError}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

function TopBar({ viewer, mode }: { viewer: PlayerId; mode: Mode }) {
  const view = useStore((s) => s.views[viewer])!;
  const toggle = useStore((s) => s.toggle);
  const setViewSeat = useStore((s) => s.setViewSeat);
  const controls = useStore((s) => s.controls);
  const triggers = useStore((s) => s.settings.triggers);
  const update = useStore((s) => s.updateSettings);
  const other: PlayerId = viewer === 'p1' ? 'p2' : 'p1';

  return (
    <div className="topbar">
      <strong style={{ letterSpacing: '-0.01em' }}>Show and Tell</strong>
      <PhaseTrack view={view} />
      {view.omniscienceActive && (
        <span className="chip free" title="Every spell in your hand costs nothing">
          Omniscience · free
        </span>
      )}

      {/* The trigger policy bar. Visible during the combo turn, when it matters. */}
      <span className="chip" title="Auto-answer for Hullbreaker Horror's trigger">
        Hullbreaker
        <select
          value={triggers.hullbreaker}
          onChange={(e) =>
            update({ triggers: { ...triggers, hullbreaker: e.target.value as never } })
          }
        >
          <option value="ask">ask me</option>
          <option value="none">choose nothing</option>
          <option value="bounceOpposingSpell">bounce their spell</option>
          <option value="bounceBest">bounce the best thing</option>
        </select>
      </span>
      <span className="chip" title="Auto-answer for Orcish Bowmasters">
        Bowmasters
        <select
          value={triggers.bowmasters}
          onChange={(e) =>
            update({ triggers: { ...triggers, bowmasters: e.target.value as never } })
          }
        >
          <option value="ask">ask me</option>
          <option value="opponentFace">their face</option>
          <option value="ifUnambiguous">only if obvious</option>
        </select>
      </span>
      <span className="chip" title="Hold Alt to be asked despite the policy above">
        <kbd>Alt</kbd>
      </span>

      <span className="spacer" />
      {mode === 'lab' && controls(other) && (
        <>
          <span className="chip on" title="Lab mode follows whichever seat has to act">
            Playing seat {viewer === 'p1' ? '1' : '2'}
          </span>
          <button onClick={() => setViewSeat(other)}>
            Switch to seat {other === 'p1' ? '1' : '2'}
          </button>
        </>
      )}
      <button onClick={() => toggle('settingsOpen')} title="Settings (,)">
        Settings
      </button>
      <button onClick={() => toggle('helpOpen')} title="Shortcuts (?)">
        ?
      </button>
    </div>
  );
}

function BottomBar({ viewer }: { viewer: PlayerId }) {
  const view = useStore((s) => s.views[viewer])!;
  const send = useStore((s) => s.send);
  const cancel = useStore((s) => s.cancel);
  const autoPass = useStore((s) => s.autoPass);
  const setAutoPass = useStore((s) => s.setAutoPass);
  const hold = useStore((s) => s.holdPriority);
  const setHold = useStore((s) => s.setHoldPriority);
  const forceStop = useStore((s) => s.forceStop);
  const warnFloating = useStore((s) => s.settings.warnOnFloatingMana);
  const [confirmFloat, setConfirmFloat] = useState(false);

  const pool = view.players[viewer].manaPool;
  const floating = MANA_KINDS.reduce((n, k) => n + pool[k], 0);
  const myPriority = view.priorityPlayer === viewer && !view.choice;

  const doPass = () => {
    if (floating > 0 && warnFloating) {
      setConfirmFloat(true);
      return;
    }
    send({ t: 'passPriority' }, viewer);
  };

  return (
    <div className="bottombar">
      <button className="primary" disabled={!myPriority} onClick={doPass}>
        Pass <kbd>space</kbd>
      </button>
      <button
        disabled={!myPriority && autoPass === 'off'}
        onClick={() => setAutoPass(autoPass === 'endOfTurn' ? 'off' : 'endOfTurn')}
      >
        {autoPass === 'endOfTurn' ? 'Stop passing' : 'Pass to end of turn'} <kbd>F6</kbd>
      </button>
      <button
        disabled={!myPriority && autoPass === 'off'}
        onClick={() => setAutoPass(autoPass === 'myNextTurn' ? 'off' : 'myNextTurn')}
      >
        {autoPass === 'myNextTurn' ? 'Stop passing' : 'Pass to my turn'} <kbd>F8</kbd>
      </button>

      <label className={`chip${hold ? ' on' : ''}`} style={{ cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={hold}
          onChange={(e) => setHold(e.target.checked)}
          style={{ margin: 0 }}
        />
        Hold priority <kbd>H</kbd>
      </label>

      {forceStop && <span className="chip warn">Ctrl held — will stop</span>}
      {floating > 0 && (
        <span className="chip warn">
          {floating} floating mana — lost at end of phase
        </span>
      )}

      <span className="spacer" />
      <button onClick={() => cancel()} title="Back out of the current action (Esc)">
        Cancel <kbd>Esc</kbd>
      </button>
      <button
        className="danger"
        onClick={() => {
          if (confirm('Concede this game?')) send({ t: 'concede' }, viewer);
        }}
      >
        Concede
      </button>

      {confirmFloat && (
        <div className="overlay" onClick={() => setConfirmFloat(false)}>
          <div className="dialog" style={{ minWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <h2>You have {floating} unspent mana</h2>
            <div className="prompt">
              It empties at the end of this phase. Mana Drain mana in particular is
              usually the whole plan.
            </div>
            <div className="actions">
              <button onClick={() => setConfirmFloat(false)}>Stay here</button>
              <button
                className="primary"
                onClick={() => {
                  setConfirmFloat(false);
                  send({ t: 'passPriority' }, viewer);
                }}
              >
                Pass anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GameOver({ viewer }: { viewer: PlayerId }) {
  const view = useStore((s) => s.views[viewer])!;
  const detach = useStore((s) => s.detach);
  const won = view.winner === viewer;
  return (
    <div className="overlay">
      <div className="dialog gameover" style={{ minWidth: 380 }}>
        <div className={`headline ${won ? 'win' : 'lose'}`}>{won ? 'You win' : 'You lose'}</div>
        <div className="prompt">{view.endReason}</div>
        <div className="actions" style={{ justifyContent: 'center' }}>
          <button className="primary" onClick={() => detach()}>
            Back to the lobby
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Lab mode: follow whoever has to act.
 *
 * Without this, a prompt raised for the seat you are not looking at is invisible and
 * the game appears to hang. Switching is only ever done when the seat on screen has
 * genuinely nothing to do.
 */
function useFollowActingSeat(enabled: boolean) {
  const views = useStore((s) => s.views);
  const viewSeat = useStore((s) => s.viewSeat);
  const setViewSeat = useStore((s) => s.setViewSeat);
  const controls = useStore((s) => s.controls);

  useEffect(() => {
    if (!enabled) return;
    const other: PlayerId = viewSeat === 'p1' ? 'p2' : 'p1';
    if (!controls(other)) return;
    const mine = views[viewSeat];
    const theirs = views[other];
    if (!mine || !theirs || mine.winner !== null) return;

    // A secret choice you have already committed to no longer needs you.
    const stillMine =
      mine.choice?.kind === 'simultaneousSecret'
        ? !mine.choice.iHaveLockedIn
        : Boolean(mine.choice) || mine.priorityPlayer === viewSeat;
    const needsThem =
      theirs.choice?.kind === 'simultaneousSecret'
        ? !theirs.choice.iHaveLockedIn
        : Boolean(theirs.choice) || theirs.priorityPlayer === other;

    if (!stillMine && needsThem) setViewSeat(other);
  }, [views, viewSeat, enabled, controls, setViewSeat]);
}

/**
 * A do-nothing opponent for goldfishing: keeps every hand, passes every priority,
 * never attacks or blocks. Enough to practise the combo turn against a clock-free
 * board without needing a second person.
 */
function useGoldfishOpponent(seat: PlayerId | null) {
  const views = useStore((s) => s.views);
  const send = useStore((s) => s.send);
  const respond = useStore((s) => s.respond);

  const view = seat ? views[seat] : null;
  useEffect(() => {
    if (!seat || !view || view.winner !== null) return;
    const t = window.setTimeout(() => {
      const choice = view.choice;
      if (choice) {
        switch (choice.kind) {
          case 'mulligan':
            respond({ kind: 'yesNo', value: true }, seat);
            break;
          case 'yesNo':
            respond({ kind: 'yesNo', value: false }, seat);
            break;
          case 'chooseCards':
            respond(
              {
                kind: 'cards',
                iids: choice.options.filter((o) => !o.disabledReason).slice(0, choice.min).map((o) => o.iid),
              },
              seat,
            );
            break;
          case 'chooseTargets':
            respond(
              { kind: 'targets', targets: choice.optional ? [] : choice.candidates.slice(0, choice.count) },
              seat,
            );
            break;
          case 'chooseMode':
            respond({ kind: 'modes', modes: [] }, seat);
            break;
          case 'orderTriggers':
            respond({ kind: 'order', ids: choice.triggers.map((x) => x.id) }, seat);
            break;
          case 'declareAttackers':
            respond({ kind: 'attackers', iids: [] }, seat);
            break;
          case 'declareBlockers':
            respond({ kind: 'blockers', blocks: [] }, seat);
            break;
          case 'distributeDamage':
            respond({ kind: 'damage', assignment: { [choice.blockers[0]]: choice.total } }, seat);
            break;
          case 'simultaneousSecret':
            respond({ kind: 'secret', iid: null }, seat);
            break;
        }
        return;
      }
      if (view.priorityPlayer === seat) send({ t: 'passPriority' }, seat);
    }, 120);
    return () => window.clearTimeout(t);
  });
}
