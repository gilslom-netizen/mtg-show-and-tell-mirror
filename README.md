# Show and Tell — the mirror

An online implementation of a custom Timeless format in which **both players run the
same sixty cards**: a Show and Tell / Omniscience deck, played against itself over
and over in best-of-three matches.

Card text is never typed by hand anywhere in this repo. Everything reads from a
frozen Scryfall snapshot in [`data/oracle-cards.json`](data/oracle-cards.json).
Art is pinned to specific real printings in [`data/printings.json`](data/printings.json) —
`npm run set:art -- --write` re-applies them after a `sync:cards` refresh, which
otherwise resets every card back to Scryfall's own "preferred" printing.

[`DESIGN.md`](DESIGN.md) is the full design document — architecture, rules notes,
the interaction matrix and the reasoning behind each decision.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:5173 — everything, online play included
```

Lab, Goldfish and the practice drills run entirely in the browser. Online play
works here too: the dev server mounts the same `/api` handlers the deployment
runs, in-process, so there is no second command to remember and no code path that
only exists in production.

To play against someone on another machine, serve the build:

```bash
npm run selfhost     # builds, then serves the app, /api and /ws on :8787
```

Either way: press **Play online**, then send the other player the invite link from
the waiting screen (or read them the five-character room code). The code is
generated before you click anything and lives in the address bar, so two players
cannot end up in two different rooms — which is exactly what used to happen when
both of them left the box empty.

```bash
npm test             # 222 tests, including 150 fuzzed games
npm run typecheck
npm run check:serverless   # runs the API the way Vercel runs it
npm run build              # typecheck + that check + the app build
```

**One convention worth knowing before editing `src/engine`, `src/server` or
`api`:** those files run on Vercel, which transpiles each file on its own and
runs the result as plain Node ESM. So relative imports there carry explicit
`.js` extensions (`./oracle.js`, `./cards/index.js`) and the card data is
imported from generated TypeScript in `src/engine/generated/` rather than from
JSON — Node ESM resolves neither an extensionless path nor an attribute-less
JSON import, and the transpiler strips the attribute anyway. `data/*.json`
remains the source of truth; `npm run gen:data` regenerates, and a test fails if
the two ever drift. `src/client` is bundled by Vite and has no such constraint.
`npm run check:serverless` is what catches a regression here — it transpiles
per-file and calls both handlers under plain Node, which is exactly how the
deployed functions once crashed while everything local stayed green.

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
provides, so either naming works — and if you give the integration a custom
prefix, it finds the pair by shape rather than leaving the deployment silently
on per-instance memory:

| Variable | |
|---|---|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash directly |

Without them the API still answers and a single sitting usually works, because
requests tend to stay on one warm instance — but nothing guarantees it, and a
game can be lost between moves. The lobby says so in as many words, the button
reads **Play online anyway**, and the warning stays on the waiting screen, so
nobody discovers this by staring at "waiting for the other player".
`GET /api/health` reports the store in use, whether the host is serverless, and
whether online play is `usable` here at all.

Polling is the running cost, so the client spends it where it matters: the fast
rate holds through three minutes of silence — an opponent thinking is not
idleness — and only then backs off, while a hidden tab parks at one poll every
15 seconds and wakes the moment you look at it again. A forgotten open tab was
the only thing that could quietly drain a free Redis tier; it now costs about a
tenth of what it did.

Appends use `RPUSH`, which is atomic. That matters at exactly one moment in this
format — the Show and Tell secret choice, where both players legitimately act at
the same instant. Redis decides the order and the engine is happy with either.

---

## Drafting

The main way to play. Both players start with **24 coins** and bid for the card
pool one pile at a time.

A pile is four cards: **two face up to both players, and one each that only its
owner can see**. So you know three of the four, your opponent knows a different
three, and the bidding is as much about what their face tells you as about what
is on the table. The opener alternates every pile and bids at least one or
withdraws; the other player raises or withdraws. Whoever is left takes the pile
and pays their bid — if both withdraw, the pile is gone. The winner keeps two
cards and throws the other two away.

The screen carries the numbers that make a bid a decision rather than a guess:
piles left, cards left, and what an average remaining pile is worth (both purses
divided by the piles still to buy). Spend well above that and you are betting
this pile beats the ones you are giving up later.

Afterwards each player gets what they bought, the shared sixty, and **sixteen
lands** — each colour paired with blue, two shocklands and two surveil lands, so
a splash always has a manabase. Then the deckbuilder: one pool, two columns,
one click to move a card. It opens again between games, which is the
sideboarding this format never had.

Series length is chosen in the lobby: best of 1, 3 (default) or 5, for drafted
and classic rooms alike.

> **What is not finished.** The drafted cards are in the card database so they
> can be drafted, shown and deckbuilt with, but a card needs an engine script
> before it can actually be cast — and only the ones the mirror already plays
> have one. The deckbuilder marks the rest with ⚠ and says so in a banner rather
> than letting it be discovered mid-game. The sixteen granted lands *are*
> implemented, since every drafted game deals them.

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
- **Combat that gets out of the way.** This deck wins by resolving a spell, so on
  most turns nobody has a creature and combat is three rounds of priority spent
  pressing pass. The engine skips the declare blockers and combat damage steps
  when nothing attacked (CR 506.5), and the client's default combat stop is "only
  if combat matters" — so passing out of the beginning of combat lands in the
  second main phase. Set it back to "always stop" in Settings if you want the
  steps.
- **Trigger policies** for Hullbreaker Horror and Orcish Bowmasters, so an
  Omniscience turn does not raise a modal on every free spell. Bowmasters defaults
  to "only if obvious": their face when they control no creature, and a real
  prompt the moment they do. Hold `Alt` to be asked anyway.
- **Omniscience mode** — FREE badges across the hand and a cast counter. Holding
  priority is `H` and is *not* automatic: an Omniscience turn is mostly ordinary
  spells, and holding for all of them turns each one into a click. The setting is
  still there if you prefer it.
- **Repeat what you just did.** Some turns are a rhythm rather than a decision:
  the same land tapped every turn, the same free spell off four copies. Once the
  client has watched you actually repeat something, a chip offers to run the same
  stretch again as many times as you say. It only ever replays *your* actions
  against the legal actions the engine is offering at the time, it never answers
  a question (a prompt pauses the run and it picks up after you answer), and any
  click of your own ends it.
- **Atraxa, one type at a time — in any order.** The trigger asks about eight card
  types, and the answers depend on each other: whether you want the artifact
  depends on what the creature and land slots turn out to hold. Any question can
  be pushed to the back and comes back after you have seen the rest. Two passes
  and no more, so it always terminates.
- **Sorting the builder** by mana cost, by type, or A–Z, with sticky headings and
  a count per group. Cost is the curve, type is how a decklist is written, and
  A–Z is how you find one card among ninety while sideboarding.
- **Put a decision aside.** Any prompt can be minimised with the control in its
  corner or with `B`. The dialog goes away, the board is fully visible, and the
  decision waits in a strip between the board and your hand until you come back.
  Nothing is sent either way.
- **Drag the dividers.** The line between the two boards, the one beside the log
  and the one above your hand all resize what they separate; double click a
  divider to put it back. The hand's cards scale with its height, so pulling it
  down is how you see more board.
- **Known top of library** — built only from reveals the player actually saw, wiped
  by any shuffle. This is what makes fetch-after-Brainstorm a real decision again.
- **Cards you can actually read** — art comes from Scryfall at `large`, the hover
  preview at `png`, and everything on the table scales from one setting (`+` and
  `−`, or Settings → Card size) because screens and eyesight differ too much for
  one number. Mana costs are drawn as real pips, hybrids split across the diagonal
  included.
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
| `room-code.test.ts` | Room codes normalise identically on both sides, so a code read aloud joins the right room |
| `data-sync.test.ts` | The generated card data still matches `data/*.json` |
| `priority-windows.test.ts` | Acting in the opponent's turn — the fetch in every step — and each form of passing |
| `opening.test.ts` | The simultaneous mulligan, including that neither player can read the other's decision early |
| `art.test.ts` | Art resolution and every mana symbol in the deck |
| `draft.test.ts` | The auction rule by rule, who pays what, and that neither player's private card or picks leak |
| `draft-room.test.ts` | A drafted room end to end over the replay-the-log path, and decklist legality |

Two browser profiles joining one room over both transports is checked by hand
against `npm run dev`, the built self-hosted server, and a static host with no
backend at all — the last of which must *say* that it cannot host a game rather
than sit on a waiting screen.

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
