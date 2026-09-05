import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { Game, type Intent } from '../engine/game.js';
import { MAINDECK } from '../engine/deck.js';
import { MatchTracker, seriesLength } from '../engine/match.js';
import { redact, redactEvents } from '../engine/redact.js';
import type { ChoiceResponse, PlayerId } from '../engine/types.js';
import { handleApiRequest } from './node-api.js';

/**
 * The authoritative server.
 *
 * The engine only ever runs here for an online match, and every client is handed a
 * redacted view. That matters more in this format than in most: knowing the top of
 * a library or a Show and Tell pick early simply wins the game.
 *
 * Because a game is fully determined by (seed, action log), the log is all that is
 * persisted. A reconnect replays it; a server restart can rebuild the match.
 */

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = join(process.cwd(), 'data', 'matches');

type ClientMsg =
  | { t: 'join'; room: string; name?: string; token?: string; bestOf?: number }
  | { t: 'intent'; intent: Intent }
  | { t: 'choice'; choiceId: string; response: ChoiceResponse }
  | { t: 'cancel' }
  | { t: 'chooseFirst'; onPlay: PlayerId }
  | { t: 'offerExtend' }
  | { t: 'answerExtend'; accept: boolean }
  | { t: 'rematch' };

type LoggedAction =
  | { k: 'intent'; seat: PlayerId; intent: Intent }
  | { k: 'choice'; seat: PlayerId; choiceId: string; response: ChoiceResponse };

interface Seat {
  token: string;
  name: string;
  socket: WebSocket | null;
}

interface Room {
  code: string;
  seed: number;
  startingPlayer: PlayerId;
  game: Game;
  seats: Partial<Record<PlayerId, Seat>>;
  log: LoggedAction[];
  /** Series bookkeeping across games in this room. */
  match: MatchTracker;
}

const rooms = new Map<string, Room>();

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function matchFile(code: string): string {
  return join(DATA_DIR, `${code.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
}

function persist(room: Room): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      matchFile(room.code),
      JSON.stringify(
        {
          code: room.code,
          seed: room.seed,
          startingPlayer: room.startingPlayer,
          bestOf: room.match.state.bestOf,
          tokens: Object.fromEntries(
            Object.entries(room.seats).map(([s, v]) => [s, { token: v!.token, name: v!.name }]),
          ),
          log: room.log,
        },
        null,
        1,
      ),
    );
  } catch (e) {
    console.error('could not persist match', (e as Error).message);
  }
}

function newGame(seed: number, startingPlayer: PlayerId): Game {
  const game = Game.create({
    gameId: `srv-${seed}`,
    seed,
    deck: MAINDECK,
    startingPlayer,
  });
  game.advance();
  return game;
}

/** Rebuilds a room by replaying its action log — deterministic, so it always matches. */
function restore(code: string): Room | null {
  const file = matchFile(code);
  if (!existsSync(file)) return null;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      seed: number;
      startingPlayer: PlayerId;
      /** Absent on rooms persisted before the series length was configurable. */
      bestOf?: number;
      tokens: Record<string, { token: string; name: string }>;
      log: LoggedAction[];
    };
    const game = newGame(saved.seed, saved.startingPlayer);
    for (const a of saved.log) {
      try {
        if (a.k === 'intent') game.submitIntent(a.seat, a.intent);
        else game.submitChoice(a.seat, a.choiceId, a.response);
      } catch (e) {
        // A log that no longer replays cleanly means the engine changed under it.
        // Better to start fresh than to serve a half-rebuilt game.
        console.error(`replay of ${code} failed:`, (e as Error).message);
        return null;
      }
    }
    game.flushEvents();
    const seats: Room['seats'] = {};
    for (const [s, v] of Object.entries(saved.tokens)) {
      seats[s as PlayerId] = { token: v.token, name: v.name, socket: null };
    }
    const match = new MatchTracker(saved.startingPlayer, seriesLength(saved.bestOf));
    match.noteResult(game);
    return {
      code,
      seed: saved.seed,
      startingPlayer: saved.startingPlayer,
      game,
      seats,
      log: saved.log,
      match,
    };
  } catch {
    return null;
  }
}

/**
 * Whoever opens the room picks how long the series is; the second player joins
 * into whatever is already set up there. Same rule as the HTTP rooms, so the
 * lobby's choice means the same thing on either transport.
 */
function getOrCreateRoom(code: string, bestOf?: number): Room {
  const existing = rooms.get(code);
  if (existing) return existing;
  const restored = restore(code);
  if (restored) {
    rooms.set(code, restored);
    return restored;
  }
  const seed = Math.floor(Math.random() * 2 ** 31);
  const startingPlayer: PlayerId = Math.random() < 0.5 ? 'p1' : 'p2';
  const room: Room = {
    code,
    seed,
    startingPlayer,
    game: newGame(seed, startingPlayer),
    seats: {},
    log: [],
    match: new MatchTracker(startingPlayer, seriesLength(bestOf)),
  };
  rooms.set(code, room);
  return room;
}

// ---------------------------------------------------------------------------
// Broadcasting
// ---------------------------------------------------------------------------

function send(socket: WebSocket | null, payload: unknown): void {
  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcastLobby(room: Room): void {
  const players = (['p1', 'p2'] as PlayerId[])
    .filter((s) => room.seats[s])
    .map((s) => ({ seat: s, name: room.seats[s]!.name }));
  const ready = players.length === 2;
  for (const seat of ['p1', 'p2'] as PlayerId[]) {
    send(room.seats[seat]?.socket ?? null, { t: 'lobby', players, ready });
  }
}

/** Sends each seat its own view and its own filtered event stream. */
function broadcastState(room: Room): void {
  room.match.noteResult(room.game);
  const events = room.game.flushEvents();
  for (const seat of ['p1', 'p2'] as PlayerId[]) {
    const s = room.seats[seat];
    if (!s?.socket) continue;
    send(s.socket, { t: 'match', match: room.match.state });
    send(s.socket, {
      t: 'view',
      view: redact(room.game.state, seat),
      events: redactEvents(room.game.state, seat, events),
    });
  }
}

function sendStateTo(room: Room, seat: PlayerId): void {
  const s = room.seats[seat];
  if (!s?.socket) return;
  send(s.socket, { t: 'match', match: room.match.state });
  send(s.socket, { t: 'view', view: redact(room.game.state, seat), events: [] });
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Static hosting + the same /api the serverless deployment uses
// ---------------------------------------------------------------------------

const DIST = join(process.cwd(), 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(url: URL, res: ServerResponse): boolean {
  if (!existsSync(DIST)) return false;
  // normalize + prefix check keeps a crafted path from escaping the build folder.
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, rel);
  if (!file.startsWith(DIST)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(DIST, 'index.html');
    if (!existsSync(file)) return false;
  }
  res.statusCode = 200;
  res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
  if (file.includes(`${join('dist', 'assets')}`)) {
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  }
  res.end(readFileSync(file));
  return true;
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  // Same handlers the serverless deployment runs, so both paths behave alike.
  if (await handleApiRequest(req, res)) return;

  if (serveStatic(url, res)) return;
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (socket) => {
  let room: Room | null = null;
  let seat: PlayerId | null = null;

  const fail = (message: string) => send(socket, { t: 'error', message });

  socket.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      fail('Malformed message');
      return;
    }

    if (msg.t === 'join') {
      const code = String(msg.room ?? '').trim().toUpperCase().slice(0, 12);
      if (!code) return fail('A room code is required');
      room = getOrCreateRoom(code, msg.bestOf);

      // Reconnecting to a seat you already hold.
      const bySeat = (['p1', 'p2'] as PlayerId[]).find(
        (s) => msg.t === 'join' && msg.token && room!.seats[s]?.token === msg.token,
      );
      if (bySeat) {
        seat = bySeat;
        room.seats[seat]!.socket = socket;
      } else {
        const free = (['p1', 'p2'] as PlayerId[]).find((s) => !room!.seats[s]);
        if (!free) return fail('That room already has two players');
        seat = free;
        room.seats[seat] = {
          token: randomUUID(),
          name: (msg.name ?? 'player').slice(0, 24),
          socket,
        };
        persist(room);
      }

      send(socket, { t: 'seat', seat, room: code, token: room.seats[seat]!.token });
      broadcastLobby(room);
      sendStateTo(room, seat);
      return;
    }

    if (!room || !seat) return fail('Join a room first');

    try {
      switch (msg.t) {
        case 'intent':
          room.game.submitIntent(seat, msg.intent);
          room.log.push({ k: 'intent', seat, intent: msg.intent });
          break;
        case 'choice':
          room.game.submitChoice(seat, msg.choiceId, msg.response);
          room.log.push({ k: 'choice', seat, choiceId: msg.choiceId, response: msg.response });
          break;
        case 'cancel':
          // Cancelling rewinds to a snapshot, so the log has to rewind with it.
          // Only ever the tail of this player's own uncommitted action.
          if (room.game.cancelPendingAction(seat)) {
            for (let i = room.log.length - 1; i >= 0; i--) {
              const a = room.log[i];
              if (a.seat !== seat) break;
              room.log.pop();
              if (a.k === 'intent') break;
            }
          }
          break;
        case 'offerExtend': {
          room.match.offerExtend(seat);
          break;
        }
        case 'answerExtend': {
          /*
           * An accepted extension reopens the series; it does not deal. Dealing
           * here handed out a game nobody would play — on the play for whoever
           * was on it last, because the loser has not chosen yet — and then
           * `chooseFirst` dealt the real one over the top of it. The finished
           * board stays up until that choice, exactly as between any two games.
           */
          room.match.answerExtend(seat, msg.accept);
          break;
        }
        case 'chooseFirst': {
          // Only the loser of the previous game gets to make this call.
          const chosen = room.match.chooseFirst(seat, msg.onPlay);
          if (chosen === null) return fail('It is not your choice to make');
          const seed = Math.floor(Math.random() * 2 ** 31);
          room.seed = seed;
          room.startingPlayer = chosen;
          room.game = newGame(seed, chosen);
          // A new game means a new log; the previous one is already scored.
          room.log = [];
          break;
        }
        case 'rematch': {
          const seed = Math.floor(Math.random() * 2 ** 31);
          room.seed = seed;
          room.startingPlayer = room.startingPlayer === 'p1' ? 'p2' : 'p1';
          room.game = newGame(seed, room.startingPlayer);
          room.log = [];
          room.match = new MatchTracker(room.startingPlayer);
          break;
        }
      }
    } catch (e) {
      fail((e as Error).message);
      // Resync so a rejected action cannot leave the client showing a stale board.
      sendStateTo(room, seat);
      return;
    }

    persist(room);
    broadcastState(room);
  });

  socket.on('close', () => {
    if (room && seat && room.seats[seat]?.socket === socket) {
      room.seats[seat]!.socket = null;
      broadcastLobby(room);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Show and Tell mirror server on http://localhost:${PORT} (ws at /ws)`);
});
