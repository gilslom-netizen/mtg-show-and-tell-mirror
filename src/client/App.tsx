import { useEffect, useRef, useState } from 'react';
import { MANA_KINDS } from '@engine/mana';
import { summarise, type MatchState } from '@engine/match';
import { SCENARIOS, type ScenarioSpec } from '@engine/scenario';
import type { PlayerId } from '@engine/types';
import { Board } from './Board';
import { probeCardArt } from './CardView';
import {
  HttpConnection,
  LocalConnection,
  RemoteConnection,
  probeOnline,
  type Connection,
  type OnlineCapability,
} from './connection';
import {
  useAutoPass,
  useHotkeys,
  useRepeatRunner,
  useTriggerPolicy,
} from './hooks';
import { MAX_REPEATS, describePattern, detectPattern } from './repeat';
import { SettingsPanel, HelpPanel } from './panels';
import { inviteLink, normaliseRoomCode, randomRoomCode, roomFromUrl } from './room-code';
import { canAct, useStore } from './store';
import { PhaseTrack } from './ui';
import { DraftScreen } from './Draft';
import { DeckBuilder } from './DeckBuilder';
// Imported directly rather than through the agent registry, which would drag the
// search, the determinizer and the measuring instruments into the app bundle.
import { HeuristicAgent } from '../ai/heuristic';
import type { Agent } from '../ai/agent';
import { clearPlayed, downloadPlayed, summarisePlayed } from './history';

/**
 * Shell: lobby, the two chrome bars and the always-visible state of the comfort
 * features. Everything the hotkeys do is also a button here, on purpose.
 */

type Mode = 'lab' | 'goldfish' | 'ai' | 'online';

/** One instance for the tab: the heuristic is stateless, so there is nothing to reset. */
const AI_OPPONENT: Agent = new HeuristicAgent();

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
  return <Session viewer={viewSeat} mode={mode} />;
}

/**
 * Which screen a connected session is on.
 *
 * A classic room only ever plays. A drafted one walks draft → build → game, and
 * comes back to the builder between games so both players can sideboard.
 */
function Session({ viewer, mode }: { viewer: PlayerId; mode: Mode }) {
  const phase = useStore((s) => s.phase);
  const info = useStore((s) => s.connInfo);

  // Online, neither the draft nor the game can start until both seats are taken.
  if (info?.kind === 'remote' && !info.ready) return <WaitingRoom />;

  const screen =
    phase === 'draft' ? (
      <DraftScreen viewer={viewer} />
    ) : phase === 'build' ? (
      <DeckBuilder viewer={viewer} />
    ) : (
      <Game viewer={viewer} mode={mode} />
    );

  return (
    <>
      {screen}
      <OfflineBanner />
    </>
  );
}

/**
 * Says so when the connection has dropped.
 *
 * Until this existed, losing the connection mid-game looked exactly like an
 * opponent taking a long time: the board stopped changing, clicks did nothing,
 * and there was nothing on screen to tell the two apart. It only ever appeared
 * on the waiting screen, which is the one place you are not once a game starts.
 */
function OfflineBanner() {
  const status = useStore((s) => s.connInfo?.status);
  if (status !== 'closed') return null;
  return (
    <div className="offline-banner" role="status" data-testid="offline-banner">
      <span className="pulse-dot" aria-hidden />
      Connection lost — trying to get back in. Nothing you have played is lost; the
      game picks up where it left off.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        const ok = await copyToClipboard(value);
        setDone(ok);
        if (ok) setTimeout(() => setDone(false), 1600);
      }}
      title={value}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/**
 * Shown wherever a player might otherwise wait forever for an opponent who is
 * technically in the same room, on a different instance of it.
 */
function NoStoreWarning() {
  return (
    <p
      data-testid="no-store-warning"
      style={{
        border: '1px solid var(--warn, #c9a227)',
        color: 'var(--warn, #c9a227)',
        borderRadius: 6,
        padding: '8px 10px',
        fontSize: 12,
        margin: '10px 0 0',
      }}
    >
      This host has no shared store, so each request can land on a different
      instance — the two of you may end up in separate copies of the same room, and
      a game can be lost between moves. Playing is usually fine for one sitting. To
      make it reliable, add a <b>KV / Upstash Redis</b> integration to the Vercel
      project and redeploy; or run <code>npm run selfhost</code> and use that
      address instead.
    </p>
  );
}

/**
 * What you have played so far, and a way to take it with you.
 *
 * Every finished local game is written down as its seed and its action log, which
 * is a few kilobytes and is not a summary — replaying it reproduces the game
 * exactly. That is the difference between "I lost three in a row" and something
 * anybody can go and look at, which is the whole reason to keep it.
 */
function PlayedGames() {
  const [summary, setSummary] = useState(() => summarisePlayed());
  if (summary.games === 0) return null;
  return (
    <p className="lobby-note" data-testid="played-summary">
      Saved on this browser: <b>{summary.games}</b>{' '}
      {summary.games === 1 ? 'game' : 'games'} — {summary.wins}W {summary.losses}L
      {summary.draws > 0 ? ` ${summary.draws}D` : ''}, {summary.averageTurns} turns on
      average.{' '}
      <button className="linkish" onClick={() => downloadPlayed()}>
        Download them
      </button>{' '}
      <button
        className="linkish"
        onClick={() => {
          clearPlayed();
          setSummary(summarisePlayed());
        }}
      >
        Clear
      </button>
    </p>
  );
}

function Lobby({ onStart }: { onStart: (m: Mode) => void }) {
  const attach = useStore((s) => s.attach);
  const setOnlineCapability = useStore((s) => s.setOnlineCapability);
  // Pre-filled from the invite link if there is one, otherwise a fresh code.
  const [room, setRoom] = useState(() => roomFromUrl() ?? randomRoomCode());
  const [online, setOnline] = useState<OnlineCapability | null>(null);
  // Whether this tab was opened from an invite link, kept from the first render so
  // it does not flip when the code goes into the address bar.
  const [invited] = useState(() => roomFromUrl() !== null);
  // Drafting is the main way to play; the mirror on its own is the other option.
  const [format, setFormat] = useState<'draft' | 'classic'>('draft');
  const [bestOf, setBestOf] = useState(3);

  // Which online transport is available depends on where this is running: a
  // serverless host has the HTTP API, a laptop with `npm run server` has a socket.
  useEffect(() => {
    let cancelled = false;
    probeOnline().then((c) => {
      if (cancelled) return;
      setOnline(c);
      setOnlineCapability(c);
    });
    return () => {
      cancelled = true;
    };
  }, [setOnlineCapability]);

  const startLocal = (mode: Mode, scenario?: ScenarioSpec) => {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const conn = new LocalConnection({
      seed,
      startingPlayer: Math.random() < 0.5 ? 'p1' : 'p2',
      // Against the computer you hold one seat, exactly as you do online. Lab and
      // goldfish hand you both, which is what makes them practice rather than a game.
      seats: mode === 'ai' ? ['p1'] : ['p1', 'p2'],
      opponent: mode === 'ai' ? AI_OPPONENT : undefined,
      scenario,
    });
    onStart(mode);
    attach(conn as Connection, 'p1');
  };

  const startOnline = () => {
    const code = normaliseRoomCode(room) || randomRoomCode();
    // Format and length only take effect for whoever opens the room; the second
    // player joins into whatever is already set up there.
    const conn = online?.http
      ? new HttpConnection({ room: code, playerName: 'player', format, bestOf })
      : new RemoteConnection({
          url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
          room: code,
          playerName: 'player',
        });
    setRoom(code);
    // Puts the code in the address bar, so the tab is now a shareable invite and a
    // reload rejoins the same room instead of inventing a new one.
    try {
      history.replaceState(null, '', inviteLink(code));
    } catch {
      // A sandboxed iframe may refuse; the code is on screen either way.
    }
    onStart('online');
    attach(conn as Connection, 'p1');
  };

  // Some hosts answer /api and still cannot hold a match reliably: on serverless
  // without a shared store, two requests can land on different instances, each
  // with its own rooms. In practice a single sitting often stays on one instance,
  // so this is a loud warning rather than a locked door — being unable to press
  // the button at all is its own dead end.
  const unreliable = online !== null && online.http && !online.usable;
  /*
   * The socket fallback is the older transport and only ever knew how to run the
   * mirror. Offering the draft there would have taken the choice and quietly
   * given you a classic game instead — the format is decided by whoever opens
   * the room, so there is nowhere for that choice to go. Say so, rather than
   * dropping it on the floor.
   */
  const draftAvailable = online === null || online.http;
  useEffect(() => {
    if (!draftAvailable) setFormat('classic');
  }, [draftAvailable]);

  return (
    <div className="lobby">
      <div className="lobby-card">
        <header className="lobby-head">
          <h1>Show and Tell — the mirror</h1>
          <p>
            Both players run the same sixty cards. The only secrets left are order,
            count, and what you are about to put onto the battlefield.
          </p>
        </header>

        <section className="lobby-section">
          <h2>How you want to play</h2>
          <div className="mode-grid is-two-up">
            <button
              className={`mode-option${format === 'draft' ? ' is-picked' : ''}`}
              data-testid="format-draft"
              aria-pressed={format === 'draft'}
              disabled={!draftAvailable}
              onClick={() => setFormat('draft')}
            >
              <b>Draft, then play</b>
              <span>
                {draftAvailable
                  ? 'Bid coins pile by pile for a shared pool, build around the mirror, then play the series.'
                  : 'Not available on this host — it is serving the socket fallback, which only runs the mirror.'}
              </span>
            </button>
            <button
              className={`mode-option${format === 'classic' ? ' is-picked' : ''}`}
              data-testid="format-classic"
              aria-pressed={format === 'classic'}
              onClick={() => setFormat('classic')}
            >
              <b>The mirror alone</b>
              <span>Skip the draft. Both players run the same sixty and nothing else.</span>
            </button>
          </div>
        </section>

        <section className="lobby-section">
          <h2>Length of the series</h2>
          <div className="segmented" data-testid="best-of" role="group">
            {[1, 3, 5].map((n) => (
              <button
                key={n}
                className={`chip-choice${bestOf === n ? ' is-picked' : ''}`}
                data-testid={`best-of-${n}`}
                aria-pressed={bestOf === n}
                onClick={() => setBestOf(n)}
              >
                Best of {n}
              </button>
            ))}
          </div>
        </section>

        <section className="lobby-section is-primary">
          <h2>Room code</h2>
          <div className="lobby-join">
            <input
              type="text"
              aria-label="Room code"
              data-testid="room-input"
              placeholder="room code"
              value={room}
              onChange={(e) => setRoom(e.target.value.toUpperCase())}
              className="room-input"
            />
            <button onClick={() => setRoom(randomRoomCode())} title="Make a different code">
              New code
            </button>
            <button
              className="primary is-cta"
              data-testid="play-online"
              onClick={startOnline}
              disabled={online === null}
            >
              {unreliable ? 'Play online anyway' : 'Play online'}
            </button>
          </div>
          <p className="lobby-note" data-testid="online-status">
            {invited
              ? 'You opened an invite link — press Play online to take the second seat.'
              : 'Both players must use the same room code. Start here, then send the invite link from the next screen.'}
          </p>
          {unreliable && <NoStoreWarning />}
        </section>

        <section className="lobby-section">
          <h2>Play the computer</h2>
          <button
            className="primary is-cta"
            data-testid="play-ai"
            onClick={() => startLocal('ai')}
          >
            Play the computer
          </button>
          <p className="lobby-note">
            Runs entirely in this tab — no room, no second person, works offline. It
            plays the deck properly: it mulligans, counters what is worth countering,
            picks its Show and Tell in secret like you do, and knows the Bowmasters
            loop. It cannot see your hand; it is given exactly the view you would send
            an opponent online.
          </p>
          <PlayedGames />
        </section>

        <details className="lobby-fold">
          <summary>Experiments — solo modes for learning and testing</summary>
          <div className="mode-grid is-two-up">
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
        </details>

        <details className="lobby-fold">
          <summary>Drills — jump straight to a decision this deck actually faces</summary>
          <div className="mode-grid is-two-up">
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

        <p className="lobby-foot">
          {online === null
            ? 'Checking whether online play is available…'
            : online.http
              ? unreliable
                ? ''
                : 'Online is ready.'
              : 'No match API here — falling back to the socket server on /ws. If nobody joins, run npm run selfhost and open the port it prints.'}
          {' '}Card images come from Scryfall; this is an unofficial fan project.
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
  const info = useStore((s) => s.connInfo);
  const cardScale = useStore((s) => s.settings.cardScale);
  const error = useStore((s) => s.error);
  const dismissError = useStore((s) => s.dismissError);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const helpOpen = useStore((s) => s.helpOpen);

  useFollowActingSeat(mode === 'lab');
  useAutoPass(viewer);
  useTriggerPolicy(viewer);
  useHotkeys(viewer);
  useRepeatRunner();
  useGoldfishOpponent(mode === 'goldfish' ? (viewer === 'p1' ? 'p2' : 'p1') : null);

  // Online, the server hands out a view as soon as this client has a seat — but a
  // game of one is not a game, so the wait is over readiness, not over the view.
  if (!view || (info?.kind === 'remote' && !info.ready)) {
    return <WaitingRoom />;
  }

  return (
    <div
      className="app"
      // One variable drives every card, badge and pip on the table.
      style={{ '--card-scale': String(cardScale) } as React.CSSProperties}
    >
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

/**
 * The screen between joining and playing.
 *
 * It used to say "waiting for the other player" and nothing else — no room code,
 * no connection state, and crucially no errors, because the error toast lives in
 * the branch below this one. A refused join ("that room already has two players"),
 * a dead socket or a host with no shared store all looked identical to a friend
 * who had not clicked yet. Everything it knows now goes on the screen.
 */
function WaitingRoom() {
  const info = useStore((s) => s.connInfo);
  const online = useStore((s) => s.online);
  const error = useStore((s) => s.error);
  const detach = useStore((s) => s.detach);
  const code = info?.room ?? '';
  const seated = info?.players.length ?? 0;
  const [waitedLong, setWaitedLong] = useState(false);

  // Silence past this point is worth a nudge rather than more of the same screen.
  useEffect(() => {
    const t = setTimeout(() => setWaitedLong(true), 25000);
    return () => clearTimeout(t);
  }, []);

  const status =
    info?.status === 'connecting'
      ? { text: 'Connecting…', tone: 'var(--text-dim)' }
      : info?.status === 'closed'
        ? { text: 'Connection lost — retrying', tone: 'var(--bad, #e06c6c)' }
        : { text: `Connected · ${seated} of 2 seats filled`, tone: 'var(--good, #6cc17a)' };

  const leave = () => {
    detach();
    try {
      history.replaceState(null, '', location.pathname);
    } catch {
      // Not being able to tidy the URL is not worth blocking the exit.
    }
  };

  return (
    <div className="lobby">
      <div className="lobby-card">
        <h1>Waiting for the other player…</h1>

        {code && (
          <>
            <p style={{ margin: '14px 0 6px', fontSize: 12, color: 'var(--text-dim)' }}>
              Room code
            </p>
            <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <code
                data-testid="room-code"
                style={{
                  fontSize: 30,
                  letterSpacing: 6,
                  padding: '6px 10px 6px 16px',
                  border: '1px solid var(--line, #2c3444)',
                  borderRadius: 8,
                }}
              >
                {code}
              </code>
              <CopyButton value={code} label="Copy code" />
              <CopyButton value={inviteLink(code)} label="Copy invite link" />
            </div>
          </>
        )}

        <p data-testid="waiting-status" style={{ color: status.tone, fontSize: 13 }}>
          {status.text}
        </p>

        {online?.http && !online.usable && <NoStoreWarning />}

        {waitedLong && seated < 2 && info?.status === 'open' && (
          <p style={{ fontSize: 12, color: 'var(--text-dim)' }} data-testid="waiting-long">
            Still nobody. Check that the other player typed this exact code — or send
            them the invite link, which cannot be typed wrong.
          </p>
        )}

        {error && (
          <p
            data-testid="waiting-error"
            style={{
              color: 'var(--bad, #e06c6c)',
              border: '1px solid currentColor',
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 13,
            }}
          >
            {error}
          </p>
        )}

        <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          The other player has to enter this exact code — or just open the invite
          link. The game starts as soon as both seats are filled, and closing the tab
          does not lose your seat: reopening the same room puts you back where you
          were.
        </p>

        <div className="row">
          <button onClick={leave}>Back to lobby</button>
        </div>
      </div>
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

/**
 * "You have done that three times — want to do it again?"
 *
 * The control only exists once the client has actually watched you repeat
 * something, so it never sits there suggesting automation you did not ask for.
 * Picking a number replays exactly the actions you took, resolved against what
 * is legal at the time, and any click of your own ends the run.
 */
function RepeatControl({ viewer }: { viewer: PlayerId }) {
  const history = useStore((s) => s.actionHistory);
  const historySeat = useStore((s) => s.historySeat);
  const run = useStore((s) => s.repeat);
  const note = useStore((s) => s.repeatNote);
  const dismissNote = useStore((s) => s.dismissRepeatNote);
  const start = useStore((s) => s.startRepeat);
  const stop = useStore((s) => s.stopRepeat);
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(2);
  // The bottom bar scrolls sideways and therefore clips anything positioned
  // inside it, so the popover is a fixed layer measured off the chip instead.
  const anchor = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);

  // Only while it is actually your move: an offer to repeat something during the
  // opponent's turn is an offer you cannot take, and the pattern may be several
  // turns stale by then.
  //
  // Subscribing to the boolean rather than to the view keeps this out of the
  // re-render on every poll — the view object is new each time even when nothing
  // about it that matters here has changed.
  const canRepeatNow = useStore((s) => {
    const v = s.views[viewer];
    return !!v && canAct(v, viewer);
  });
  const pattern = canRepeatNow && historySeat === viewer ? detectPattern(history) : null;

  // The popover must not outlive the thing it is about.
  useEffect(() => {
    if (!pattern || run) setOpen(false);
  }, [pattern?.steps.map((s) => s.sig).join('|'), run]); // eslint-disable-line react-hooks/exhaustive-deps

  if (run) {
    return (
      <button
        className="chip on"
        data-testid="repeat-stop"
        onClick={() => stop()}
        title="Stop repeating"
      >
        ⟳ Repeating · {run.remaining} left — stop
      </button>
    );
  }

  if (note) {
    return (
      <button className="chip warn" data-testid="repeat-note" onClick={dismissNote} title={note}>
        {note}
      </button>
    );
  }

  if (!pattern) return null;

  const go = (times: number) => {
    setOpen(false);
    start(pattern.steps, times, viewer);
  };

  const place = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    setAt({
      left: Math.max(8, Math.min(r.left, window.innerWidth - 440)),
      bottom: window.innerHeight - r.top + 8,
    });
  };

  return (
    <span className="repeat-control">
      <button
        ref={anchor}
        className="chip"
        data-testid="repeat-open"
        onClick={() => {
          place();
          setOpen((o) => !o);
        }}
        title={`You have done this ${pattern.times} times in a row`}
      >
        ⟳ Repeat: {describePattern(pattern.steps)}
      </button>
      {open && at && (
        <div
          className="repeat-pop"
          data-testid="repeat-pop"
          style={{ left: at.left, bottom: at.bottom }}
        >
          <div className="bid-note">
            How many more times? Each round is {pattern.steps.length}{' '}
            {pattern.steps.length === 1 ? 'action' : 'actions'}, and any click of your own
            stops it.
          </div>
          <div className="row">
            {[1, 2, 3, 5].map((n) => (
              <button key={n} data-testid={`repeat-${n}`} onClick={() => go(n)}>
                ×{n}
              </button>
            ))}
            <input
              type="number"
              min={1}
              max={MAX_REPEATS}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(MAX_REPEATS, Number(e.target.value))))}
              style={{ width: 66 }}
              aria-label="How many times"
            />
            <button className="primary" data-testid="repeat-go" onClick={() => go(count)}>
              Go
            </button>
          </div>
          <div className="row">
            <button data-testid="repeat-max" onClick={() => go(MAX_REPEATS)}>
              As many as possible
            </button>
          </div>
        </div>
      )}
    </span>
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
  const myPriority = canAct(view, viewer);

  const doPass = () => {
    if (floating > 0 && warnFloating) {
      setConfirmFloat(true);
      return;
    }
    send({ t: 'passPriority' }, viewer);
  };

  // The warning is only meaningful while the mana is still there and the decision
  // is still yours; otherwise it would sit on screen saying "you have 0 unspent
  // mana" and block the board.
  useEffect(() => {
    if (confirmFloat && (floating === 0 || !myPriority)) setConfirmFloat(false);
  }, [confirmFloat, floating, myPriority]);

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

      <RepeatControl viewer={viewer} />

      <label className={`chip${hold ? ' on' : ''}`} style={{ cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={hold}
          onChange={(e) => setHold(e.target.checked)}
          style={{ margin: 0 }}
        />
        Hold priority <kbd>H</kbd>
      </label>

      {/* Principle: it must always be obvious who is being waited on. */}
      {view.winner === null &&
        (myPriority ? (
          <span className="chip on">➤ your move</span>
        ) : (
          <span className="chip">⏳ waiting for opponent</span>
        ))}
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

/**
 * End of a game inside a best-of-three.
 *
 * The loser chooses play or draw for the next game — which in a combo mirror is
 * not a formality, so it is a real prompt rather than an assumed "on the play".
 */
function GameOver({ viewer }: { viewer: PlayerId }) {
  const view = useStore((s) => s.views[viewer])!;
  const detach = useStore((s) => s.detach);
  const connection = useStore((s) => s.connection);
  const match: MatchState | null = connection?.match() ?? null;
  const won = view.winner === viewer;
  const opponent: PlayerId = viewer === 'p1' ? 'p2' : 'p1';

  const chooseFirst = (onPlay: PlayerId) => connection?.chooseFirst(viewer, onPlay);

  if (!match) {
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

  const stats = summarise(match.history);
  const myChoice = match.awaitingFirstChoiceFrom === viewer;
  const matchOver = match.matchWinner !== null;

  return (
    <div className="overlay">
      <div className="dialog gameover" style={{ minWidth: 460 }}>
        <div className={`headline ${won ? 'win' : 'lose'}`}>
          {matchOver
            ? match.matchWinner === viewer
              ? 'You win the match'
              : 'You lose the match'
            : won
              ? `Game ${match.history.length} to you`
              : `Game ${match.history.length} to them`}
        </div>
        <div className="prompt">{view.endReason}</div>

        <div className="row" style={{ justifyContent: 'center', fontSize: 20, fontWeight: 800 }}>
          <span style={{ color: 'var(--mine)' }}>{match.wins[viewer]}</span>
          <span style={{ color: 'var(--text-faint)' }}>—</span>
          <span style={{ color: 'var(--theirs)' }}>{match.wins[opponent]}</span>
          <span className="chip">best of {match.bestOf}</span>
        </div>

        {stats.games > 0 && (
          <div style={{ textAlign: 'left' }}>
            <div className="setting-row">
              <span>Games won by the player on the play</span>
              <span>
                {stats.onPlayWins} / {stats.games}
              </span>
            </div>
            <div className="setting-row">
              <span>Average game length</span>
              <span>{stats.averageTurns} turns</span>
            </div>
            {Object.entries(stats.byReason).map(([reason, n]) => (
              <div className="setting-row" key={reason}>
                <span style={{ color: 'var(--text-dim)' }}>{reason}</span>
                <span>{n}</span>
              </div>
            ))}
            {stats.repeatWarning && (
              <div className="prompt" style={{ color: 'var(--warn)', marginTop: 8 }}>
                {stats.repeatWarning}
              </div>
            )}
          </div>
        )}

        {matchOver ? (
          <div className="actions" style={{ justifyContent: 'center' }}>
            <button className="primary" onClick={() => detach()}>
              Back to the lobby
            </button>
          </div>
        ) : myChoice ? (
          <>
            <div className="prompt">You lost that one, so you choose for game {match.gameNumber + 1}.</div>
            <div className="actions" style={{ justifyContent: 'center' }}>
              <button onClick={() => chooseFirst(opponent)}>Draw first</button>
              <button className="primary" onClick={() => chooseFirst(viewer)}>
                Play first
              </button>
            </div>
          </>
        ) : (
          <div className="prompt">
            Waiting for them to choose play or draw for game {match.gameNumber + 1}…
          </div>
        )}
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
  const connection = useStore((s) => s.connection);

  useEffect(() => {
    if (!enabled) return;
    const other: PlayerId = viewSeat === 'p1' ? 'p2' : 'p1';
    if (!controls(other)) return;
    const mine = views[viewSeat];
    const theirs = views[other];
    if (!mine || !theirs) return;

    // Between games the loser picks play or draw — follow them too.
    const awaiting = connection?.match()?.awaitingFirstChoiceFrom ?? null;
    if (awaiting && awaiting !== viewSeat) {
      setViewSeat(awaiting);
      return;
    }
    if (mine.winner !== null) return;

    // A secret choice you have already committed to no longer needs you.
    //
    // `canAct` is what makes this correct: while the OTHER seat answers a prompt,
    // this seat is still named as the priority player but cannot do anything.
    // Testing priority alone deadlocks the table — the view never moves to the seat
    // that actually has the open prompt.
    const stillMine =
      mine.choice?.kind === 'simultaneousSecret'
        ? !mine.choice.iHaveLockedIn
        : Boolean(mine.choice) || canAct(mine, viewSeat);
    const needsThem =
      theirs.choice?.kind === 'simultaneousSecret'
        ? !theirs.choice.iHaveLockedIn
        : Boolean(theirs.choice) || canAct(theirs, other);

    if (!stillMine && needsThem) setViewSeat(other);
  }, [views, viewSeat, enabled, controls, setViewSeat, connection]);
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

