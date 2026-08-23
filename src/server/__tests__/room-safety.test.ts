import { beforeEach, describe, expect, it } from 'vitest';
import handler from '../../../api/game.js';
import { setStore } from '../store.js';
import { deckProblem } from '../room.js';
import { MAINDECK } from '../../engine/deck.js';
import type { OracleId, PlayerId } from '../../engine/types.js';

function fakeRes(): { res: never; out: { code: number; body: Record<string, unknown> } } {
  const out = { code: 0, body: {} as Record<string, unknown> };
  const res = {
    status(code: number) {
      out.code = code;
      return res;
    },
    json(body: unknown) {
      out.body = body as Record<string, unknown>;
    },
    setHeader() {},
  };
  return { res: res as never, out };
}
const post = async (body: Record<string, unknown>) => {
  const { res, out } = fakeRes();
  await handler({ method: 'POST', body } as never, res);
  return out;
};
const joinAs = async (room: string, name: string) => {
  const r = await post({ room, name });
  return { token: r.body.token as string, seat: r.body.seat as PlayerId, snap: r.body };
};

describe('cancelling over the wire', () => {
  beforeEach(() => setStore(null));

  it('does not let a player take back an action the opponent has already seen', async () => {
    const a = await joinAs('CANCEL1', 'a');
    const b = await joinAs('CANCEL1', 'b');
    const seats = { p1: a.token, p2: b.token } as Record<PlayerId, string>;
    if (a.seat === 'p2') {
      seats.p2 = a.token;
      seats.p1 = b.token;
    }
    const snap = (seat: PlayerId) => post({ room: 'CANCEL1', token: seats[seat] });
    const act = (seat: PlayerId, action: unknown) =>
      post({ room: 'CANCEL1', token: seats[seat], action });

    // Both keep their opening hand.
    for (const seat of ['p1', 'p2'] as PlayerId[]) {
      const choice = ((await snap(seat)).body.view as { choice: { id: string } | null }).choice;
      if (choice) await act(seat, { t: 'choice', choiceId: choice.id, response: { kind: 'yesNo', value: true } });
    }

    const active = ((await snap('p1')).body.view as { activePlayer: PlayerId }).activePlayer;
    const board = async () =>
      ((await snap(active)).body.view as { battlefield: Record<PlayerId, number[]> }).battlefield[
        active
      ].length;

    // Play a land, then answer anything it triggers, so the action is finished
    // and both players have seen it.
    const v = (await snap(active)).body.view as { legalActions: { intent: { t: string } }[] };
    const land = v.legalActions.find((x) => x.intent.t === 'playLand');
    if (!land) return; // No land in this opening hand; nothing to prove here.
    await act(active, { t: 'intent', intent: land.intent });
    for (let i = 0; i < 6; i++) {
      const view = (await snap(active)).body.view as {
        choice: { id: string; kind: string; min?: number } | null;
      };
      if (!view.choice) break;
      await act(active, {
        t: 'choice',
        choiceId: view.choice.id,
        response: view.choice.kind === 'chooseCards' ? { kind: 'cards', iids: [] } : { kind: 'yesNo', value: false },
      });
    }
    const settled = (await snap(active)).body.view as { choice: unknown };
    expect(settled.choice).toBeNull();
    expect(await board()).toBe(1);

    // Now press Escape. Nothing is half-finished, so nothing may be rewound.
    await act(active, { t: 'cancel' });
    expect(await board()).toBe(1);
  });
});

describe('decklist validation', () => {
  it('counts copies across the whole list, not entry by entry', () => {
    // A legal sixty, plus a second entry for a card already at its limit. Every
    // entry is legal on its own; the list is not.
    const legal = MAINDECK.map((e) => ({ ...e }));
    expect(deckProblem(legal, [])).toBeNull();
    const eightOmniscience = [...legal, { oracleId: 'omniscience' as OracleId, count: 4 }];
    expect(deckProblem(eightOmniscience, [])).toMatch(/only have 4 copies of Omniscience/);
  });

  it('says which card is the problem', () => {
    expect(deckProblem([{ oracleId: 'timetwister' as OracleId, count: 1 }], [])).toMatch(
      /Timetwister is not in your card pool/,
    );
  });

  it('rejects a card that is not in the database at all', () => {
    expect(deckProblem([{ oracleId: 'black_lotus' as OracleId, count: 1 }], [])).toBeTruthy();
  });
});
