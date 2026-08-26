import { getScript, unimplementedReason } from './cards/index.js';
import {
  addEffect as addEffectToState,
  attachNextSpellShield,
  canCastAsThoughFlash,
  clearEndOfTurnEffects,
  isProtectedFrom,
  spellCantBeCountered,
} from './effects.js';
import {
  MANA_KINDS,
  canPay,
  clonePool,
  emptyPool,
  genericPortion,
  parseCost,
  poolIsEmpty,
  reduceGeneric,
  solvePayment,
  type ManaSource,
} from './mana.js';
import { faceOf, frontFace, oracle } from './oracle.js';
import { shuffleArray } from './rng.js';
import {
  battlefield,
  cardName,
  cardsIn,
  cardsToBottom,
  createGameState,
  currentFace,
  powerOf,
  toughnessOf,
  handSizeAfter,
  hasKeyword,
  isMainPhase,
  isPermanentCard,
  isType,
  logLine,
  makeCard,
  manaValueOfCard,
  moveCardRaw,
  otherPlayer,
  shuffleLibrary,
  stepAt,
  targetExists,
  targetLabel,
  type DeckEntry,
} from './state.js';
import type {
  ActivationCost,
  Ctx,
  Eff,
  ChooseCardsOpts,
  ChooseTargetsOpts,
  DamageOpts,
  SearchOpts,
  TargetDef,
} from './script-types.js';
import {
  TURN_SEQUENCE,
  type CardInstance,
  type ChoiceRequest,
  type ChoiceRequestDraft,
  type ChoiceResponse,
  type CostSymbol,
  type GameEvent,
  type GameState,
  type IID,
  type ManaKind,
  type PendingTrigger,
  type PlayerId,
  type TargetRef,
  type ZoneName,
} from './types.js';

// ---------------------------------------------------------------------------
// Intents — what a player can do when they hold priority
// ---------------------------------------------------------------------------

export type Intent =
  | {
      t: 'playLand';
      iid: IID;
      face?: 'front' | 'back';
      from?: 'hand' | 'graveyard' | 'exile' | 'library';
    }
  | {
      t: 'castSpell';
      iid: IID;
      /** Omniscience and friends: no cost at all. */
      free?: boolean;
      /** The card's own "rather than pay this spell's mana cost". */
      alt?: boolean;
      /** Pay the kicker too. */
      kicked?: boolean;
      /** Where the card is being cast from. Hand when absent. */
      from?: 'hand' | 'graveyard' | 'exile' | 'library';
      /** Flashback: the card exiles as it leaves the stack. */
      flashback?: boolean;
      /** Escape: flashback's cousin — exiles five others on the way. */
      escape?: boolean;
      holdPriority?: boolean;
    }
  | { t: 'turnFaceUp'; iid: IID }
  | { t: 'activateAbility'; iid: IID; index: number }
  | { t: 'tapForMana'; iid: IID; kind: ManaKind }
  | { t: 'passPriority' }
  | { t: 'concede' };

export interface LegalAction {
  intent: Intent;
  label: string;
  /**
   * Tapping a land for mana is always legal but is never a reason to hold priority.
   * Auto-pass ignores these, otherwise a player with an untapped land would never
   * be passed for automatically.
   */
  isManaAbility?: boolean;
}

const MAX_HAND_SIZE = 7;
const ADVANCE_GUARD = 20000;

export class Game {
  state: GameState;
  /** Events since the last flush, for the UI to animate. */
  events: GameEvent[] = [];
  /**
   * When true (the default), a player who has no meaningful action is passed for
   * automatically. This is deterministic, so replays are unaffected. Tests turn it
   * off to control priority explicitly.
   */
  autoPass = true;
  /**
   * When true (the default), a snapshot is taken every time a player is handed
   * priority so that Esc can back out of a half-finished cast.
   *
   * That snapshot is a `JSON.stringify` of the whole state and it costs 99µs of the
   * 207µs an engine decision takes — 48% of the budget, spent entirely on a button
   * that only exists in the UI. Search and self-play have no Esc, so they turn this
   * off and get the time back. Nothing about the rules changes either way, so a
   * replay is unaffected: see DESIGN-AI.md 6.1.
   */
  undoable = true;

  private current: Eff | null = null;
  private sbaDirty = true;
  /** True while the state-based-action pass itself is the running process. */
  private sbaRunning = false;
  /** Set by ctx.enterTapped() from inside an asEnters replacement effect. */
  private enterTappedFlag = false;
  /** Snapshot taken before a cancellable player action, so Esc can back out. */
  private rollback: string | null = null;
  private rollbackOwner: PlayerId | null = null;

  constructor(state: GameState) {
    this.state = state;
  }

  static create(opts: {
    gameId: string;
    seed: number;
    /** The shared decklist, for the mirror. */
    deck?: DeckEntry[];
    /** Per-seat decklists, for drafted play. Wins over `deck` when given. */
    decks?: Record<PlayerId, DeckEntry[]>;
    startingPlayer: PlayerId;
    bare?: boolean;
    /** Off for search and self-play, where there is no Esc to back out with. */
    undoable?: boolean;
  }): Game {
    const game = new Game(createGameState(opts));
    if (opts.undoable === false) game.undoable = false;
    return game;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  flushEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Runs the game forward until it needs a player decision. */
  advance(): void {
    const s = this.state;
    let guard = 0;

    while (guard++ < ADVANCE_GUARD) {
      // A finished game is finished even with a question still on screen — a
      // concession ends things mid-mulligan, mid-resolution, anywhere.
      if (s.winner !== null) return;
      if (s.pendingChoice) return;

      // 1. Finish whatever process is running.
      if (this.current) {
        if (this.pump() === 'yielded') return;
        continue;
      }

      // 2. Mulligans happen before anything else.
      if (s.mode === 'mulligan') {
        this.current = this.mulliganPhase();
        continue;
      }

      // 3. State-based actions, repeated until stable.
      if (this.sbaDirty) {
        this.sbaDirty = false;
        this.sbaRunning = true;
        this.current = this.runStateBasedActions();
        continue;
      }
      if (s.winner !== null) return;

      // 4. Triggers waiting to go on the stack.
      if (s.pendingTriggers.length > 0) {
        this.current = this.putTriggersOnStack();
        continue;
      }

      // 5. Turn-based actions for the step we just entered.
      if (!s.stepInitialized) {
        s.stepInitialized = true;
        this.current = this.beginStep();
        continue;
      }

      // 6. Some steps never give priority.
      if (!this.stepGrantsPriority()) {
        this.endStep();
        continue;
      }

      if (s.priorityPlayer === null) {
        s.priorityPlayer = s.activePlayer;
        s.passed = [];
      }

      // 7. Both players passed: resolve or move on.
      if (s.passed.length >= 2) {
        s.passed = [];
        if (s.stack.length > 0) {
          this.current = this.resolveTop();
          s.priorityPlayer = null;
        } else {
          this.endStep();
        }
        continue;
      }

      // 8. Auto-pass when the player literally cannot do anything. This is
      //    deterministic and therefore safe for replays. Richer stop settings
      //    live in the client, which sends real pass intents.
      const p = s.priorityPlayer;
      if (this.autoPass) {
        const actions = this.legalActions(p);
        if (actions.every((a) => a.isManaAbility)) {
          this.doPass(p);
          continue;
        }
      }

      // Waiting for a player.
      if (this.undoable) this.takeRollbackSnapshot(p);
      return;
    }
    throw new Error('advance() did not settle — possible infinite loop');
  }

  submitIntent(player: PlayerId, intent: Intent): void {
    const s = this.state;
    if (s.winner !== null) return;
    /*
     * CR 104.3a — a player may concede at any time. That has to hold with a
     * question on screen too, which is most of a game of this deck: mulliganing,
     * ordering triggers, halfway through an Atraxa. Conceding is checked before
     * the pending-choice guard for exactly that reason, and the question is then
     * dropped along with whatever was resolving behind it.
     */
    if (intent.t === 'concede') {
      this.playerLoses(player, 'concede');
      s.pendingChoice = null;
      this.current = null;
      this.advance();
      return;
    }
    if (s.pendingChoice) throw new Error('A choice is pending');
    if (s.priorityPlayer !== player) throw new Error(`${player} does not have priority`);

    // Every non-pass intent must match something the engine itself considers legal.
    // Without this a client could simply ask to cast for free with no Omniscience
    // on the battlefield, or play a second land.
    if (intent.t !== 'passPriority' && !this.isLegalIntent(player, intent)) {
      throw new Error(`Illegal intent: ${JSON.stringify(intent)}`);
    }

    switch (intent.t) {
      case 'passPriority':
        this.doPass(player);
        break;
      case 'playLand':
        this.playLand(player, intent.iid, intent.face ?? 'front', intent.from ?? 'hand');
        break;
      case 'tapForMana':
        this.tapForMana(player, intent.iid, intent.kind);
        break;
      case 'castSpell':
        this.current = this.castSpell(player, intent.iid, {
          free: intent.free ?? false,
          alt: intent.alt ?? false,
          kicked: intent.kicked ?? false,
          from: intent.from ?? 'hand',
          flashback: intent.flashback ?? false,
          escape: intent.escape ?? false,
          holdPriority: intent.holdPriority ?? false,
        });
        break;
      case 'turnFaceUp':
        this.current = this.turnFaceUp(player, intent.iid);
        break;
      case 'activateAbility':
        this.current = this.activateAbility(player, intent.iid, intent.index);
        break;
    }
    this.advance();
  }

  submitChoice(player: PlayerId, choiceId: string, response: ChoiceResponse): void {
    const s = this.state;
    const pc = s.pendingChoice;
    if (!pc) throw new Error('No choice pending');
    if (pc.id !== choiceId) throw new Error('Stale choice id');

    if (pc.kind === 'mulligan') {
      if (!pc.awaiting.includes(player)) throw new Error('You have already decided');
      if (response.kind !== 'yesNo') throw new Error('Expected keep or mulligan');
      s.mulliganResponses[player] = response.value;
      pc.lockedIn = [...pc.lockedIn, player];
      pc.awaiting = pc.awaiting.filter((x) => x !== player);
      // The round resolves when everyone still deciding has decided.
      if (pc.awaiting.length > 0) {
        this.notifyChoiceProgress();
        return;
      }
      s.pendingChoice = null;
      this.pump({ kind: 'mulliganRound', keep: { ...s.mulliganResponses } });
      this.advance();
      return;
    }

    if (pc.kind === 'simultaneousSecret') {
      if (!pc.awaiting.includes(player)) throw new Error('You have already locked in');
      if (response.kind !== 'secret') throw new Error('Expected a secret response');
      const allowed = pc.requests[player].options.filter((o) => !o.disabledReason).map((o) => o.iid);
      if (response.iid !== null && !allowed.includes(response.iid)) {
        throw new Error('Illegal secret choice');
      }
      s.secretResponses[player] = response.iid;
      pc.lockedIn = [...pc.lockedIn, player];
      pc.awaiting = pc.awaiting.filter((x) => x !== player);
      // Nothing is revealed until both players have committed.
      if (pc.awaiting.length > 0) return;
      s.pendingChoice = null;
      this.pump({ kind: 'secret', iid: null });
      this.advance();
      return;
    }

    if (pc.player !== player) throw new Error('Not your choice');
    this.validateResponse(pc, response);
    s.pendingChoice = null;
    this.pump(response);
    this.advance();
  }

  /**
   * Back out of a half-finished cast or activation (Esc in the UI).
   * Only possible while the rollback snapshot still belongs to this player and
   * nothing irreversible has happened.
   */
  cancelPendingAction(player: PlayerId): boolean {
    if (!this.rollback || this.rollbackOwner !== player) return false;
    this.state = JSON.parse(this.rollback) as GameState;
    this.current = null;
    this.events = [];
    this.sbaDirty = true;
    // Consume the snapshot: advance() takes a fresh one as soon as this player is
    // waiting again, and a stale snapshot could otherwise rewind past an action
    // the opponent has already seen.
    this.rollback = null;
    this.rollbackOwner = null;
    this.advance();
    return true;
  }

  legalActions(player: PlayerId): LegalAction[] {
    return enumerateLegalActions(this.state, player);
  }

  private isLegalIntent(player: PlayerId, intent: Intent): boolean {
    return this.legalActions(player).some((a) => sameIntent(a.intent, intent));
  }

  // -------------------------------------------------------------------------
  // Generator plumbing
  // -------------------------------------------------------------------------

  private pump(response?: ChoiceResponse): 'yielded' | 'done' {
    if (!this.current) return 'done';
    const r =
      response === undefined ? this.current.next() : this.current.next(response as never);
    if (r.done) {
      this.current = null;
      // Finishing the SBA pass must not immediately re-dirty it, or advance()
      // spins forever. Anything the pass actually changed re-dirties via emit().
      if (this.sbaRunning) this.sbaRunning = false;
      else this.sbaDirty = true;
      return 'done';
    }
    this.state.pendingChoice = r.value;
    return 'yielded';
  }

  /**
   * A player locking in changes the other player's view even though the choice is
   * still open — "waiting for your opponent" has to become "they have decided".
   */
  private notifyChoiceProgress(): void {
    this.events.push({ t: 'choiceProgress' });
  }

  private nextChoiceId(): string {
    // On the state, so that Esc rewinds it with everything else — see GameState.
    return `c${++this.state.choiceSeq}`;
  }

  private takeRollbackSnapshot(player: PlayerId): void {
    this.rollback = JSON.stringify(this.state);
    this.rollbackOwner = player;
  }

  private validateResponse(pc: ChoiceRequest, r: ChoiceResponse): void {
    switch (pc.kind) {
      case 'chooseCards': {
        if (r.kind !== 'cards') throw new Error('Expected cards');
        const allowed = pc.options.filter((o) => !o.disabledReason).map((o) => o.iid);
        if (r.iids.length < pc.min || r.iids.length > pc.max) {
          throw new Error(`Choose between ${pc.min} and ${pc.max} cards`);
        }
        if (new Set(r.iids).size !== r.iids.length) throw new Error('Duplicate selection');
        for (const iid of r.iids) {
          if (!allowed.includes(iid)) throw new Error('Illegal card selection');
        }
        break;
      }
      case 'chooseTargets': {
        if (r.kind !== 'targets') throw new Error('Expected targets');
        const want = pc.optional ? [0, pc.count] : [pc.count, pc.count];
        if (r.targets.length < want[0] || r.targets.length > want[1]) {
          throw new Error('Wrong number of targets');
        }
        for (const t of r.targets) {
          if (!pc.candidates.some((c) => sameTarget(c, t))) throw new Error('Illegal target');
        }
        break;
      }
      case 'chooseMode': {
        if (r.kind !== 'modes') throw new Error('Expected modes');
        if (r.modes.length < pc.min || r.modes.length > pc.max) {
          throw new Error('Wrong number of modes');
        }
        for (const m of r.modes) {
          const mode = pc.modes.find((x) => x.index === m);
          if (!mode || !mode.enabled) throw new Error('Illegal mode');
        }
        break;
      }
      case 'yesNo':
      case 'mulligan':
        if (r.kind !== 'yesNo') throw new Error('Expected yes/no');
        break;
      case 'orderTriggers': {
        if (r.kind !== 'order') throw new Error('Expected order');
        const ids = pc.triggers.map((t) => t.id).sort();
        const got = [...r.ids].sort();
        if (JSON.stringify(ids) !== JSON.stringify(got)) throw new Error('Bad trigger order');
        break;
      }
      case 'declareAttackers': {
        if (r.kind !== 'attackers') throw new Error('Expected attackers');
        for (const iid of r.iids) {
          if (!pc.candidates.includes(iid)) throw new Error('Illegal attacker');
        }
        break;
      }
      case 'declareBlockers': {
        if (r.kind !== 'blockers') throw new Error('Expected blockers');
        const seen = new Set<IID>();
        for (const b of r.blocks) {
          if (!pc.blockers.includes(b.blocker)) throw new Error('Illegal blocker');
          if (!pc.attackers.includes(b.attacker)) throw new Error('Illegal block assignment');
          if (seen.has(b.blocker)) throw new Error('A creature can only block once');
          seen.add(b.blocker);
        }
        break;
      }
      case 'distributeDamage': {
        if (r.kind !== 'damage') throw new Error('Expected damage assignment');
        const total = Object.values(r.assignment).reduce((a, b) => a + b, 0);
        if (total !== pc.total) throw new Error('Must assign all damage');
        break;
      }
      case 'simultaneousSecret':
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Events, triggers and state-based actions
  // -------------------------------------------------------------------------

  /** Tests that move cards by hand still need the SBA pass to notice. */
  sbaDirtyForTests(): void {
    this.sbaDirty = true;
  }

  emit(events: GameEvent[]): void {
    if (events.length === 0) return;
    this.sbaDirty = true;
    for (const ev of events) {
      this.events.push(ev);
      this.collectTriggers(ev);
    }
  }

  private collectTriggers(ev: GameEvent): void {
    const s = this.state;
    for (const card of battlefield(s)) {
      const script = getScript(card.oracleId);
      if (!script?.abilities) continue;
      script.abilities.forEach((ab, idx) => {
        if (ab.kind !== 'triggered') return;
        let res: boolean | Record<string, unknown>;
        try {
          res = ab.trigger(ev, card, s);
        } catch {
          return;
        }
        if (!res) return;
        const trig: PendingTrigger = {
          id: s.nextEffectId++,
          sourceIid: card.iid,
          controller: card.controller,
          abilityIndex: idx,
          label: ab.label,
          context: typeof res === 'object' ? res : {},
        };
        s.pendingTriggers.push(trig);
        this.events.push({
          t: 'abilityTriggered',
          sourceIid: card.iid,
          label: ab.label,
          controller: card.controller,
        });
        logLine(s, `${cardName(card)} triggers: ${ab.label}`, {
          player: card.controller,
          iids: [card.iid],
        });
      });
    }
  }

  private *runStateBasedActions(): Eff {
    const s = this.state;
    let iterations = 0;
    for (;;) {
      if (iterations++ > 100) return;
      let changed = false;

      // 704.5a / 704.5b — losing the game.
      for (const p of ['p1', 'p2'] as PlayerId[]) {
        const ps = s.players[p];
        if (ps.hasLost) continue;
        if (ps.life <= 0) {
          this.playerLoses(p, 'life');
          changed = true;
        } else if (ps.triedToDrawFromEmpty) {
          this.playerLoses(p, 'deckOut');
          changed = true;
        }
      }
      if (s.winner !== null) return;

      // 704.5f / 704.5g / 704.5h — creatures dying.
      const dying: CardInstance[] = [];
      for (const c of battlefield(s)) {
        if (!isType(c, 'Creature')) continue;
        const tou = toughnessOf(s, c);
        if (tou <= 0) dying.push(c);
        else if (c.deathtouched && c.damage > 0) dying.push(c);
        else if (c.damage >= tou) dying.push(c);
      }
      for (const c of dying) {
        logLine(s, `${cardName(c)} dies`, { player: c.controller, iids: [c.iid] });
        this.emit(moveCardRaw(s, c.iid, 'graveyard'));
        changed = true;
      }

      /*
       * 704.5m — an aura attached to something illegal (or to nothing) is put
       * into its owner's graveyard. This is the only thing keeping attachment
       * honest: nothing else notices when the enchanted permanent leaves.
       */
      for (const c of battlefield(s)) {
        const script = getScript(c.oracleId);
        if (!script?.enchant) continue;
        const host = c.attachedTo === undefined ? undefined : s.cards[c.attachedTo];
        const legal =
          host !== undefined &&
          host.zone === 'battlefield' &&
          script.enchant
            .candidates(s, c.controller)
            .some((t) => t.kind === 'permanent' && t.iid === host.iid);
        if (legal) continue;
        logLine(s, `${cardName(c)} falls off`, { player: c.controller, iids: [c.iid] });
        this.emit(moveCardRaw(s, c.iid, 'graveyard'));
        changed = true;
      }

      // 704.5i — a planeswalker with no loyalty counters goes to the graveyard.
      for (const c of battlefield(s)) {
        if (!isType(c, 'Planeswalker')) continue;
        if ((c.counters['loyalty'] ?? 0) > 0) continue;
        logLine(s, `${cardName(c)} dies (no loyalty)`, { player: c.controller, iids: [c.iid] });
        this.emit(moveCardRaw(s, c.iid, 'graveyard'));
        changed = true;
      }

      // 714.4 — a saga with every chapter done is sacrificed.
      for (const c of battlefield(s)) {
        const script = getScript(c.oracleId);
        if (!script?.saga) continue;
        if ((c.counters['lore'] ?? 0) < script.saga.chapters) continue;
        // Only once its chapter abilities have left the stack.
        if (s.stack.some((iid) => s.cards[iid]?.abilitySource === c.iid)) continue;
        logLine(s, `${cardName(c)} is sacrificed (final chapter)`, {
          player: c.controller,
          iids: [c.iid],
        });
        this.emit(moveCardRaw(s, c.iid, 'graveyard'));
        changed = true;
      }

      /*
       * An effect whose enforcing permanent has left stops applying. Ashiok's
       * Erasure's name-lock is the case that matters; a lingering ban on casting
       * a card nobody can see the reason for is the worst kind of bug.
       */
      const gone = s.effects.filter(
        (e) =>
          (e.kind === 'cantCastName' || (e.kind === 'ptBuff' && e.sourceIid !== undefined)) &&
          (() => {
            const src = e.kind === 'cantCastName' ? e.sourceIid : e.sourceIid!;
            const c = s.cards[src];
            return !c || c.zone !== 'battlefield';
          })(),
      );
      if (gone.length > 0) {
        s.effects = s.effects.filter((e) => !gone.includes(e));
        changed = true;
      }

      // 704.5j — the legend rule. Two Atraxas under DIFFERENT controllers is legal,
      // which is exactly what a Show and Tell mirror produces; only same-controller
      // duplicates are a problem.
      for (const p of ['p1', 'p2'] as PlayerId[]) {
        const byName = new Map<string, CardInstance[]>();
        for (const c of battlefield(s, p)) {
          if (!currentFace(c).supertypes.includes('Legendary')) continue;
          const n = cardName(c);
          byName.set(n, [...(byName.get(n) ?? []), c]);
        }
        for (const [name, group] of byName) {
          if (group.length < 2) continue;
          const keep = yield* this.chooseCardsInternal({
            player: p,
            cards: group.map((c) => c.iid),
            min: 1,
            max: 1,
            prompt: `Legend rule: keep one ${name}`,
            from: 'battlefield',
          });
          for (const c of group) {
            if (c.iid === keep[0]) continue;
            logLine(s, `${name} is put into the graveyard (legend rule)`, {
              player: p,
              iids: [c.iid],
            });
            this.emit(moveCardRaw(s, c.iid, 'graveyard'));
          }
          changed = true;
        }
      }

      if (!changed) return;
    }
  }

  private playerLoses(p: PlayerId, reason: 'life' | 'deckOut' | 'concede' | 'unpaidPact'): void {
    const s = this.state;
    if (s.players[p].hasLost) return;
    s.players[p].hasLost = true;
    s.players[p].lostReason = reason;
    s.winner = otherPlayer(p);
    s.endReason =
      reason === 'life'
        ? 'life total reached 0'
        : reason === 'deckOut'
          ? 'tried to draw from an empty library'
          : reason === 'unpaidPact'
            ? 'a pact came due and went unpaid'
            : 'conceded';
    this.events.push({ t: 'gameOver', winner: s.winner, reason: s.endReason });
    logLine(s, `${p} loses — ${s.endReason}`, { player: p });
  }

  // -------------------------------------------------------------------------
  // Triggers onto the stack
  // -------------------------------------------------------------------------

  private *putTriggersOnStack(): Eff {
    const s = this.state;
    const all = s.pendingTriggers;
    s.pendingTriggers = [];

    // APNAP: the active player's triggers go on the stack first (and so resolve last).
    for (const p of [s.activePlayer, otherPlayer(s.activePlayer)]) {
      const mine = all.filter((t) => t.controller === p);
      if (mine.length === 0) continue;

      let ordered = mine;
      if (mine.length > 1) {
        const res = (yield this.request({
          kind: 'orderTriggers',
          player: p,
          triggers: mine.map((t) => ({ id: t.id, label: t.label, sourceIid: t.sourceIid })),
          prompt: 'Order your triggers (first will resolve last)',
        })) as ChoiceResponse;
        if (res.kind === 'order') {
          ordered = res.ids.map((id) => mine.find((t) => t.id === id)!).filter(Boolean);
        }
      }

      for (const trig of ordered) {
        yield* this.pushTriggerObject(trig);
      }
    }
    this.resetPriority();
  }

  /**
   * Sagas march at the beginning of the controller's precombat main (CR 714.3b,
   * folded to where the engine already fires "beginning of main" business).
   * The chapter is announced as an event; the saga's own script hears it like
   * any other trigger. Sacrifice-when-done is a state-based action.
   */
  private advanceSagas(): void {
    const s = this.state;
    for (const c of battlefield(s, s.activePlayer)) {
      const script = getScript(c.oracleId);
      if (!script?.saga) continue;
      c.counters['lore'] = (c.counters['lore'] ?? 0) + 1;
      this.events.push({ t: 'counterAdded', iid: c.iid, kind: 'lore', n: 1 });
      this.emit([{ t: 'sagaChapter', iid: c.iid, chapter: c.counters['lore'] }]);
    }
  }

  /**
   * Cumulative upkeep (CR 702.24): an age counter, then pay per counter or
   * sacrifice. Mystic Remora is the only card that brings this here, and the
   * question it creates every upkeep is the card's whole cost.
   */
  private *cumulativeUpkeep(): Eff {
    const s = this.state;
    const ap = s.activePlayer;
    for (const c of [...battlefield(s, ap)]) {
      const script = getScript(c.oracleId);
      if (!script?.cumulativeUpkeep) continue;
      c.counters['age'] = (c.counters['age'] ?? 0) + 1;
      const age = c.counters['age'];
      const per = parseCost(script.cumulativeUpkeep);
      const symbols: CostSymbol[] = [];
      for (let i = 0; i < age; i++) symbols.push(...per);
      const plan = solvePayment(symbols, s.players[ap].manaPool, this.manaSources(ap), s.players[ap].life);
      let paid = false;
      if (plan) {
        const res = (yield this.request({
          kind: 'yesNo',
          player: ap,
          prompt: `${cardName(c)} — cumulative upkeep: pay ${script.cumulativeUpkeep} × ${age}?`,
          yesLabel: `Pay for ${age}`,
          noLabel: 'Sacrifice it',
        })) as ChoiceResponse;
        paid = res.kind === 'yesNo' && res.value;
        if (paid && plan) this.executePayment(ap, plan, symbols);
      }
      if (!paid) {
        logLine(s, `sacrifices ${cardName(c)} (cumulative upkeep)`, { player: ap, iids: [c.iid] });
        this.emit(moveCardRaw(s, c.iid, 'graveyard'));
      } else {
        logLine(s, `pays cumulative upkeep for ${cardName(c)} (${age})`, { player: ap, iids: [c.iid] });
      }
    }
  }

  private *pushTriggerObject(trig: PendingTrigger): Eff {
    const s = this.state;
    const source = s.cards[trig.sourceIid];
    if (!source) return;
    const script = getScript(source.oracleId);
    const ability = script?.abilities?.[trig.abilityIndex];
    if (!ability || ability.kind !== 'triggered') return;

    const iid = s.nextIid++;
    const obj: CardInstance = {
      ...makeCard(iid, source.oracleId, trig.controller, 'stack'),
      isAbility: true,
      abilitySource: trig.sourceIid,
      abilityIndex: trig.abilityIndex,
      abilityContext: trig.context,
      abilityLabel: trig.label,
      controller: trig.controller,
    };
    s.cards[iid] = obj;

    // Modes and mode-dependent targets are chosen now (CR 601.2b), not on resolution,
    // so the opponent can see what is happening before they respond.
    if (ability.onStack) {
      const ctx = this.makeCtx(source, trig.controller, [], [], trig.context);
      const picked = yield* ability.onStack(ctx);
      if (picked === null) {
        delete s.cards[iid];
        logLine(s, `${cardName(source)} trigger removed — nothing legal to choose`, {
          player: trig.controller,
          iids: [trig.sourceIid],
        });
        return;
      }
      obj.chosenModes = picked.modes ?? [];
      obj.targets = picked.targets ?? [];
    }

    // Targets are chosen now, as the ability is put on the stack.
    if (ability.targets && ability.targets.length > 0) {
      const chosen = yield* this.chooseTargetsForDefs(
        ability.targets,
        trig.controller,
        obj,
        trig.sourceIid,
      );
      if (chosen === null) {
        // CR 603.3d — a triggered ability with no legal targets is simply removed.
        // This is why an Orcish Bowmasters trigger into Veil of Summer does not
        // amass either: the whole ability goes away, not just the damage.
        delete s.cards[iid];
        logLine(s, `${cardName(source)} trigger removed — no legal targets`, {
          player: trig.controller,
          iids: [trig.sourceIid],
        });
        return;
      }
      obj.targets = chosen;
    }

    s.stack.push(iid);
    logLine(
      s,
      `${cardName(source)}: ${trig.label}${
        obj.targets?.length ? ` → ${obj.targets.map((t) => targetLabel(s, t)).join(', ')}` : ''
      }`,
      { player: trig.controller, iids: [trig.sourceIid] },
    );
  }

  // -------------------------------------------------------------------------
  // Casting
  // -------------------------------------------------------------------------

  private *castSpell(
    player: PlayerId,
    iid: IID,
    opts: {
      free: boolean;
      alt: boolean;
      kicked: boolean;
      from: 'hand' | 'graveyard' | 'exile' | 'library';
      flashback: boolean;
      escape: boolean;
      holdPriority: boolean;
    },
  ): Eff {
    const s = this.state;
    const card = s.cards[iid];
    if (!card || card.zone !== opts.from) return;

    const script = getScript(card.oracleId);
    const face = frontFace(card.oracleId);

    // Onto the stack first (CR 601.2a).
    card.face = 'front';
    this.emit(moveCardRaw(s, iid, 'stack', { controller: player }));
    card.controller = player;
    card.stackMv = face.mv;
    card.castForFree = opts.free;
    card.kicked = opts.kicked || undefined;
    card.flashedBack = opts.flashback || undefined;
    card.escaped = opts.escape || undefined;
    s.castingIid = iid;

    /*
     * Escape's cost is written on the card, not on the mana line: the escape
     * mana replaces the printed cost, and five other cards leave the graveyard
     * on the way. The exile happens now, as a cost — countering the spell does
     * not give the cards back.
     */
    if (opts.escape && script?.escape) {
      const others = cardsIn(s, player, 'graveyard').filter((c) => c.iid !== iid);
      const exiled = yield* this.chooseCardsInternal({
        player,
        cards: others.map((c) => c.iid),
        min: script.escape.exile,
        max: script.escape.exile,
        prompt: `Escape — exile ${script.escape.exile} other cards from your graveyard`,
        from: 'graveyard',
      });
      if (exiled.length < script.escape.exile) {
        this.emit(moveCardRaw(s, iid, 'graveyard'));
        s.castingIid = null;
        return;
      }
      for (const e of exiled) this.emit(moveCardRaw(s, e, 'exile'));
    }

    let symbols: CostSymbol[] = parseCost(
      opts.escape && script?.escape ? script.escape.cost : face.manaCost,
    );
    // Kicker is an additional cost: the two are one payment (CR 601.2f).
    if (opts.kicked && script?.kicker) {
      symbols = [...symbols, ...parseCost(script.kicker.cost)];
    }

    // Delve. Meaningless when casting for free — there is no cost to reduce —
    // so the prompt is skipped entirely rather than shown and ignored.
    if (script?.hasDelve && !opts.free) {
      const gy = cardsIn(s, player, 'graveyard').filter((c) => c.iid !== iid);
      const maxUseful = Math.min(gy.length, genericPortion(symbols));
      if (maxUseful > 0) {
        const picked = yield* this.chooseCardsInternal({
          player,
          cards: gy.map((c) => c.iid),
          min: 0,
          max: maxUseful,
          prompt: `Delve — exile up to ${maxUseful} cards from your graveyard to pay {1} each`,
          from: 'graveyard',
        });
        if (picked.length > 0) {
          card.delved = picked;
          for (const d of picked) this.emit(moveCardRaw(s, d, 'exile'));
          symbols = reduceGeneric(symbols, picked.length);
        }
      }
    }

    /*
     * An aura chooses what it will enchant as it is cast — it is a target like
     * any other, which is why a Utopia Sprawl with no Forest is uncastable
     * rather than a two-mana way to mill yourself one card.
     */
    if (script?.enchant) {
      const chosen = yield* this.chooseTargetsForDefs(
        [{ prompt: script.enchant.prompt, candidates: (st, pl) => script.enchant!.candidates(st, pl) }],
        player,
        card,
        iid,
      );
      if (chosen === null) {
        this.emit(moveCardRaw(s, iid, opts.from));
        s.castingIid = null;
        return;
      }
      card.targets = chosen;
    }

    /*
     * Modes first, then the targets those modes ask for (CR 601.2b before
     * 601.2c). Both happen while the spell is being cast, in the open, so the
     * opponent decides how to respond knowing what it will do.
     */
    if (script?.modes) {
      const options = script.modes.options.map((m, index) => ({
        index,
        text: m.text,
        // Same question the cast-legality check asked, so the two cannot drift.
        enabled: modeUsable(s, player, card, m),
      }));
      const picked = yield* this.chooseModeInternal({
        player,
        modes: options,
        min: script.modes.min,
        max: script.modes.max,
        prompt: script.modes.prompt,
      });
      card.chosenModes = picked;
      const defs = picked.flatMap((i) => script.modes!.options[i]?.targets ?? []);
      if (defs.length > 0) {
        const chosen = yield* this.chooseTargetsForDefs(defs, player, card, iid);
        if (chosen === null) {
          this.emit(moveCardRaw(s, iid, opts.from));
          s.castingIid = null;
          return;
        }
        card.targets = chosen;
      }
    }

    // Targets.
    if (script?.targets && script.targets.length > 0) {
      const chosen = yield* this.chooseTargetsForDefs(script.targets, player, card, iid);
      if (chosen === null) {
        // Should not happen — legality was checked before the intent was accepted.
        this.emit(moveCardRaw(s, iid, opts.from));
        s.castingIid = null;
        return;
      }
      card.targets = chosen;
    }

    /*
     * Non-mana additional costs (Bitter Triumph's discard-or-life, Abhorrent
     * Oculus's exile-six) are paid with everything else, after targets — you
     * know what you are buying before you pay for it. They apply however the
     * mana half is being paid, Omniscience included: "without paying its mana
     * cost" waives the mana, never the rest (CR 601.2f).
     */
    if (script?.additionalCost) {
      const paid = yield* script.additionalCost.pay(
        this.makeCtx(card, player, card.targets ?? [], [], {}),
      );
      if (!paid) {
        this.emit(moveCardRaw(s, iid, opts.from));
        s.castingIid = null;
        return;
      }
    }

    // Pay.
    const altCost = opts.alt ? script?.altCost : undefined;
    if (altCost) {
      /*
       * An alternative cost replaces the mana cost, so nothing here touches mana —
       * CR 601.2f still applies, it is just that the total cost is "exile two blue
       * cards" instead of {5}{U}{U}. It is paid after targets, like any cost.
       */
      const paid = yield* altCost.pay(this.makeCtx(card, player, card.targets ?? [], [], {}));
      if (!paid) {
        this.emit(moveCardRaw(s, iid, 'hand'));
        s.castingIid = null;
        return;
      }
    } else if (opts.free && opts.kicked && script?.kicker) {
      /*
       * Omniscience waives the mana cost, never the kicker: "without paying its
       * mana cost" and "you may pay an additional" are different sentences
       * (CR 118.7a). A free kicked spell still pays the kicker.
       */
      const kickSymbols = parseCost(script.kicker.cost);
      const plan = solvePayment(
        kickSymbols,
        s.players[player].manaPool,
        this.manaSources(player),
        s.players[player].life,
      );
      if (!plan) {
        this.emit(moveCardRaw(s, iid, opts.from));
        s.castingIid = null;
        return;
      }
      this.executePayment(player, plan, kickSymbols);
    } else if (!opts.free) {
      const plan = solvePayment(
        symbols,
        s.players[player].manaPool,
        this.manaSources(player),
        s.players[player].life,
      );
      if (!plan) {
        this.emit(moveCardRaw(s, iid, opts.from));
        s.castingIid = null;
        return;
      }
      this.executePayment(player, plan, symbols);
      // Compleated reads how the Phyrexian half was paid (Jace enters weaker).
      if (plan.life) card.phyrexianLifePaid = plan.life;
    }

    s.castingIid = null;
    s.players[player].spellsCastThisTurn.push({
      iid,
      oracleId: card.oracleId,
      colors: face.colors,
      mv: face.mv,
    });
    s.players[player].spellsCastThisTurnCount++;
    attachNextSpellShield(s, iid);

    logLine(
      s,
      `casts ${cardName(card)}${
        opts.free ? ' (free)' : altCost ? ` (${altCost.label})` : ''
      }${
        card.targets?.length ? ` → ${card.targets.map((t) => targetLabel(s, t)).join(', ')}` : ''
      }`,
      { player, iids: [iid] },
    );
    this.emit([{ t: 'spellCast', iid, controller: player, free: opts.free }]);

    /*
     * Storm (CR 702.40): count every spell cast before this one this turn, by
     * both players, and put that many copies on top of it. The copies are real
     * stack objects that cease to exist when they leave the stack.
     */
    const stormy =
      script?.storm ||
      ((face.types.includes('Instant') || face.types.includes('Sorcery')) &&
        s.effects.some((e) => e.kind === 'stormEmblem' && e.player === player));
    if (stormy) {
      const before =
        s.players.p1.spellsCastThisTurnCount + s.players.p2.spellsCastThisTurnCount - 1;
      if (before > 0) {
        logLine(s, `storm — ${before} ${before === 1 ? 'copy' : 'copies'}`, {
          player,
          iids: [iid],
        });
        for (let i = 0; i < before; i++) {
          yield* this.copySpell(iid, player, { mayRetarget: true });
        }
      }
    }

    // CR 117.3c — the player who cast it receives priority again. Passing that
    // priority straight to the opponent is a client convenience (auto-pass), not
    // something the rules do, and burying it here made the engine behave
    // differently depending on whose turn it was.
    this.retainPriority(player);
  }

  /**
   * Put a copy of a spell on the stack (Narset's Reversal, storm, Founding III).
   *
   * A copy is a full stack object with the same choices, and no card behind it:
   * when it leaves the stack it ceases to exist rather than changing zones.
   */
  *copySpell(
    srcIid: IID,
    controller: PlayerId,
    opts: { mayRetarget?: boolean } = {},
  ): Eff<IID | null> {
    const s = this.state;
    const src = s.cards[srcIid];
    if (!src || src.zone !== 'stack') return null;
    const iid = s.nextIid++;
    const copy: CardInstance = {
      ...makeCard(iid, src.oracleId, controller, 'stack'),
      controller,
      isCopy: true,
      stackMv: src.stackMv,
      targets: src.targets ? [...src.targets] : undefined,
      chosenModes: src.chosenModes ? [...src.chosenModes] : undefined,
      kicked: src.kicked,
    };
    s.cards[iid] = copy;
    s.stack.push(iid);
    logLine(s, `a copy of ${cardName(src)} is put on the stack`, {
      player: controller,
      iids: [iid],
    });
    if (opts.mayRetarget && copy.targets && copy.targets.length > 0) {
      const change = yield* this.makeCtx(copy, controller, [], [], {}).yesNo(
        controller,
        `Choose new targets for the copy of ${cardName(src)}?`,
        { yes: 'New targets', no: 'Keep them' },
      );
      if (change) yield* this.makeCtx(copy, controller, [], [], {}).chooseNewTargetsFor(iid, controller);
    }
    return iid;
  }

  /**
   * Turn a manifested card face up for its mana cost (CR 708.8). Only creature
   * cards may — the face-down 2/2 that is secretly a sorcery stays a secret.
   */
  private *turnFaceUp(player: PlayerId, iid: IID): Eff {
    const s = this.state;
    const card = s.cards[iid];
    if (!card || card.zone !== 'battlefield' || !card.faceDown) return;
    const face = frontFace(card.oracleId);
    if (!face.types.includes('Creature')) return;
    const symbols = parseCost(face.manaCost);
    const plan = solvePayment(symbols, s.players[player].manaPool, this.manaSources(player), s.players[player].life);
    if (!plan) return;
    this.executePayment(player, plan, symbols);
    card.faceDown = undefined;
    logLine(s, `turns ${cardName(card)} face up`, { player, iids: [iid] });
    this.emit([{ t: 'turnedFaceUp', iid }]);
  }

  private *activateAbility(player: PlayerId, iid: IID, index: number): Eff {
    const s = this.state;
    const source = s.cards[iid];
    if (!source) return;
    const script = getScript(source.oracleId);
    const ability = script?.abilities?.[index];
    if (!ability || ability.kind !== 'activated') return;

    /*
     * A -X loyalty ability asks for X before anything else is paid: X is part of
     * the cost, so it is chosen while the ability is being activated (CR 601.2b
     * as it applies to abilities) rather than on resolution.
     */
    let chosenX = 0;
    if (ability.cost.loyaltyX) {
      const have = source.counters['loyalty'] ?? 0;
      if (have <= 0) return;
      const res = (yield this.request({
        kind: 'chooseMode',
        player,
        modes: Array.from({ length: have }, (_, i) => ({
          index: i + 1,
          text: `X = ${i + 1}`,
          enabled: true,
        })),
        min: 1,
        max: 1,
        prompt: 'Choose X',
      })) as ChoiceResponse;
      chosenX = res.kind === 'modes' ? (res.modes[0] ?? 1) : 1;
      source.counters['loyalty'] = Math.max(0, have - chosenX);
      source.loyaltyActivatedTurn = s.turn;
      this.sbaDirty = true;
    }

    // Pay costs first. Mana abilities and land activations do not use the stack.
    if (!this.payActivationCost(player, source, ability.cost)) return;

    if (ability.isManaAbility) {
      const ctx = this.makeCtx(source, player, [], [], {});
      // A targeted mana ability still needs its target (Deathrite's first mode).
      if (ability.targets && ability.targets.length > 0) {
        const chosen = yield* this.chooseTargetsForDefs(ability.targets, player, source, iid);
        if (chosen === null) return;
        const targeted = this.makeCtx(source, player, chosen, [], {});
        yield* ability.resolve(targeted);
        return;
      }
      yield* ability.resolve(ctx);
      return;
    }

    const objIid = s.nextIid++;
    const obj: CardInstance = {
      ...makeCard(objIid, source.oracleId, player, 'stack'),
      isAbility: true,
      abilitySource: iid,
      abilityIndex: index,
      abilityContext: ability.cost.loyaltyX ? { x: chosenX } : {},
      abilityLabel: ability.text,
      controller: player,
    };
    s.cards[objIid] = obj;

    if (ability.targets && ability.targets.length > 0) {
      const chosen = yield* this.chooseTargetsForDefs(ability.targets, player, obj, iid);
      if (chosen === null) {
        delete s.cards[objIid];
        return;
      }
      obj.targets = chosen;
    }

    s.stack.push(objIid);
    logLine(s, `activates ${cardName(source)}: ${ability.text}`, { player, iids: [iid] });
    // CR 117.3c again: activating in the opponent's end step must not hand the
    // turn back to them mid-sentence.
    this.retainPriority(player);
  }

  private payActivationCost(
    player: PlayerId,
    source: CardInstance,
    cost: ActivationCost,
  ): boolean {
    const s = this.state;
    if (cost.loyaltyX) {
      // Handled in activateAbility, which can ask a question; payActivationCost
      // is synchronous by design and must not grow a prompt.
      return true;
    }
    if (cost.loyalty !== undefined) {
      // CR 606.3 — the counters are the cost, so a minus you cannot afford is
      // not an ability you may activate.
      const have = source.counters['loyalty'] ?? 0;
      if (have + cost.loyalty < 0) return false;
      source.counters['loyalty'] = have + cost.loyalty;
      source.loyaltyActivatedTurn = s.turn;
      this.events.push({
        t: 'counterAdded',
        iid: source.iid,
        kind: 'loyalty',
        n: cost.loyalty,
      });
      this.sbaDirty = true;
    }
    if (cost.mana) {
      const symbols = parseCost(cost.mana);
      const plan = solvePayment(
        symbols,
        s.players[player].manaPool,
        this.manaSources(player, source.iid),
        s.players[player].life,
      );
      if (!plan) return false;
      this.executePayment(player, plan, symbols);
    }
    if (cost.tap) {
      if (source.tapped) return false;
      source.tapped = true;
      this.events.push({ t: 'tapped', iid: source.iid });
    }
    if (cost.life) {
      this.changeLife(player, -cost.life);
    }
    if (cost.sacrificeSelf) {
      this.emit(moveCardRaw(s, source.iid, 'graveyard'));
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  private *resolveTop(): Eff {
    const s = this.state;
    const iid = s.stack[s.stack.length - 1];
    if (iid === undefined) return;
    const obj = s.cards[iid];
    if (!obj) {
      s.stack.pop();
      return;
    }

    if (obj.isAbility) {
      yield* this.resolveAbilityObject(obj);
    } else {
      yield* this.resolveSpell(obj);
    }
    this.resetPriority();
  }

  private *resolveSpell(spell: CardInstance): Eff {
    const s = this.state;
    const script = getScript(spell.oracleId);

    // CR 608.2b — a spell whose targets are all illegal does not resolve.
    if (spell.targets && spell.targets.length > 0) {
      const anyLegal = spell.targets.some((t) =>
        this.isLegalTarget(t, spell.iid, spell.controller),
      );
      if (!anyLegal) {
        logLine(s, `${cardName(spell)} fizzles — no legal targets`, {
          player: spell.controller,
          iids: [spell.iid],
        });
        this.events.push({ t: 'spellFizzled', iid: spell.iid });
        this.emit(moveCardRaw(s, spell.iid, 'graveyard'));
        return;
      }
    }

    this.events.push({ t: 'spellResolved', iid: spell.iid });

    // CR 608.2m — the spell stays on the stack for the whole of its resolution and
    // is only put into the graveyard as the final step. Popping it first would leave
    // it in no zone at all while the script waits on a choice.
    if (script?.resolve) {
      const ctx = this.makeCtx(spell, spell.controller, spell.targets ?? [], spell.chosenModes ?? [], {});
      yield* script.resolve(ctx);
    }

    // moveCardRaw removes it from the stack on the way out.
    if (spell.isCopy) {
      // A copy ceases to exist the moment it would leave the stack (CR 707.10a) —
      // even a copy of a permanent spell never reaches the battlefield here,
      // because nothing in this pool copies permanent spells.
      removeFromStack(s, spell.iid);
      delete s.cards[spell.iid];
    } else if (isPermanentCard(spell)) {
      yield* this.putOntoBattlefield(spell.iid, { controller: spell.controller });
      /*
       * An aura attaches to what it was targeting as it resolves (CR 303.4f).
       * Animate Dead is the exception that proves it: it enchants nothing on the
       * way in and attaches to what its own trigger makes.
       */
      const script = getScript(spell.oracleId);
      if (script?.enchant && spell.targets?.[0]?.kind === 'permanent') {
        spell.attachedTo = spell.targets[0].iid;
      }
    } else if (spell.flashedBack) {
      // CR 702.34a — a flashbacked spell exiles instead of going anywhere else.
      logLine(s, `${cardName(spell)} is exiled (flashback)`, {
        player: spell.controller,
        iids: [spell.iid],
      });
      this.emit(moveCardRaw(s, spell.iid, 'exile'));
    } else {
      this.emit(moveCardRaw(s, spell.iid, 'graveyard'));
    }
  }

  private *resolveAbilityObject(obj: CardInstance): Eff {
    const s = this.state;
    const sourceIid = obj.abilitySource!;
    const source = s.cards[sourceIid];
    const script = source ? getScript(source.oracleId) : getScript(obj.oracleId);
    const ability = script?.abilities?.[obj.abilityIndex!];

    if (obj.targets && obj.targets.length > 0) {
      const anyLegal = obj.targets.some((t) => this.isLegalTarget(t, sourceIid, obj.controller));
      if (!anyLegal) {
        removeFromStack(s, obj.iid);
        logLine(s, `${obj.abilityLabel ?? 'Ability'} fizzles — no legal targets`, {
          player: obj.controller,
          iids: [sourceIid],
        });
        delete s.cards[obj.iid];
        return;
      }
    }

    // Same as a spell: the ability stays on the stack while it resolves.
    if (ability && (ability.kind === 'triggered' || ability.kind === 'activated')) {
      // The source may already be gone; the ability still resolves using LKI.
      const selfForCtx = source ?? obj;
      const ctx = this.makeCtx(
        selfForCtx,
        obj.controller,
        obj.targets ?? [],
        obj.chosenModes ?? [],
        obj.abilityContext ?? {},
      );
      yield* ability.resolve(ctx);
    }
    removeFromStack(s, obj.iid);
    delete s.cards[obj.iid];
  }

  /** Counter a spell. Respects "can't be countered" from every source. */
  counterSpell(
    spellIid: IID,
    byIid: IID | null,
    opts: { exile?: boolean; toLibraryTop?: boolean } = {},
  ): boolean {
    const s = this.state;
    const spell = s.cards[spellIid];
    if (!spell || spell.zone !== 'stack') return false;
    const script = getScript(spell.oracleId);
    const lier = spellsUncounterableBy(s)[0];
    if (lier) {
      logLine(s, `${cardName(spell)} can't be countered (${cardName(lier)})`, {
        player: spell.controller,
        iids: [spellIid, lier.iid],
      });
      return false;
    }
    if (spellCantBeCountered(s, spellIid, Boolean(script?.cantBeCountered))) {
      logLine(s, `${cardName(spell)} can't be countered`, {
        player: spell.controller,
        iids: [spellIid],
      });
      return false;
    }
    this.events.push({ t: 'spellCountered', iid: spellIid, by: byIid });
    logLine(
      s,
      `${cardName(spell)} is countered${opts.exile ? ' and exiled' : ''}`,
      { player: spell.controller, iids: [spellIid] },
    );
    if (spell.isCopy) {
      removeFromStack(s, spellIid);
      delete s.cards[spellIid];
      return true;
    }
    /*
     * Where a countered spell lands is half of what distinguishes these cards:
     * Force of Negation exiles it (Dig Through Time delves graveyards and Mystic
     * Sanctuary buys instants back out of them), Memory Lapse puts it on top of
     * the library, and everything else uses the graveyard.
     */
    if (opts.toLibraryTop) {
      this.emit(moveCardRaw(s, spellIid, 'library', { position: 'top' }));
    } else {
      this.emit(moveCardRaw(s, spellIid, opts.exile ? 'exile' : 'graveyard'));
    }
    return true;
  }

  /**
   * Take over a spell on the stack (Commandeer).
   *
   * Only the controller changes. Ownership does not, which is why the card still
   * goes to its owner's graveyard afterwards — CR 108.3.
   */
  gainControlOfSpell(spellIid: IID, player: PlayerId): boolean {
    const s = this.state;
    const spell = s.cards[spellIid];
    if (!spell || spell.zone !== 'stack' || spell.isAbility) return false;
    if (spell.controller === player) return false;
    spell.controller = player;
    logLine(s, `gains control of ${cardName(spell)}`, { player, iids: [spellIid] });
    return true;
  }

  // -------------------------------------------------------------------------
  // Battlefield entry
  // -------------------------------------------------------------------------

  private *putOntoBattlefield(
    iid: IID,
    opts: { tapped?: boolean; face?: 'front' | 'back'; controller?: PlayerId } = {},
  ): Eff {
    const s = this.state;
    const card = s.cards[iid];
    if (!card) return;
    const controller = opts.controller ?? card.controller ?? card.owner;
    const tapped = yield* this.resolveEntersReplacement(iid, controller, opts);
    /*
     * Starting loyalty, before the move so the counters are there the instant it
     * is on the battlefield and no state-based check can see a zero-loyalty
     * planeswalker. Compleated: a Phyrexian pip paid with life means two fewer.
     */
    const face = frontFace(card.oracleId);
    if (face.types.includes('Planeswalker') && face.loyalty) {
      const printed = Number(face.loyalty);
      const compleated = card.phyrexianLifePaid ? Math.floor(card.phyrexianLifePaid / 2) * 2 : 0;
      if (Number.isFinite(printed)) {
        card.counters['loyalty'] = Math.max(0, printed - compleated);
      }
    }
    this.emit(
      moveCardRaw(s, iid, 'battlefield', { tapped, face: opts.face, controller }),
    );
  }

  /** Runs the "as this enters" replacement and reports whether it enters tapped. */
  private *resolveEntersReplacement(
    iid: IID,
    controller: PlayerId,
    opts: { tapped?: boolean; face?: 'front' | 'back' },
  ): Eff<boolean> {
    const s = this.state;
    const card = s.cards[iid];
    const script = getScript(card.oracleId);
    // The face matters: Inundated Archive's "enters tapped" belongs to the back face.
    const prevFace = card.face;
    if (opts.face) card.face = opts.face;
    let tapped = Boolean(opts.tapped);
    if (script?.asEnters) {
      this.enterTappedFlag = false;
      const ctx = this.makeCtx(card, controller, [], [], {});
      yield* script.asEnters(ctx);
      if (this.enterTappedFlag) tapped = true;
    }
    card.face = prevFace;
    return tapped;
  }

  /**
   * Show and Tell's payoff: several permanents enter the battlefield at the same
   * time, so both ETB triggers are collected together and then ordered APNAP.
   * Doing this as a loop would let the first card's trigger see a board the second
   * card had not joined yet.
   */
  private *enterSimultaneously(entries: { iid: IID; tapped?: boolean }[]): Eff {
    const s = this.state;
    const resolved: { iid: IID; tapped: boolean }[] = [];
    // Scryfall ruling on Show and Tell: choices for the entering cards are made by
    // the active player first, then the other player in turn order.
    entries = [...entries].sort((a, b) => {
      const ca = s.cards[a.iid]?.controller;
      const cb = s.cards[b.iid]?.controller;
      if (ca === cb) return 0;
      return ca === s.activePlayer ? -1 : 1;
    });
    for (const e of entries) {
      const card = s.cards[e.iid];
      if (!card) continue;
      const tapped = yield* this.resolveEntersReplacement(e.iid, card.controller ?? card.owner, {
        tapped: e.tapped,
      });
      resolved.push({ iid: e.iid, tapped });
    }
    const events: GameEvent[] = [];
    for (const r of resolved) {
      const card = s.cards[r.iid];
      if (!card) continue;
      events.push(
        ...moveCardRaw(s, r.iid, 'battlefield', {
          tapped: r.tapped,
          controller: card.controller ?? card.owner,
        }),
      );
    }
    this.emit(events);
  }

  // -------------------------------------------------------------------------
  // Turn structure
  // -------------------------------------------------------------------------

  private stepGrantsPriority(): boolean {
    const s = this.state;
    if (s.step === 'untap' || s.step === 'cleanup') return false;
    return true;
  }

  private *beginStep(): Eff {
    const s = this.state;
    // Through emit, not a bare push: Wilderness Reclamation triggers on the end
    // step beginning, and a trigger cannot hear an event that bypasses the
    // collector.
    this.emit([
      {
        t: 'stepChange',
        phase: s.phase,
        step: s.step,
        turn: s.turn,
        activePlayer: s.activePlayer,
      },
    ]);

    switch (s.step) {
      case 'untap': {
        const ap = s.activePlayer;
        s.players[ap].landDropsUsed = 0;
        for (const p of ['p1', 'p2'] as PlayerId[]) {
          s.players[p].spellsCastThisTurn = [];
          s.players[p].spellsCastThisTurnCount = 0;
          s.players[p].drawsThisTurn = 0;
        }
        for (const c of battlefield(s, ap)) {
          if (c.tapped) {
            c.tapped = false;
            this.events.push({ t: 'untapped', iid: c.iid });
          }
          c.summoningSick = false;
        }
        logLine(s, `— Turn ${s.turn} (${ap}) —`, { player: ap });
        break;
      }
      case 'draw': {
        const ap = s.activePlayer;
        s.players[ap].drawsThisDrawStep = 0;
        // The player on the play skips their first draw step.
        if (!(s.turn === 1 && ap === s.startingPlayer)) {
          this.draw(ap, 1);
        }
        break;
      }
      case 'upkeep': {
        yield* this.fireDelayedTriggers('upkeep');
        yield* this.cumulativeUpkeep();
        break;
      }
      case 'main': {
        yield* this.fireDelayedTriggers('main');
        if (s.phase === 'precombat_main') this.advanceSagas();
        break;
      }
      case 'end_step': {
        yield* this.fireDelayedTriggers('end');
        break;
      }
      case 'declare_attackers': {
        yield* this.declareAttackers();
        break;
      }
      case 'declare_blockers': {
        yield* this.declareBlockers();
        break;
      }
      case 'combat_damage': {
        yield* this.dealCombatDamage();
        break;
      }
      case 'end_of_combat': {
        this.clearCombat();
        break;
      }
      case 'cleanup': {
        yield* this.cleanupStep();
        break;
      }
      default:
        break;
    }
  }

  private endStep(): void {
    const s = this.state;
    // CR 500.4 — mana pools empty at the end of every step and phase.
    for (const p of ['p1', 'p2'] as PlayerId[]) {
      if (!poolIsEmpty(s.players[p].manaPool)) {
        s.players[p].manaPool = emptyPool();
        this.events.push({ t: 'manaEmptied', player: p });
      }
    }
    s.priorityPlayer = null;
    s.passed = [];
    s.stepInitialized = false;

    let nextIndex = s.stepIndex + 1;
    // CR 506.5 — if no creatures were declared as attackers, the declare blockers
    // and combat damage steps are skipped outright. Nothing can happen in them,
    // and without this a combatless turn still costs both players two rounds of
    // priority they can only pass through.
    if (
      s.step === 'declare_attackers' &&
      (s.combat === null || s.combat.attackers.length === 0)
    ) {
      nextIndex = TURN_SEQUENCE.findIndex((r) => r.step === 'end_of_combat');
    }
    if (nextIndex >= TURN_SEQUENCE.length) {
      s.stepIndex = 0;
      const nextActive = otherPlayer(s.activePlayer);
      // `turn` counts rounds, not player-turns: it advances only when play
      // returns to whoever started the game, so both players' turns in the
      // same round carry the same number. A player's own turn count still
      // increases by exactly 1 every time it comes back around to them —
      // nothing that reads `turn` to mean "has a turn passed for me since
      // I last checked" needs to change.
      if (nextActive === s.startingPlayer) s.turn++;
      s.activePlayer = nextActive;
    } else {
      s.stepIndex = nextIndex;
    }
    const { phase, step } = stepAt(s.stepIndex);
    s.phase = phase;
    s.step = step;
  }

  /**
   * The promises that came due this step.
   *
   * Filtering by controller alone is enough to mean "your next one": whichever
   * turn a delayed trigger was armed on, that player's own upkeep and main phase
   * for that turn have already gone by, so the next one to arrive is the next one
   * they get.
   */
  private *fireDelayedTriggers(when: 'upkeep' | 'main' | 'end'): Eff {
    const s = this.state;
    const ap = s.activePlayer;

    if (when === 'main') {
      const ready = s.delayed.filter((d) => d.kind === 'manaDrain' && d.controller === ap);
      s.delayed = s.delayed.filter((d) => !(d.kind === 'manaDrain' && d.controller === ap));
      for (const d of ready) {
        if (d.kind !== 'manaDrain') continue;
        // "Add an amount of {C} equal to that spell's mana value."
        s.players[ap].manaPool.C += d.amount;
        this.events.push({ t: 'manaAdded', player: ap, pool: clonePool(s.players[ap].manaPool) });
        logLine(s, `Mana Drain adds ${d.amount} colorless mana`, { player: ap });
      }
      return;
    }

    if (when === 'end') {
      /*
       * Sneak Attack and Through the Breach: "sacrifice at the beginning of the
       * next end step" — anyone's, not the controller's, which is why this does
       * not filter by active player. The creature may already be gone; a promise
       * about a thing that left is simply kept by doing nothing.
       */
      const ready = s.delayed.filter((d) => d.kind === 'sacrifice');
      s.delayed = s.delayed.filter((d) => d.kind !== 'sacrifice');
      for (const d of ready) {
        if (d.kind !== 'sacrifice') continue;
        const c = s.cards[d.iid];
        if (!c || c.zone !== 'battlefield') continue;
        logLine(s, `sacrifices ${cardName(c)}`, { player: d.controller, iids: [d.iid] });
        this.emit(moveCardRaw(s, d.iid, 'graveyard'));
      }
      return;
    }

    const ready = s.delayed.filter((d) => d.kind === 'pact' && d.controller === ap);
    s.delayed = s.delayed.filter((d) => !(d.kind === 'pact' && d.controller === ap));
    for (const d of ready) {
      if (d.kind !== 'pact') continue;
      /*
       * "Pay {3}{U}{U}. If you don't, you lose the game."
       *
       * Not optional in the sense that skipping it is free: this is the whole
       * price of the free counterspell, and a client that quietly paid or quietly
       * declined for you would be deciding the game. So it is always asked, even
       * when there is no way to pay — being told you cannot afford it is part of
       * knowing you have lost.
       */
      const name = s.cards[d.sourceIid] ? cardName(s.cards[d.sourceIid]) : 'A pact';
      const symbols = parseCost(d.cost);
      const plan = solvePayment(symbols, s.players[ap].manaPool, this.manaSources(ap), s.players[ap].life);
      if (plan) {
        const pay = (yield this.request({
          kind: 'yesNo',
          player: ap,
          prompt: `${name}: pay ${d.cost}, or lose the game`,
          yesLabel: `Pay ${d.cost}`,
          noLabel: 'Do not pay — lose the game',
        })) as ChoiceResponse;
        if (pay.kind === 'yesNo' && pay.value) {
          this.executePayment(ap, plan, symbols);
          logLine(s, `pays ${d.cost} for ${name}`, { player: ap, iids: [d.sourceIid] });
          continue;
        }
      } else {
        // No prompt when there is nothing to decide — being asked a question with
        // one answer is worse than being told what happened.
        logLine(s, `cannot pay ${d.cost} for ${name}`, { player: ap, iids: [d.sourceIid] });
      }
      this.playerLoses(ap, 'unpaidPact');
      return;
    }
  }

  private *cleanupStep(): Eff {
    const s = this.state;
    const ap = s.activePlayer;
    const hand = s.zones[ap].hand;
    if (hand.length > MAX_HAND_SIZE) {
      const discard = yield* this.chooseCardsInternal({
        player: ap,
        cards: [...hand],
        min: hand.length - MAX_HAND_SIZE,
        max: hand.length - MAX_HAND_SIZE,
        prompt: `Discard down to ${MAX_HAND_SIZE} cards`,
        from: 'hand',
      });
      for (const iid of discard) this.emit(moveCardRaw(s, iid, 'graveyard'));
    }
    for (const c of battlefield(s)) {
      c.damage = 0;
      c.deathtouched = false;
    }
    clearEndOfTurnEffects(s);
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  private *declareAttackers(): Eff {
    const s = this.state;
    const ap = s.activePlayer;
    const candidates = battlefield(s, ap)
      .filter((c) => isType(c, 'Creature') && !c.tapped && !c.summoningSick)
      .map((c) => c.iid);
    s.combat = { attackers: [], blocks: {}, damageOrder: {} };
    if (candidates.length === 0) return;

    const res = (yield this.request({
      kind: 'declareAttackers',
      player: ap,
      candidates,
      prompt: 'Declare attackers',
    })) as ChoiceResponse;
    if (res.kind !== 'attackers' || res.iids.length === 0) return;

    s.combat.attackers = res.iids;
    for (const iid of res.iids) {
      const c = s.cards[iid];
      if (!c) continue;
      c.attacking = true;
      // Vigilance means attacking does not tap.
      if (!hasKeywordNow(s, c, 'Vigilance')) {
        c.tapped = true;
        this.events.push({ t: 'tapped', iid });
      }
    }
    logLine(s, `attacks with ${res.iids.map((i) => nameOf(s, i)).join(', ')}`, {
      player: ap,
      iids: res.iids,
    });
    // Uro and Tamiyo both trigger on attacking, so the declaration is an event.
    this.emit(res.iids.map((iid) => ({ t: 'attacks' as const, iid, controller: ap })));
  }

  private *declareBlockers(): Eff {
    const s = this.state;
    if (!s.combat || s.combat.attackers.length === 0) return;
    const defender = otherPlayer(s.activePlayer);
    // An attacker can die between the two steps — an Orcish Bowmasters ping on an
    // Army token removes the object entirely — so re-check who is still there.
    const attackers = s.combat.attackers.filter(
      (iid) => s.cards[iid] && s.cards[iid].zone === 'battlefield',
    );
    if (attackers.length === 0) return;
    const blockers = battlefield(s, defender)
      .filter((c) => isType(c, 'Creature') && !c.tapped)
      .map((c) => c.iid);
    if (blockers.length === 0) return;

    const res = (yield this.request({
      kind: 'declareBlockers',
      player: defender,
      attackers,
      blockers,
      prompt: 'Declare blockers',
    })) as ChoiceResponse;
    if (res.kind !== 'blockers') return;

    for (const b of res.blocks) {
      s.combat.blocks[b.blocker] = b.attacker;
      s.combat.damageOrder[b.attacker] = [...(s.combat.damageOrder[b.attacker] ?? []), b.blocker];
    }
    if (res.blocks.length > 0) {
      logLine(
        s,
        `blocks: ${res.blocks
          .map((b) => `${nameOf(s, b.blocker)} blocks ${nameOf(s, b.attacker)}`)
          .join('; ')}`,
        { player: defender },
      );
    }

    // Attacker chooses the damage assignment order when blocked by several creatures.
    for (const atk of s.combat.attackers) {
      const list = s.combat.damageOrder[atk];
      if (!list || list.length < 2) continue;
      const ordered = yield* this.chooseCardsInternal({
        player: s.activePlayer,
        cards: list,
        min: list.length,
        max: list.length,
        ordered: true,
        prompt: `Damage assignment order for ${nameOf(s, atk)}`,
        from: 'battlefield',
      });
      s.combat.damageOrder[atk] = ordered;
    }
  }

  private *dealCombatDamage(): Eff {
    const s = this.state;
    if (!s.combat) return;
    const defender = otherPlayer(s.activePlayer);

    for (const atkIid of s.combat.attackers) {
      const atk = s.cards[atkIid];
      if (!atk || atk.zone !== 'battlefield') continue;
      const power = powerOf(s, atk);
      if (power <= 0) continue;
      const blockers = (s.combat.damageOrder[atkIid] ?? []).filter(
        (b) => s.cards[b] && s.cards[b].zone === 'battlefield',
      );

      if (blockers.length === 0) {
        const wasBlocked = Object.values(s.combat.blocks).includes(atkIid);
        // A blocked creature whose blockers all left deals no damage (no trample here).
        if (wasBlocked) continue;
        this.dealDamage({
          sourceIid: atkIid,
          target: { kind: 'player', id: defender },
          amount: power,
          deathtouch: hasKeywordNow(s, atk, 'Deathtouch'),
          lifelink: hasKeywordNow(s, atk, 'Lifelink'),
          lifelinkTo: atk.controller,
          combat: true,
        });
        continue;
      }

      // Assign in damage-assignment order; deathtouch makes 1 damage lethal.
      // Everything left over goes onto the last blocker rather than evaporating:
      // nothing here has trample, so that is always at least as good for the
      // attacker, and it is what lifelink actually pays out on.
      let remaining = power;
      const deathtouch = hasKeywordNow(s, atk, 'Deathtouch');
      for (let i = 0; i < blockers.length; i++) {
        if (remaining <= 0) break;
        const bIid = blockers[i];
        const b = s.cards[bIid];
        if (!b) continue;
        const isLast = i === blockers.length - 1;
        const lethal = deathtouch ? 1 : Math.max(1, toughnessOf(s, b) - b.damage);
        const assign = isLast ? remaining : Math.min(remaining, lethal);
        remaining -= assign;
        this.dealDamage({
          sourceIid: atkIid,
          target: { kind: 'permanent', iid: bIid },
          amount: assign,
          deathtouch,
          lifelink: hasKeyword(atk, 'Lifelink'),
          lifelinkTo: atk.controller,
        });
      }
    }

    // Blockers hit back.
    for (const [blockerIid, attackerIid] of Object.entries(s.combat.blocks)) {
      const b = s.cards[Number(blockerIid)];
      const a = s.cards[attackerIid];
      if (!b || b.zone !== 'battlefield' || !a || a.zone !== 'battlefield') continue;
      const power = powerOf(s, b);
      if (power <= 0) continue;
      this.dealDamage({
        sourceIid: b.iid,
        target: { kind: 'permanent', iid: a.iid },
        amount: power,
        deathtouch: hasKeyword(b, 'Deathtouch'),
        lifelink: hasKeyword(b, 'Lifelink'),
        lifelinkTo: b.controller,
      });
    }
  }

  private clearCombat(): void {
    const s = this.state;
    if (s.combat) {
      for (const iid of s.combat.attackers) {
        const c = s.cards[iid];
        if (c) c.attacking = false;
      }
    }
    s.combat = null;
  }

  // -------------------------------------------------------------------------
  // Mulligans
  // -------------------------------------------------------------------------

  private *mulliganPhase(): Eff {
    const s = this.state;
    const order: PlayerId[] = [s.activePlayer, otherPlayer(s.activePlayer)];

    for (const p of order) {
      if (s.zones[p].hand.length === 0) this.draw(p, 7);
    }

    // Both players decide at once. Asking in turn meant the second player's new
    // hand arrived only after the first had finished thinking, which reads as a
    // frozen client rather than as waiting.
    for (;;) {
      const undecided = order.filter((p) => !s.players[p].keptHand);
      if (undecided.length === 0) break;

      s.mulliganResponses = {};
      const res = (yield this.request({
        kind: 'mulligan',
        player: null,
        awaiting: [...undecided],
        lockedIn: [],
        hands: Object.fromEntries(
          order.map((p) => [
            p,
            {
              handSize: s.zones[p].hand.length,
              mulligansTaken: s.players[p].mulligansTaken,
            },
          ]),
        ) as Record<PlayerId, { handSize: number; mulligansTaken: number }>,
        prompt: 'Keep this hand?',
      })) as ChoiceResponse;
      const answers = res.kind === 'mulliganRound' ? res.keep : {};

      // Resolved in turn order so the log and the shuffles stay deterministic.
      for (const p of undecided) {
        if (answers[p] ?? true) {
          s.players[p].keptHand = true;
          // The London bottoming has not happened yet, so the kept size is the
          // hand minus what they are about to put back.
          const kept = s.zones[p].hand.length - cardsToBottom(s.players[p].mulligansTaken);
          logLine(s, `keeps ${kept}`, { player: p });
        } else {
          for (const iid of [...s.zones[p].hand]) moveCardRaw(s, iid, 'library');
          shuffleLibrary(s, p);
          this.events.push({ t: 'shuffle', player: p });
          s.players[p].mulligansTaken++;
          this.draw(p, 7);
          const to = handSizeAfter(s.players[p].mulligansTaken);
          logLine(s, to === 7 ? 'takes the free mulligan' : `mulligans to ${to}`, { player: p });
        }
      }
    }

    // London mulligan: bottom N after keeping, the free ones costing nothing.
    for (const p of order) {
      const n = Math.min(cardsToBottom(s.players[p].mulligansTaken), s.zones[p].hand.length);
      if (n === 0) continue;
      const chosen = yield* this.chooseCardsInternal({
        player: p,
        cards: [...s.zones[p].hand],
        min: n,
        max: n,
        ordered: true,
        prompt: `Put ${n} card(s) on the bottom of your library`,
        from: 'hand',
      });
      for (const iid of chosen) moveCardRaw(s, iid, 'library', { position: 'bottom' });
      logLine(s, `puts ${n} card${n === 1 ? '' : 's'} on the bottom`, { player: p });
    }

    s.mode = 'playing';
    s.stepInitialized = false;
    // Clear the events the opening hands generated; nothing should animate here.
    this.events = this.events.filter((e) => e.t !== 'draw' && e.t !== 'zoneChange');
  }

  // -------------------------------------------------------------------------
  // Player actions that do not use the stack
  // -------------------------------------------------------------------------

  private playLand(
    player: PlayerId,
    iid: IID,
    face: 'front' | 'back',
    from: 'hand' | 'graveyard' | 'exile' | 'library' = 'hand',
  ): void {
    const s = this.state;
    const card = s.cards[iid];
    if (!card || card.zone !== from) return;
    s.players[player].landDropsUsed++;
    logLine(s, `plays ${face === 'back' ? oracle(card.oracleId).faces![1].name : cardName(card)}`, {
      player,
      iids: [iid],
    });
    // Land drops never need the stack, but they can still have an as-enters
    // replacement, so they run through the same generator path.
    this.current = this.putOntoBattlefield(iid, { face, controller: player });
  }

  private tapForMana(player: PlayerId, iid: IID, kind: ManaKind): void {
    const s = this.state;
    const card = s.cards[iid];
    if (!card || card.zone !== 'battlefield' || card.tapped) return;
    if (!producedManaOf(card, s).includes(kind)) return;
    card.tapped = true;
    s.players[player].manaPool[kind]++;
    /*
     * Utopia Sprawl: "whenever enchanted Forest is tapped for mana, its
     * controller adds an additional one mana of the chosen color." A mana
     * ability's trigger is itself a mana ability (CR 605.1b) — no stack, the
     * mana just arrives with the land's own.
     */
    for (const bfIid of s.zones[player].battlefield) {
      const aura = s.cards[bfIid];
      if (!aura || aura.attachedTo !== iid || !aura.namedChoice) continue;
      if (!getScript(aura.oracleId)?.enchantedTapBonus) continue;
      const bonus = aura.namedChoice as ManaKind;
      s.players[player].manaPool[bonus]++;
      logLine(s, `${cardName(aura)} adds an extra {${bonus}}`, { player, iids: [bfIid] });
    }
    this.events.push({ t: 'tapped', iid });
    this.events.push({ t: 'manaAdded', player, pool: clonePool(s.players[player].manaPool) });
  }

  private doPass(player: PlayerId): void {
    const s = this.state;
    if (!s.passed.includes(player)) s.passed = [...s.passed, player];
    // Priority moves across. advance() notices when both have passed and either
    // resolves the top of the stack or moves the step on.
    s.priorityPlayer = otherPlayer(player);
  }

  /** CR 117.3b — after something resolves or triggers go on the stack. */
  private resetPriority(): void {
    const s = this.state;
    s.priorityPlayer = s.activePlayer;
    s.passed = [];
  }

  /** CR 117.3c — after a player puts a spell or ability on the stack. */
  private retainPriority(player: PlayerId): void {
    const s = this.state;
    s.priorityPlayer = player;
    s.passed = [];
  }

  // -------------------------------------------------------------------------
  // Shared primitives used by scripts
  // -------------------------------------------------------------------------

  private request(r: ChoiceRequestDraft): ChoiceRequest {
    return { ...r, id: this.nextChoiceId() } as ChoiceRequest;
  }

  private *chooseModeInternal(opts: {
    player: PlayerId;
    modes: { index: number; text: string; enabled: boolean }[];
    min: number;
    max: number;
    prompt: string;
  }): Eff<number[]> {
    const enabled = opts.modes.filter((m) => m.enabled);
    // One legal mode and no choice about how many: never ask (DESIGN.md 12.1).
    if (enabled.length <= opts.min) return enabled.slice(0, opts.max).map((m) => m.index);
    const res = (yield this.request({
      kind: 'chooseMode',
      player: opts.player,
      modes: opts.modes,
      min: opts.min,
      max: Math.min(opts.max, enabled.length),
      prompt: opts.prompt,
    })) as ChoiceResponse;
    return res.kind === 'modes' ? res.modes : [];
  }

  private *chooseCardsInternal(opts: ChooseCardsOpts): Eff<IID[]> {
    const res = yield* this.chooseCardsOrDeferInternal(opts);
    return res.iids;
  }

  private *chooseCardsOrDeferInternal(
    opts: ChooseCardsOpts,
  ): Eff<{ iids: IID[]; deferred: boolean }> {
    if (opts.cards.length === 0 && opts.min === 0) return { iids: [], deferred: false };
    const disabledMap = new Map((opts.disabled ?? []).map((d) => [d.iid, d.reason]));
    const options = opts.cards.map((iid) => ({
      iid,
      disabledReason: disabledMap.get(iid),
    }));
    const selectable = options.filter((o) => !o.disabledReason).length;
    if (selectable === 0 && opts.min === 0) return { iids: [], deferred: false };
    const res = (yield this.request({
      kind: 'chooseCards',
      player: opts.player,
      options,
      min: Math.min(opts.min, selectable),
      max: Math.min(opts.max, selectable),
      ordered: Boolean(opts.ordered),
      prompt: opts.prompt,
      from: opts.from,
      publicReveal: opts.publicReveal,
      deferrable: opts.deferrable,
      source: opts.source,
    })) as ChoiceResponse;
    if (res.kind !== 'cards') return { iids: [], deferred: false };
    // A postponement is only honoured where the caller offered one; otherwise it
    // would strand a question nobody is going to ask again.
    return { iids: res.iids, deferred: Boolean(res.deferred) && Boolean(opts.deferrable) };
  }

  /**
   * Choose targets for a list of target definitions.
   * Returns null when a required target has no legal candidates, which tells the
   * caller the spell or ability cannot be put on the stack.
   */
  private *chooseTargetsForDefs(
    defs: TargetDef[],
    player: PlayerId,
    self: CardInstance,
    sourceIid: IID,
  ): Eff<TargetRef[] | null> {
    const s = this.state;
    const out: TargetRef[] = [];
    for (const def of defs) {
      const candidates = def
        .candidates(s, player, self)
        .filter((t) => this.isLegalTarget(t, sourceIid, player));
      if (candidates.length === 0) {
        if (def.optional) continue;
        return null;
      }
      // "Any number of target …" — the ceiling is however many there are, and
      // choosing none is allowed, so it is always a question.
      const any = def.count === 'any';
      const count = any ? candidates.length : typeof def.count === 'number' ? def.count : 1;
      if (!any && candidates.length === count && !def.optional) {
        // Exactly as many legal choices as the card needs — never ask.
        // DESIGN.md 12.1.
        out.push(...candidates);
        continue;
      }
      const res = (yield this.request({
        kind: 'chooseTargets',
        player,
        candidates,
        count,
        optional: any || Boolean(def.optional),
        prompt: def.prompt,
        source: { iid: sourceIid, oracleId: s.cards[sourceIid]?.oracleId ?? self.oracleId },
      })) as ChoiceResponse;
      if (res.kind === 'targets') out.push(...res.targets);
    }
    return out;
  }

  isLegalTarget(ref: TargetRef, sourceIid: IID | null, controller: PlayerId): boolean {
    const s = this.state;
    if (!targetExists(s, ref)) return false;
    if (isProtectedFrom(s, ref, sourceIid, controller)) return false;
    return true;
  }

  // -------------------------------------------------------------------------
  // Mutations that scripts call
  // -------------------------------------------------------------------------

  draw(player: PlayerId, n = 1): void {
    const s = this.state;
    for (let i = 0; i < n; i++) {
      /*
       * Narset, Parter of Veils: "each opponent can't draw more than one card
       * each turn." A prevented draw is not a draw — the library is not touched,
       * nothing triggers, and an empty library does not matter (CR 614.11).
       */
      const narsetHolds = ['p1', 'p2'].some(
        (p) =>
          p !== player &&
          battlefield(s, p as PlayerId).some(
            (c) => c.oracleId === 'narset_parter_of_veils' && !c.faceDown,
          ),
      );
      if (narsetHolds && s.players[player].drawsThisTurn >= 1) {
        logLine(s, `draw prevented (Narset, Parter of Veils)`, { player });
        continue;
      }

      const lib = s.zones[player].library;
      const inOwnDrawStep = s.step === 'draw' && s.activePlayer === player;
      const first = inOwnDrawStep && s.players[player].drawsThisDrawStep === 0;
      if (inOwnDrawStep) s.players[player].drawsThisDrawStep++;
      s.players[player].drawsThisTurn++;

      if (lib.length === 0) {
        s.players[player].triedToDrawFromEmpty = true;
        this.emit([{ t: 'draw', player, iid: null, firstOfDrawStep: first }]);
        continue;
      }
      const iid = lib[0];
      const events = moveCardRaw(s, iid, 'hand');
      // Emit the draw first so triggers see it in the right order.
      this.emit([{ t: 'draw', player, iid, firstOfDrawStep: first }, ...events]);
    }
  }

  changeLife(player: PlayerId, delta: number): void {
    const s = this.state;
    if (delta === 0) return;
    s.players[player].life += delta;
    this.sbaDirty = true;
    this.events.push({
      t: 'lifeChange',
      player,
      delta,
      total: s.players[player].life,
    });
  }

  dealDamage(opts: DamageOpts): void {
    const s = this.state;
    if (opts.amount <= 0) return;
    if (opts.target.kind === 'player') {
      this.changeLife(opts.target.id, -opts.amount);
    } else if (opts.target.kind === 'permanent') {
      const c = s.cards[opts.target.iid];
      if (!c || c.zone !== 'battlefield') return;
      if (isType(c, 'Planeswalker')) {
        // CR 120.3c — damage to a planeswalker removes that many loyalty counters.
        c.counters['loyalty'] = Math.max(0, (c.counters['loyalty'] ?? 0) - opts.amount);
      } else {
        c.damage += opts.amount;
        if (opts.deathtouch) c.deathtouched = true;
      }
      this.sbaDirty = true;
    }
    this.events.push({
      t: 'damage',
      sourceIid: opts.sourceIid,
      target: opts.target,
      amount: opts.amount,
      deathtouch: Boolean(opts.deathtouch),
      combat: Boolean(opts.combat),
    });
    logLine(
      s,
      `${opts.sourceIid && s.cards[opts.sourceIid] ? cardName(s.cards[opts.sourceIid]) : 'Combat'} deals ${
        opts.amount
      } damage to ${targetLabel(s, opts.target)}`,
      { iids: opts.sourceIid ? [opts.sourceIid] : [] },
    );
    if (opts.lifelink && opts.lifelinkTo) {
      this.changeLife(opts.lifelinkTo, opts.amount);
    }
  }

  // -------------------------------------------------------------------------
  // Mana helpers
  // -------------------------------------------------------------------------

  manaSources(player: PlayerId, excludeIid?: IID): ManaSource[] {
    return untappedManaSources(this.state, player, excludeIid);
  }

  private executePayment(
    player: PlayerId,
    plan: {
      fromPool: import('./types.js').ManaPool;
      taps: { iid: IID; produce: ManaKind }[];
      life?: number;
    },
    _symbols: CostSymbol[],
  ): void {
    const s = this.state;
    const pool = s.players[player].manaPool;
    // A Phyrexian symbol paid with life. This is a cost, not damage — nothing
    // replaces or prevents it — and it can legally take a player to zero, where
    // the next state-based check ends the game.
    if (plan.life) this.changeLife(player, -plan.life);
    for (const tap of plan.taps) {
      const c = s.cards[tap.iid];
      if (!c) continue;
      c.tapped = true;
      pool[tap.produce]++;
      this.events.push({ t: 'tapped', iid: tap.iid });
    }
    for (const k of MANA_KINDS) {
      const fromTaps = plan.taps.filter((t) => t.produce === k).length;
      pool[k] -= plan.fromPool[k] + fromTaps;
      if (pool[k] < 0) pool[k] = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Context handed to card scripts
  // -------------------------------------------------------------------------

  makeCtx(
    self: CardInstance,
    controller: PlayerId,
    targets: TargetRef[],
    chosenModes: number[],
    context: Record<string, unknown>,
  ): Ctx {
    const game = this;
    const s = this.state;
    // Every prompt raised by a card carries that card's identity, which is what
    // lets the client auto-answer repetitive triggers (DESIGN.md 12.7).
    const source = { iid: self.abilitySource ?? self.iid, oracleId: self.oracleId };
    const req = (r: ChoiceRequestDraft): ChoiceRequest =>
      game.request({ ...r, source } as ChoiceRequestDraft);
    return {
      state: s,
      self,
      controller,
      opponent: otherPlayer(controller),
      targets,
      chosenModes,
      context,

      hand: (p) => cardsIn(s, p, 'hand'),
      library: (p) => cardsIn(s, p, 'library'),
      graveyard: (p) => cardsIn(s, p, 'graveyard'),
      exile: (p) => cardsIn(s, p, 'exile'),
      battlefieldOf: (p) => battlefield(s, p),
      card: (iid) => s.cards[iid],

      draw: (p, n = 1) => game.draw(p, n),
      gainLife: (p, n) => game.changeLife(p, n),
      loseLife: (p, n) => game.changeLife(p, -n),
      dealDamage: (o) => game.dealDamage(o),
      addCounters: (iid, kind, n) => {
        const c = s.cards[iid];
        if (!c) return;
        c.counters[kind] = (c.counters[kind] ?? 0) + n;
        game.sbaDirty = true;
        game.events.push({ t: 'counterAdded', iid, kind, n });
      },
      shuffleLibrary: (p) => {
        shuffleLibrary(s, p);
        game.events.push({ t: 'shuffle', player: p });
      },
      createToken: (p, spec) => {
        const iid = s.nextIid++;
        const tok = makeCard(iid, 'token', p, 'battlefield');
        tok.isToken = true;
        tok.token = spec;
        tok.controller = p;
        tok.summoningSick = true;
        s.cards[iid] = tok;
        s.zones[p].battlefield.push(iid);
        game.emit([
          { t: 'tokenCreated', iid, controller: p },
          { t: 'entersBattlefield', iid, controller: p },
        ]);
        return tok;
      },
      addEffect: (e) => {
        addEffectToState(s, e);
      },
      addManaToPool: (p, kind, n) => {
        s.players[p].manaPool[kind] += n;
        game.events.push({ t: 'manaAdded', player: p, pool: clonePool(s.players[p].manaPool) });
      },
      emit: (evs) => game.emit(evs),
      log: (text, iids) => logLine(s, text, { player: controller, iids }),
      counterSpell: (iid, o) => game.counterSpell(iid, self.iid, o),
      payOrDecline: function* (player, cost, prompt) {
        const symbols = parseCost(cost);
        const plan = solvePayment(
          symbols,
          s.players[player].manaPool,
          game.manaSources(player),
          s.players[player].life,
        );
        if (!plan) return false;
        const res = (yield game.request({
          kind: 'yesNo',
          player,
          prompt,
          yesLabel: `Pay ${cost}`,
          noLabel: 'Decline',
        })) as ChoiceResponse;
        if (res.kind !== 'yesNo' || !res.value) return false;
        // Re-solve: the question took time, and paying for something else in
        // response would otherwise be paid for twice.
        const now = solvePayment(
          symbols,
          s.players[player].manaPool,
          game.manaSources(player),
          s.players[player].life,
        );
        if (!now) return false;
        game.executePayment(player, now, symbols);
        return true;
      },
      addDelayedPayment: (p, cost) => {
        s.delayed.push({
          id: s.nextEffectId++,
          kind: 'pact',
          controller: p,
          cost,
          sourceIid: self.iid,
          armedOnTurn: s.turn,
        });
      },
      gainControlOfSpell: (iid, p) => game.gainControlOfSpell(iid, p),
      copySpell: (iid, controller, o) => game.copySpell(iid, controller, o),
      attachTo: (auraIid, hostIid) => {
        const aura = s.cards[auraIid];
        const host = s.cards[hostIid];
        if (!aura || !host) return;
        aura.attachedTo = hostIid;
        logLine(s, `${cardName(aura)} is attached to ${cardName(host)}`, {
          player: aura.controller,
          iids: [auraIid, hostIid],
        });
      },
      manifest: function* (player, iid) {
        // CR 701.34 — face down, as a 2/2 with no other characteristics. The
        // card keeps its identity on the instance; redact() is what hides it.
        const card = s.cards[iid];
        if (!card) return;
        card.faceDown = true;
        yield* game.putOntoBattlefield(iid, { controller: player });
        logLine(s, 'manifests a card face down', { player, iids: [iid] });
      },
      sacrifice: function* (iid) {
        const c = s.cards[iid];
        if (!c || c.zone !== 'battlefield') return;
        logLine(s, `sacrifices ${cardName(c)}`, { player: c.controller, iids: [iid] });
        game.emit(moveCardRaw(s, iid, 'graveyard'));
        yield* noChoices();
      },
      mill: function* (player, n) {
        const top = s.zones[player].library.slice(0, n);
        if (top.length === 0) return;
        for (const iid of top) game.emit(moveCardRaw(s, iid, 'graveyard'));
        logLine(s, `mills ${top.length}`, { player });
        yield* noChoices();
      },
      sacrificeAtNextEndStep: (player, iid) => {
        s.delayed.push({
          id: s.nextEffectId++,
          kind: 'sacrifice',
          controller: player,
          iid,
          armedOnTurn: s.turn,
        });
      },
      chooseColour: function* (player, prompt) {
        const colours: ManaKind[] = ['W', 'U', 'B', 'R', 'G'];
        const res = (yield game.request({
          kind: 'chooseMode',
          player,
          modes: colours.map((c, i) => ({ index: i, text: `{${c}}`, enabled: true })),
          min: 1,
          max: 1,
          prompt,
        })) as ChoiceResponse;
        if (res.kind !== 'modes' || res.modes.length === 0) return null;
        return colours[res.modes[0]] ?? null;
      },
      setImprint: (auraIid, cardIid) => {
        const a = s.cards[auraIid];
        if (a) a.imprinted = cardIid;
      },
      setNamedChoice: (iid, choice) => {
        const c = s.cards[iid];
        if (c) c.namedChoice = choice;
      },
      transform: (iid) => {
        const c = s.cards[iid];
        if (!c || !oracle(c.oracleId).faces) return;
        c.face = c.face === 'front' ? 'back' : 'front';
        // The back face is a planeswalker: it needs its loyalty on the way over.
        const back = faceOf(c.oracleId, c.face);
        if (back.types.includes('Planeswalker') && back.loyalty) {
          const n = Number(back.loyalty);
          if (Number.isFinite(n)) c.counters['loyalty'] = n;
        }
        game.events.push({ t: 'transformed', iid });
      },
      untap: (iid) => {
        const c = s.cards[iid];
        if (!c || !c.tapped) return;
        c.tapped = false;
        game.events.push({ t: 'untapped', iid });
      },
      chooseName: function* (player, names, prompt) {
        if (names.length === 0) return null;
        const res = (yield game.request({
          kind: 'chooseMode',
          player,
          modes: names.map((n, i) => ({ index: i, text: n, enabled: true })),
          min: 1,
          max: 1,
          prompt,
        })) as ChoiceResponse;
        if (res.kind !== 'modes' || res.modes.length === 0) return null;
        return names[res.modes[0]] ?? null;
      },
      chooseNewTargetsFor: function* (iid, chooser) {
        const spell = s.cards[iid];
        if (!spell || spell.zone !== 'stack') return false;
        const defs = getScript(spell.oracleId)?.targets;
        if (!defs || defs.length === 0) return false;
        // Asked as the new controller, so "target spell you don't control" now
        // means the ones *they* don't control — a commandeered Mana Drain points
        // back the way it came.
        const chosen = yield* game.chooseTargetsForDefs(defs, chooser, spell, iid);
        if (chosen === null) return false;
        spell.targets = chosen;
        logLine(s, `${cardName(spell)} → ${chosen.map((t) => targetLabel(s, t)).join(', ')}`, {
          player: chooser,
          iids: [iid],
        });
        return true;
      },
      addDelayedMana: (p, amount) => {
        s.delayed.push({
          id: s.nextEffectId++,
          kind: 'manaDrain',
          controller: p,
          amount,
          armedOnTurn: s.turn,
        });
      },
      enterTapped: () => {
        game.enterTappedFlag = true;
      },

      moveTo: function* (iid, zone, opts) {
        if (zone === 'battlefield') {
          yield* game.putOntoBattlefield(iid);
          return;
        }
        game.emit(moveCardRaw(s, iid, zone, { position: opts?.position }));
      },
      moveToBattlefield: function* (iid, opts) {
        // Default to the resolving spell's controller, not the card's owner:
        // Reanimate is the whole reason this parameter exists.
        yield* game.putOntoBattlefield(iid, { controller, ...opts });
      },
      moveSimultaneouslyToBattlefield: function* (entries) {
        yield* game.enterSimultaneously(entries);
      },
      bottomInRandomOrder: (iids) => {
        const shuffled = [...iids];
        shuffleArray(s.rng, shuffled);
        for (const iid of shuffled) {
          game.emit(moveCardRaw(s, iid, 'library', { position: 'bottom' }));
        }
      },

      chooseCards: (opts) => game.chooseCardsInternal({ ...opts, source }),
      chooseCardsOrDefer: (opts) => game.chooseCardsOrDeferInternal({ ...opts, source }),
      chooseTargets: function* (opts: ChooseTargetsOpts) {
        const res = (yield req({
          kind: 'chooseTargets',
          player: opts.player,
          candidates: opts.candidates,
          count: opts.count,
          optional: Boolean(opts.optional),
          prompt: opts.prompt,
        })) as ChoiceResponse;
        return res.kind === 'targets' ? res.targets : [];
      },
      chooseMode: function* (opts) {
        const enabled = opts.modes.filter((m) => m.enabled);
        if (enabled.length === 0) return [];
        const res = (yield req({
          kind: 'chooseMode',
          player: opts.player,
          modes: opts.modes,
          min: opts.min,
          max: Math.min(opts.max, enabled.length),
          prompt: opts.prompt,
        })) as ChoiceResponse;
        return res.kind === 'modes' ? res.modes : [];
      },
      yesNo: function* (player, prompt, labels) {
        const res = (yield req({
          kind: 'yesNo',
          player,
          prompt,
          yesLabel: labels?.yes,
          noLabel: labels?.no,
        })) as ChoiceResponse;
        return res.kind === 'yesNo' ? res.value : false;
      },
      searchZone: function* (opts: SearchOpts) {
        const cards = opts.cards.map((iid) => s.cards[iid]).filter(Boolean);
        const eligible = opts.filter ? cards.filter(opts.filter) : cards;
        if (eligible.length === 0) return null;
        const shown = opts.showIneligible ? cards : eligible;
        const disabled = opts.showIneligible
          ? cards.filter((c) => !eligible.includes(c)).map((c) => ({
              iid: c.iid,
              reason: 'Not a legal choice',
            }))
          : [];
        const picked = yield* game.chooseCardsInternal({
          player: opts.player,
          cards: shown.map((c) => c.iid),
          min: opts.optional === false ? 1 : 0,
          max: 1,
          prompt: opts.prompt,
          from: 'library',
          disabled,
        });
        return picked.length > 0 ? picked[0] : null;
      },
      surveil: function* (player, n) {
        const top = s.zones[player].library.slice(0, n);
        if (top.length === 0) return;
        const toGy = yield* game.chooseCardsInternal({
          player,
          cards: top,
          min: 0,
          max: top.length,
          prompt: `Surveil ${n} — choose any number to put into your graveyard`,
          from: 'library',
        });
        for (const iid of toGy) game.emit(moveCardRaw(s, iid, 'graveyard'));
        /*
         * The decision is public even though the card is not: the graveyard is
         * open information, so "binned one" or "kept it on top" is something the
         * opponent is entitled to - and was reading off nothing. The rule for
         * every hidden choice in this engine: say THAT you chose, never WHAT.
         */
        logLine(
          s,
          toGy.length === 0
            ? `surveils ${top.length}: keeps ${top.length === 1 ? 'it' : 'them'} on top`
            : `surveils ${top.length}: ${toGy.length} to the graveyard, ${top.length - toGy.length} kept on top`,
          { player },
        );
      },
      amass: function* (player, subtype, n) {
        // CR 701.44 — add counters to an Army you control, creating one first if needed.
        let army = battlefield(s, player).find((c) => c.token?.subtypes.includes('Army'));
        if (!army) {
          const iid = s.nextIid++;
          const tok = makeCard(iid, 'army_token', player, 'battlefield');
          tok.isToken = true;
          tok.token = {
            name: `${subtype} Army`,
            types: ['Creature'],
            subtypes: [subtype, 'Army'],
            colors: ['B'],
            power: 0,
            toughness: 0,
          };
          tok.controller = player;
          tok.summoningSick = true;
          s.cards[iid] = tok;
          s.zones[player].battlefield.push(iid);
          army = tok;
          game.emit([
            { t: 'tokenCreated', iid, controller: player },
            { t: 'entersBattlefield', iid, controller: player },
          ]);
        } else if (army.token && !army.token.subtypes.includes(subtype)) {
          army.token.subtypes = [subtype, ...army.token.subtypes];
          army.token.name = `${subtype} Army`;
        }
        army.counters['+1/+1'] = (army.counters['+1/+1'] ?? 0) + n;
        game.sbaDirty = true;
        game.events.push({ t: 'counterAdded', iid: army.iid, kind: '+1/+1', n });
        logLine(s, `amasses ${subtype} ${n}`, { player, iids: [army.iid] });
        // Never actually yields, but must be a generator to compose with yield*.
        if (false as boolean) yield null as never;
      },

      simultaneousSecret: function* (opts) {
        const requests: Record<PlayerId, { options: { iid: IID; disabledReason?: string }[]; prompt: string }> = {
          p1: { options: opts.optionsFor('p1'), prompt: opts.promptFor('p1') },
          p2: { options: opts.optionsFor('p2'), prompt: opts.promptFor('p2') },
        };
        s.secretResponses = {};
        yield req({
          kind: 'simultaneousSecret',
          player: null,
          awaiting: ['p1', 'p2'],
          requests,
          lockedIn: [],
          prompt: opts.prompt,
        });
        const picks: Record<PlayerId, IID | null> = {
          p1: s.secretResponses.p1 ?? null,
          p2: s.secretResponses.p2 ?? null,
        };
        s.secretResponses = {};
        return picks;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

/** Card name that tolerates an object that has already ceased to exist. */
function nameOf(s: GameState, iid: IID): string {
  const c = s.cards[iid];
  return c ? cardName(c) : '(gone)';
}

function removeFromStack(s: GameState, iid: IID): void {
  const i = s.stack.indexOf(iid);
  if (i >= 0) s.stack.splice(i, 1);
}

/** Structural comparison that ignores optional flags the client may omit. */
function sameIntent(a: Intent, b: Intent): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'playLand':
      return (
        b.t === 'playLand' &&
        a.iid === b.iid &&
        (a.face ?? 'front') === (b.face ?? 'front') &&
        (a.from ?? 'hand') === (b.from ?? 'hand')
      );
    case 'castSpell':
      return (
        b.t === 'castSpell' &&
        a.iid === b.iid &&
        Boolean(a.free) === Boolean(b.free) &&
        // The same card is on offer several ways — free, alternative cost,
        // kicked, from the graveyard. They are different actions.
        Boolean(a.alt) === Boolean(b.alt) &&
        Boolean(a.kicked) === Boolean(b.kicked) &&
        (a.from ?? 'hand') === (b.from ?? 'hand')
      );
    case 'turnFaceUp':
      return b.t === 'turnFaceUp' && a.iid === b.iid;
    case 'activateAbility':
      return b.t === 'activateAbility' && a.iid === b.iid && a.index === b.index;
    case 'tapForMana':
      return b.t === 'tapForMana' && a.iid === b.iid && a.kind === b.kind;
    default:
      return true;
  }
}

function sameTarget(a: TargetRef, b: TargetRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'player' && b.kind === 'player') return a.id === b.id;
  return (a as { iid: IID }).iid === (b as { iid: IID }).iid;
}

/** Mistrise Village should not be auto-tapped while its ability is still available. */
function hasUnusedShieldConsumed(s: GameState, player: PlayerId): boolean {
  return s.effects.some(
    (e) => e.kind === 'cantBeCountered' && e.scope === 'nextSpell' && e.controller === player,
  );
}

/**
 * What this permanent can add to a pool right now.
 *
 * `state` is required, and that is the whole point. It used to be optional, and
 * two of the three callers left it out — including the one that pays for a
 * spell. Chrome Mox looks up its imprinted card in the state, so without it the
 * Mox produced nothing: the game *offered* "Cast Narset", took the intent, found
 * it could not pay after all, and put the card back with no message and no mana
 * spent. The AI re-cast it forever and a drafted game hung on turn seven; a
 * human would have clicked a card that simply refused to do anything.
 */
export function producedManaOf(card: CardInstance, state: GameState): ManaKind[] {
  if (card.isToken) return [];
  /*
   * Chrome Mox: "add one mana of any of the exiled card's colors". With nothing
   * imprinted that is no colours at all, which is why the automatic derivation
   * refuses to guess and the card carries a real mana ability instead.
   */
  const imprintAbility = getScript(card.oracleId)?.abilities?.find(
    (a) => a.kind === 'mana' && a.fromImprint,
  );
  if (imprintAbility) {
    if (card.imprinted === undefined) return [];
    const exiled = state.cards[card.imprinted];
    if (!exiled) return [];
    return frontFace(exiled.oracleId).colors as ManaKind[];
  }
  /*
   * A mana creature cannot tap the turn it lands. CR 302.6 — an ability with {T}
   * in its cost needs the permanent to have been under your control since your
   * last turn began, and nothing about it being a mana ability changes that.
   *
   * The pool had no mana creature in it until Birds of Paradise, so every source
   * was a land and this never came up. It comes up now, and it is the difference
   * between a turn-one Birds and a turn-one Birds that already made mana.
   */
  if (card.summoningSick && currentFace(card).types.includes('Creature')) return [];
  const face = currentFace(card);
  return face.producedMana as ManaKind[];
}

/** Instant, or anything with Flash, can be cast at instant speed. */
export function spellTiming(oracleId: string): 'instant' | 'sorcery' {
  const script = getScript(oracleId);
  if (script?.timing) return script.timing;
  const f = frontFace(oracleId);
  if (f.types.includes('Instant')) return 'instant';
  if (f.keywords.includes('Flash')) return 'instant';
  return 'sorcery';
}

/**
 * Everything the player could legally do right now.
 * Used by the engine for safe auto-passing and by the client to light up cards.
 */
export function enumerateLegalActions(state: GameState, player: PlayerId): LegalAction[] {
  const out: LegalAction[] = [];
  if (state.winner !== null) return out;
  if (state.priorityPlayer !== player) return out;
  if (state.mode !== 'playing') return out;
  /*
   * Split second (CR 702.61): while such a spell is on the stack nobody may
   * cast a spell or activate a non-mana ability. Enumerating nothing but the
   * mana abilities is exactly that rule, and it is why Krosan Grip is Krosan
   * Grip rather than a slightly worse Naturalize.
   */
  const splitSecond = state.stack.some((iid) => {
    const c = state.cards[iid];
    return c && !c.isAbility && getScript(c.oracleId)?.splitSecond;
  });

  const ps = state.players[player];
  const sorceryTiming =
    state.activePlayer === player && isMainPhase(state) && state.stack.length === 0;

  // Land drops.
  if (sorceryTiming && ps.landDropsUsed < ps.landDropsAllowed) {
    for (const c of cardsIn(state, player, 'hand')) {
      // A card the engine cannot play yet is not offered at all - a Cavern of
      // Souls that hits the battlefield and taps for nothing is worse than one
      // the hand honestly refuses. See unimplementedReason.
      if (unimplementedReason(c.oracleId)) continue;
      const card = oracle(c.oracleId);
      if (frontFace(c.oracleId).types.includes('Land')) {
        out.push({ intent: { t: 'playLand', iid: c.iid }, label: `Play ${cardName(c)}` });
      }
      // A modal DFC can be played as its land back face.
      if (card.faces && card.faces[1].types.includes('Land')) {
        out.push({
          intent: { t: 'playLand', iid: c.iid, face: 'back' },
          label: `Play ${card.faces[1].name}`,
        });
      }
    }
    /*
     * Lands playable from somewhere other than the hand — Glacierwood Siege on
     * its Sultai half. Still one land drop, which is why this sits inside the
     * same land-drop gate rather than beside it.
     */
    for (const e of state.effects) {
      if (e.kind !== 'castFromElsewhere' || e.controller !== player || e.mode !== 'play') continue;
      for (const iid of e.iids) {
        const c = state.cards[iid];
        if (!c || c.zone !== e.zone) continue;
        if (!frontFace(c.oracleId).types.includes('Land')) continue;
        if (unimplementedReason(c.oracleId)) continue;
        out.push({
          intent: { t: 'playLand', iid, from: e.zone },
          label: `Play ${cardName(c)} (from your ${e.zone})`,
        });
      }
    }
  }

  // Casting.
  const omniscience = battlefield(state, player).some(
    (c) => c.oracleId === 'omniscience' && c.zone === 'battlefield',
  );
  const flashAll = canCastAsThoughFlash(state, player);
  const sources = untappedManaSources(state, player);

  const castables: {
    card: CardInstance;
    from: 'hand' | 'graveyard' | 'exile' | 'library';
    extra?: string;
  }[] =
    splitSecond ? [] : cardsIn(state, player, 'hand').map((card) => ({ card, from: 'hand' as const }));

  /*
   * Cards castable from another zone: Snapcaster's flashback grant, Lier's
   * blanket one, Expressive Iteration's exiled card. Flashback and "you may
   * play it this turn" differ in what happens afterwards, not in what is
   * offered — see the flashback flag on the intent.
   */
  if (!splitSecond) {
    // Permissions that come from a permanent being on the battlefield right now,
    // rather than from a resolved effect. They stop the moment it leaves.
    for (const c of battlefield(state, player)) {
      if (c.faceDown) continue;
      const rules = getScript(c.oracleId)?.staticRules;
      if (!rules) continue;
      for (const iid of rules.graveyardFlashbackFor?.(state, c) ?? []) {
        const card = state.cards[iid];
        if (card && card.zone === 'graveyard') {
          castables.push({ card, from: 'graveyard', extra: 'flashback' });
        }
      }
      for (const iid of rules.playFromGraveyard?.(state, c) ?? []) {
        const card = state.cards[iid];
        if (!card || card.zone !== 'graveyard') continue;
        if (!frontFace(card.oracleId).types.includes('Land')) continue;
        if (sorceryTiming && ps.landDropsUsed < ps.landDropsAllowed) {
          out.push({
            intent: { t: 'playLand', iid, from: 'graveyard' },
            label: `Play ${cardName(card)} (from your graveyard)`,
          });
        }
      }
      for (const iid of rules.playFromLibraryTop?.(state, c) ?? []) {
        const card = state.cards[iid];
        if (!card || card.zone !== 'library') continue;
        if (frontFace(card.oracleId).types.includes('Land')) {
          if (sorceryTiming && ps.landDropsUsed < ps.landDropsAllowed) {
            out.push({
              intent: { t: 'playLand', iid, from: 'library' },
              label: `Play ${cardName(card)} (off the top)`,
            });
          }
        } else {
          castables.push({ card, from: 'library', extra: 'off the top' });
        }
      }
    }
    for (const e of state.effects) {
      if (e.kind !== 'castFromElsewhere' || e.controller !== player) continue;
      for (const iid of e.iids) {
        const card = state.cards[iid];
        if (!card || card.zone !== e.zone) continue;
        if (frontFace(card.oracleId).types.includes('Land')) continue;
        castables.push({
          card,
          from: e.zone,
          extra:
            e.mode === 'flashback'
              ? 'flashback'
              : e.mode === 'free'
                ? 'free'
                : `from your ${e.zone}`,
        });
      }
    }
  }

  for (const { card: c, from, extra } of castables) {
    const face = frontFace(c.oracleId);
    // Lands are not spells — Omniscience cannot "cast" them and Borne Upon a Wind
    // does not let you play them at instant speed.
    if (face.types.includes('Land')) continue;
    /*
     * A spell with no script resolves into nothing: resolveSpell runs the script
     * if there is one and shrugs if there is not. Offering it anyway is how a
     * playtest lost a Thoughtseize and two mana to a card that silently did
     * nothing - so an unimplemented card is simply not castable, the same way an
     * unaffordable one is not.
     */
    if (unimplementedReason(c.oracleId)) continue;

    const timing = spellTiming(c.oracleId);
    const timingOk = timing === 'instant' || flashAll || sorceryTiming;
    if (!timingOk) continue;

    const script = getScript(c.oracleId);
    if (script?.canCast && !script.canCast(state, player, c)) continue;
    // An aura's "enchant" line is its target: no legal host, no legal cast.
    if (script?.enchant && script.enchant.candidates(state, player).length === 0) continue;
    /*
     * Targets are checked once per way of casting, not once per card.
     *
     * Bloodchief's Thirst is the reason: unkicked it reaches mana value 2 or
     * less, kicked it reaches anything — and asking the question with `kicked`
     * unset made a kicked Thirst pointed at a seven-drop look illegal, so the
     * card vanished from the hand entirely. The kicker changes what is legal,
     * so the check has to know which cast it is judging.
     */
    const targetsOkFor = (kicked: boolean): boolean =>
      !script?.targets ||
      hasAllRequiredTargets(state, script.targets, player, { ...c, kicked: kicked || undefined }, true);
    const plainTargetsOk = targetsOkFor(false);
    const kickedTargetsOk = script?.kicker ? targetsOkFor(true) : false;
    if (!plainTargetsOk && !kickedTargetsOk) continue;
    /*
     * A modal spell is castable when at least one mode is: Pyroblast with
     * nothing on the stack can still destroy a permanent, and offering it only
     * when every mode works would make it uncastable most of the time.
     */
    if (script?.modes) {
      const anyMode = script.modes.options.some((m) => modeUsable(state, player, c, m, true));
      if (!anyMode) continue;
    }

    // A player told they cast nothing this turn casts nothing (Orim's Chant).
    if (state.effects.some((e) => e.kind === 'cantCastSpells' && e.player === player)) continue;
    // Ashiok's Erasure: the name itself is banned while the enchantment is out.
    if (
      state.effects.some(
        (e) => e.kind === 'cantCastName' && e.players.includes(player) && e.name === face.name,
      )
    ) {
      continue;
    }

    const suffix = extra ? ` (${extra})` : '';
    const flashback = extra === 'flashback';
    const base = { iid: c.iid, ...(from === 'hand' ? {} : { from }), ...(flashback ? { flashback: true } : {}) };

    if (omniscience && from === 'hand') {
      if (plainTargetsOk) {
        out.push({ intent: { t: 'castSpell', ...base, free: true }, label: `Cast ${cardName(c)} (free)` });
      }
      if (script?.kicker && kickedTargetsOk) {
        const kick = parseCost(script.kicker.cost);
        if (canPay(kick, ps.manaPool, sources, ps.life)) {
          out.push({
            intent: { t: 'castSpell', ...base, free: true, kicked: true },
            label: `Cast ${cardName(c)} (free, ${script.kicker.label})`,
          });
        }
      }
    }

    /*
     * The alternative cost is offered alongside the mana cost, never instead of it.
     *
     * This is the whole point of the card: a Commandeer is castable for {5}{U}{U}
     * with seven lands out *and* for two blue cards out of hand, and which one is
     * right depends on what else you were planning to do with either. Offering only
     * one of them would be making that decision for the player.
     */
    if (from === 'hand' && script?.altCost?.available(state, player, c)) {
      out.push({
        intent: { t: 'castSpell', iid: c.iid, alt: true },
        label: `Cast ${cardName(c)} (${script.altCost.label})`,
      });
    }

    // Non-mana additional costs gate the offer: Bitter Triumph with an empty
    // hand and two life is a card you cannot cast, not one you cast for free.
    if (script?.additionalCost && !script.additionalCost.canPay(state, player)) continue;

    let symbols = parseCost(face.manaCost);
    if (script?.hasDelve) {
      const gy = state.zones[player].graveyard.length;
      symbols = reduceGeneric(symbols, Math.min(gy, genericPortion(symbols)));
    }
    if (script?.costReduction) symbols = reduceGeneric(symbols, script.costReduction(state, player, c));
    if (canPay(symbols, ps.manaPool, sources, ps.life)) {
      if (plainTargetsOk) {
        out.push({ intent: { t: 'castSpell', ...base }, label: `Cast ${cardName(c)}${suffix}` });
      }
      if (script?.kicker && kickedTargetsOk) {
        const kicked = [...symbols, ...parseCost(script.kicker.cost)];
        if (canPay(kicked, ps.manaPool, sources, ps.life)) {
          out.push({
            intent: { t: 'castSpell', ...base, kicked: true },
            label: `Cast ${cardName(c)} (${script.kicker.label})`,
          });
        }
      }
    }
  }

  // Escape: the card's own way back out of the graveyard.
  if (!splitSecond) {
    for (const c of cardsIn(state, player, 'graveyard')) {
      const script = getScript(c.oracleId);
      if (!script?.escape) continue;
      if (unimplementedReason(c.oracleId)) continue;
      const timing = spellTiming(c.oracleId);
      if (!(timing === 'instant' || flashAll || sorceryTiming)) continue;
      if (state.zones[player].graveyard.length - 1 < script.escape.exile) continue;
      if (!canPay(parseCost(script.escape.cost), ps.manaPool, sources, ps.life)) continue;
      out.push({
        intent: { t: 'castSpell', iid: c.iid, from: 'graveyard', escape: true },
        label: `Cast ${cardName(c)} (escape)`,
      });
    }
  }

  // Turning a manifested creature face up is a special action: no stack, any
  // time you have priority (CR 116.2g).
  for (const c of battlefield(state, player)) {
    if (!c.faceDown) continue;
    const real = frontFace(c.oracleId);
    if (!real.types.includes('Creature')) continue;
    if (!canPay(parseCost(real.manaCost), ps.manaPool, sources, ps.life)) continue;
    out.push({ intent: { t: 'turnFaceUp', iid: c.iid }, label: `Turn face up (${real.name})` });
  }

  // Activated abilities.
  for (const c of battlefield(state, player)) {
    const script = getScript(c.oracleId);
    if (!script?.abilities) continue;
    script.abilities.forEach((ab, index) => {
      if (ab.kind !== 'activated') return;
      if (splitSecond && !ab.isManaAbility) return;
      if (ab.timing === 'sorcery' && !sorceryTiming) return;
      if (ab.cost.loyalty !== undefined) {
        // CR 606.3 — sorcery timing, and one loyalty ability per walker per turn.
        if (!sorceryTiming) return;
        if (c.loyaltyActivatedTurn === state.turn) return;
        if ((c.counters['loyalty'] ?? 0) + ab.cost.loyalty < 0) return;
      }
      if (ab.cost.discard && state.zones[player].hand.length < ab.cost.discard) return;
      if (
        ab.cost.exileFromGraveyard &&
        state.zones[player].graveyard.length < ab.cost.exileFromGraveyard
      ) {
        return;
      }
      if (ab.canActivate && !ab.canActivate(state, c)) return;
      if (ab.cost.tap && c.tapped) return;
      if (ab.cost.life && ps.life <= 0) return;
      if (ab.cost.mana) {
        const symbols = parseCost(ab.cost.mana);
        const other = sources.filter((src) => !(ab.cost.tap && src.iid === c.iid));
        if (!canPay(symbols, ps.manaPool, other, ps.life)) return;
      }
      if (ab.targets && !hasAllRequiredTargets(state, ab.targets, player, c)) return;
      out.push({ intent: { t: 'activateAbility', iid: c.iid, index }, label: `${cardName(c)}: ${ab.text}` });
    });
  }

  // Tapping a land for mana on its own is only offered when there is something to
  // spend it on later in the step; the auto-tapper covers the normal case.
  for (const c of battlefield(state, player)) {
    if (c.tapped) continue;
    for (const kind of producedManaOf(c, state)) {
      out.push({
        intent: { t: 'tapForMana', iid: c.iid, kind },
        label: `Tap ${cardName(c)} for {${kind}}`,
        isManaAbility: true,
      });
    }
  }

  return out;
}

/**
 * Whether a mode can actually be chosen right now.
 *
 * Its own `enabled` line and its targets, asked as one question — because they
 * have to agree and once did not. Casting checked both, so Pyroblast was offered
 * whenever *either* mode worked; the mode prompt then checked only `enabled`, so
 * it offered "counter target spell" with an empty stack. Targeting found nothing,
 * the whole cast rewound to hand, and the AI simply cast it again: a real drafted
 * game hung on turn two, 12,000 decisions deep. A human would have watched the
 * card snap back with the mana unspent and no explanation.
 */
function modeUsable(
  state: GameState,
  player: PlayerId,
  self: CardInstance,
  m: { enabled?: (s: GameState, c: PlayerId, self: CardInstance) => boolean; targets?: TargetDef[] },
  asSpellOnStack = false,
): boolean {
  if (m.enabled && !m.enabled(state, player, self)) return false;
  return !m.targets || hasAllRequiredTargets(state, m.targets, player, self, asSpellOnStack);
}

function hasAllRequiredTargets(
  state: GameState,
  defs: TargetDef[],
  player: PlayerId,
  self: CardInstance,
  /**
   * Set while judging a *cast*, where the card has not moved yet but will have.
   *
   * CR 601.2c — targets are chosen with the spell already on the stack, so it has
   * left the zone it was cast from and cannot be a target there. Auroral
   * Procession returns a card from your graveyard, and Lier lets you cast it out
   * of your graveyard: counting itself made the cast look legal, and it rewound
   * the instant targeting found the graveyard empty. The game offered the cast,
   * accepted it, and did nothing — forever, in one drafted game out of 150.
   *
   * Only for casts. An activated ability is judged where its source already is,
   * and a permanent targeting itself is ordinary.
   */
  asSpellOnStack = false,
): boolean {
  for (const def of defs) {
    if (def.optional) continue;
    const candidates = def
      .candidates(state, player, self)
      .filter((t) => targetExists(state, t) && !isProtectedFrom(state, t, self.iid, player))
      // A spell may still be targeted as a spell — Narset's Reversal copying
      // itself is legal — so only the other zones drop it.
      .filter((t) => !asSpellOnStack || t.kind === 'spell' || !('iid' in t) || t.iid !== self.iid);
    if (candidates.length === 0) return false;
  }
  return true;
}

/** A generator that asks nothing — lets a non-interactive helper still be an Eff. */
function* noChoices(): Eff {
  // nothing
}

/**
 * Whether a permanent has a keyword right now.
 *
 * Three sources, and all three have to be live rather than snapshotted: what is
 * printed on it, what its own script grants conditionally (delirium's flying),
 * and what an effect gave it for the turn (Psychic Frog paying for flight).
 */
export function hasKeywordNow(state: GameState, card: CardInstance, kw: string): boolean {
  if (hasKeyword(card, kw)) return true;
  const granted = getScript(card.oracleId)?.grantsKeywords?.(state, card) ?? [];
  if (granted.includes(kw)) return true;
  return state.effects.some(
    (e) => e.kind === 'grantKeyword' && e.keyword === kw && e.iids.includes(card.iid),
  );
}

/** Whoever is stopping spells being countered right now (Lier). */
export function spellsUncounterableBy(state: GameState): CardInstance[] {
  return battlefield(state).filter(
    (c) => !c.faceDown && getScript(c.oracleId)?.staticRules?.spellsCantBeCountered,
  );
}

/**
 * The sources that could pay for something right now.
 *
 * Used both to decide what to offer and to pay for what was chosen — one
 * function, because when there were two they drifted: the offer counted an
 * imprinted Chrome Mox and the payment did not, so a castable spell was not
 * castable.
 */
export function untappedManaSources(
  state: GameState,
  player: PlayerId,
  excludeIid?: IID,
): ManaSource[] {
  const out: ManaSource[] = [];
  for (const c of battlefield(state, player)) {
    if (c.tapped || c.iid === excludeIid) continue;
    // producedManaOf already answers CR 302.6 — a summoning-sick mana creature
    // reports no mana at all, so nothing here needs to ask again.
    const produces = producedManaOf(c, state);
    if (produces.length === 0) continue;
    out.push({
      iid: c.iid,
      produces,
      // Keep Mistrise Village free while its uncounterable ability is unused.
      reserved: c.oracleId === 'mistrise_village' && !hasUnusedShieldConsumed(state, player),
    });
  }
  return out;
}

export { manaValueOfCard, cardName };
export type { ZoneName };
