# Show and Tell — the mirror

An online implementation of a custom Timeless format in which **both players run the
same sixty cards**: a Show and Tell / Omniscience deck, played against itself over
and over in best-of-three matches.

Card text is never typed by hand anywhere in this repo. Everything reads from a
frozen Scryfall snapshot in [`data/oracle-cards.json`](data/oracle-cards.json).

[`DESIGN.md`](DESIGN.md) is the full design document — architecture, rules notes,
the interaction matrix and the reasoning behind each decision.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:5173 — plays entirely in the browser
```

Lab, Goldfish and the practice drills need nothing else: the engine runs in the
browser.

For online play against another person, run the full stack on one port:

```bash
npm run selfhost     # builds, then serves the app, /api and /ws on :8787
```

Both players open `http://<host>:8787` and join the same room code.

```bash
npm test             # 146 tests, including 150 fuzzed games
npm run typecheck
npm run build
```

---

## Deploying to Vercel

The repository is ready to deploy as-is — `vercel.json` is committed and the
project needs no configuration:

```bash
npx vercel            # preview
npx vercel --prod
```

Or import the repository at vercel.com; it is detected as a Vite app, builds with
`npm run build` and serves `dist`.

**Solo play works immediately** on the deployed URL. Lab, Goldfish and the drills
are entirely client-side.

**Online play needs a shared store.** A serverless function cannot hold a game in
memory between requests — but it does not need to, because a game here is fully
determined by `(seed, action log)`. Every request rebuilds the game by replaying
the log, applies one action and appends it; clients poll for changes. All that has
to persist is the log:

1. In the Vercel dashboard, add a **KV / Upstash Redis** integration to the project.
2. Redeploy.

That is the whole setup. The function reads whichever of these the integration
provides, so either naming works:

| Variable | |
|---|---|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash directly |

Without them the API still answers, but state is per-instance, so the lobby says
so rather than letting you start a match that will be lost. `GET /api/health`
reports which store is in use.

Appends use `RPUSH`, which is atomic. That matters at exactly one moment in this
format — the Show and Tell secret choice, where both players legitimately act at
the same instant. Redis decides the order and the engine is happy with either.

---

## What is here

### The engine — `src/engine`

A pure TypeScript rules engine with no I/O. A game is fully determined by
`(seed, action log)`: all randomness comes from a seeded PRNG stored inside the game
state, so replays, undo and deterministic tests all fall out of the same property.

All 25 maindeck cards are implemented, including the details that are easy to get
silently wrong:

| | |
|---|---|
| **Show and Tell** | Both players commit in secret; nothing is revealed until both have. The permanents then enter *at the same time*, so both ETB triggers are collected together and ordered APNAP. |
| **Modal DFCs** | Waterlogged Teachings in hand is an Instant and nothing else (CR 712.8a), so it is **not** a legal Show and Tell choice and Atraxa can only take it as an instant. |
| **Orcish Bowmasters** | Brainstorm is three separate draws, so three triggers. Dig Through Time, Rakshasa's Bargain, Planar Genesis and Atraxa put cards into hand without drawing them, so none of them trigger it. |
| **Mana Drain** | Adds its mana even when the target could not be countered — only an illegal target stops it. Rakshasa's Bargain is mana value 6, which is a hard Omniscience. |
| **Veil of Summer** | The hexproof list is locked in on resolution, so later permanents are not protected. It does not stop Hullbreaker Horror bouncing your *spell* off the stack — which is how the mirror gets through it. |
| **Mystic Sanctuary** | Counts the Island land **type**, and does not see lands entering at the same time. |
| **Omniscience** | Free, but timing restrictions still apply — which is why the deck plays Borne Upon a Wind. Lands are not spells. |

The engine also refuses illegal client intents: it validates every action against its
own legal-action list, so a client cannot ask to cast for free without an
Omniscience on the battlefield.

### Hidden information

`redact()` builds each player's view field by field from scratch — never by copying
the state and deleting the secrets, because a forgotten `delete` is exactly how a
leak happens. Events are filtered the same way: a draw event carries the id of the
card drawn, and a zone change in or out of a hand or library identifies a hidden
card.

Library order is never sent to anyone, not even to the library's owner. The client
rebuilds what the player legitimately saw instead.

### The client — `src/client`

The comfort layer is the point, not the polish. Everything below has a visible
control as well as a shortcut:

- **Auto-pass** with per-situation stop settings. "Only stop if I can answer" removes
  most of the clicking in this matchup. The delay is randomised inside a fixed
  window so the opponent cannot read your hand off how fast you pass.
- **Trigger policies** for Hullbreaker Horror and Orcish Bowmasters, so an
  Omniscience turn does not raise a modal on every free spell. Hold `Alt` to be
  asked anyway.
- **Omniscience mode** — FREE badges across the hand, a cast counter, and hold
  priority switched on automatically so a combo turn chains.
- **Known top of library** — built only from reveals the player actually saw, wiped
  by any shuffle. This is what makes fetch-after-Brainstorm a real decision again.
- **Show and Tell dialog** — illegal picks are shown greyed out *with the reason*,
  the opponent's lock-in shows as a state and never as a card, and both picks flip
  over together.
- **Practice drills** that stage a real decision instead of a random game.
- Mirror-specific presentation: fixed halves that never flip, seat colour on every
  card and log line, and a top bar that never wraps mid-click.

Card art is probed once at startup. If Scryfall is unreachable the whole app renders
readable text cards rather than blank rectangles, so it works offline.

### Online — `src/server` and `api/`

Two transports over the same room logic:

- **HTTP** (`api/game.ts`) — one serverless function. Used wherever `/api` answers,
  which includes any Vercel deployment. Clients poll; the log length doubles as an
  etag, so an unchanged poll is a few bytes.
- **WebSocket** (`src/server/index.ts`) — for self-hosting. `npm run selfhost`
  serves the built app, `/api` and `/ws` from one process.

Either way there are rooms by code, two seats, and an authoritative game. Only the
action log is stored. Reconnecting with your seat token puts you back in the same
seat rather than being treated as a third player, and a rejected action returns the
current state so a client can never be left showing a board the server disagrees
with.

---

## Deliberately not built

- **Sideboarding.** The six sideboard cards are outside the implemented card pool, so
  a swap screen would be a screen that cannot do anything. The best-of-three flow,
  the play/draw choice and the series statistics are all there; adding the sideboard
  means implementing Carpet of Flowers, Chrome Mox, Krosan Grip, Mystical Dispute and
  Thoughtseize (Veil of Summer is already done).
- **Undo across hidden information.** `Esc` backs out of a half-finished cast. A
  broader undo would need the safe-window rules described in DESIGN.md 11.3.
- **Replay playback and Lab-mode branching.** The data is all there — the action log
  plus the seed reproduces any game exactly — but there is no player UI for it yet.

---

## Testing

| Layer | What it covers |
|---|---|
| `show-and-tell.test.ts` | The secret simultaneous choice, simultaneity of entry, the modal-DFC trap, the legend rule across two controllers |
| `omniscience.test.ts` | Free casting, timing restrictions, Hullbreaker Horror's trigger |
| `interaction.test.ts` | Mana Drain, Orcish Bowmasters, Veil of Summer |
| `cards.test.ts` | Atraxa, selection spells, tutors and the whole manabase |
| `mana.test.ts` | Cost parsing and the payment solver |
| `redaction.test.ts` | Information leaks, as its own category |
| `invariants.test.ts` | 150 fuzzed games checking card conservation and determinism after **every** action |
| `match.test.ts` | Best-of-three bookkeeping |

The fuzzer found three real bugs during development: a spell that left every zone
while waiting on a choice, an exponential blow-up in the mana solver, and a crash
when an attacking token died before blockers were declared.

---

## Unofficial fan project

Card names, text and images are property of Wizards of the Coast. This is an
unofficial project intended for private play, in the spirit of the Fan Content
Policy: no monetisation, and no claim to be an official product. Card data comes
from [Scryfall](https://scryfall.com) and is cached locally rather than fetched at
runtime.
