import { beforeEach, describe, expect, it } from 'vitest';
import { oracleByName } from '@engine/oracle';
import { applyBid, createDraft } from '../../draft/draft';
import { opponentHasPassed, redactDraft, type DraftView } from '../../draft/redact';
import type { PlayerId } from '@engine/types';
import { useStore } from '../store';

/**
 * Two small rules the draft screen leans on: which card the reader is showing,
 * and what a bid of zero from the opponent means.
 */

describe('the card held open in the reader', () => {
  const brainstorm = oracleByName('Brainstorm').oracleId;
  const ponder = oracleByName('Ponder').oracleId;

  beforeEach(() => useStore.getState().togglePinnedCard(null));

  it('pins a card, and pins a different one over it', () => {
    useStore.getState().togglePinnedCard(brainstorm);
    expect(useStore.getState().pinnedOracleId).toBe(brainstorm);

    useStore.getState().togglePinnedCard(ponder);
    expect(useStore.getState().pinnedOracleId).toBe(ponder);
  });

  it('lets the same card close it again', () => {
    useStore.getState().togglePinnedCard(brainstorm);
    useStore.getState().togglePinnedCard(brainstorm);
    expect(useStore.getState().pinnedOracleId).toBeNull();
  });

  it('is not disturbed by the pointer moving', () => {
    useStore.getState().togglePinnedCard(brainstorm);
    // Hovering is what fills the reader when nothing is pinned; a pin outranks it,
    // so crossing the table on the way to the board must not clear it.
    useStore.getState().setHoveredOracle(ponder);
    expect(useStore.getState().pinnedOracleId).toBe(brainstorm);

    useStore.getState().setHoveredOracle(null);
    expect(useStore.getState().pinnedOracleId).toBe(brainstorm);
  });
});

describe('reading a bid of zero from the opponent', () => {
  const start = () => {
    const s = createDraft({ draftId: 'r', seed: 4 });
    const first = s.auction.toAct!;
    const second: PlayerId = first === 'p1' ? 'p2' : 'p1';
    return { s, first, second };
  };
  const viewOf = (s: ReturnType<typeof start>['s'], seat: PlayerId): DraftView =>
    redactDraft(s, seat);

  it('is not the same state as an auction nobody has opened', () => {
    const { s, first, second } = start();
    // Before anyone speaks, the opener sees an empty auction and is opening it.
    expect(opponentHasPassed(viewOf(s, first))).toBe(false);

    applyBid(s, first, 0);

    // The highest bid is still zero, which is exactly why this needed telling
    // apart: what changed is that one player is already out.
    expect(viewOf(s, second).highestBid).toBe(0);
    expect(opponentHasPassed(viewOf(s, second))).toBe(true);
  });

  it('is false for the player who did the passing', () => {
    const { s, first } = start();
    applyBid(s, first, 0);
    // They passed; nobody passed on them.
    expect(opponentHasPassed(viewOf(s, first))).toBe(false);
  });

  it('is false once a real bid is standing', () => {
    const { s, first, second } = start();
    applyBid(s, first, 3);
    expect(opponentHasPassed(viewOf(s, second))).toBe(false);
  });

  it('describes an auction where the minimum really does buy the pile', () => {
    const { s, first, second } = start();
    applyBid(s, first, 0);
    const view = viewOf(s, second);
    expect(opponentHasPassed(view)).toBe(true);
    expect(view.minimumBid).toBe(1);

    // Which is the claim the panel makes when it drops the amount box: nobody is
    // left to answer, so the minimum wins outright and anything above it is money
    // handed back to the bank.
    applyBid(s, second, view.minimumBid);
    expect(s.phase).toBe('picking');
    expect(s.pickingBy).toBe(second);
  });
});
