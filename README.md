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

For online play against another person, also run the server:

```bash
npm run server       # ws://localhost:8787/ws, proxied by the dev server at /ws
```

Then both players open the app and join the same room code.

```bash
npm test             # 129 tests, including 150 fuzzed games
npm run typecheck
npm run build
```

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

### Online — `src/server`

Rooms by code, two seats, an authoritative game per room. Only the action log is
persisted, which is enough to rebuild any match. Reconnecting with your seat token
puts you back in the same seat rather than being treated as a third player.

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
