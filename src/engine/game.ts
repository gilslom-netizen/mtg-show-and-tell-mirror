import { getScript } from './cards/index.js';
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
import { frontFace, oracle } from './oracle.js';
import { shuffleArray } from './rng.js';
import {
  battlefield,
  cardName,
  cardsIn,
  createGameState,
  currentFace,
  getPower,
  getToughness,
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
  | { t: 'playLand'; iid: IID; face?: 'front' | 'back' }
  | { t: 'castSpell'; iid: IID; free?: boolean; holdPriority?: boolean }
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

  private current: Eff | null = null;
  private choiceCounter = 0;
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
  }): Game {
    return new Game(createGameState(opts));
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
      if (s.pendingChoice) return;
      if (s.winner !== null) return;

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
      this.takeRollbackSnapshot(p);
      return;
    }
    throw new Error('advance() did not settle — possible infinite loop');
  }

  submitIntent(player: PlayerId, intent: Intent): void {
    const s = this.state;
    if (s.winner !== null) return;
    if (s.pendingChoice) throw new Error('A choice is pending');
    if (intent.t === 'concede') {
      this.playerLoses(player, 'concede');
      this.advance();
      return;
    }
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
        this.playLand(player, intent.iid, intent.face ?? 'front');
        break;
      case 'tapForMana':
        this.tapForMana(player, intent.iid, intent.kind);
        break;
      case 'castSpell':
        this.current = this.castSpell(player, intent.iid, {
          free: intent.free ?? false,
          holdPriority: intent.holdPriority ?? false,
        });
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
    return `c${++this.choiceCounter}`;
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
        const tou = getToughness(c);
        if (tou <= 0) dying.push(c);
        else if (c.deathtouched && c.damage > 0) dying.push(c);
        else if (c.damage >= tou) dying.push(c);
      }
      for (const c of dying) {
        logLine(s, `${cardName(c)} dies`, { player: c.controller, iids: [c.iid] });
        this.emit(moveCardRaw(s, c.iid, 'graveyard'));
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

  private playerLoses(p: PlayerId, reason: 'life' | 'deckOut' | 'concede'): void {
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
    opts: { free: boolean; holdPriority: boolean },
  ): Eff {
    const s = this.state;
    const card = s.cards[iid];
    if (!card || card.zone !== 'hand') return;

    const script = getScript(card.oracleId);
    const face = frontFace(card.oracleId);

    // Onto the stack first (CR 601.2a).
    card.face = 'front';
    this.emit(moveCardRaw(s, iid, 'stack', { controller: player }));
    card.controller = player;
    card.stackMv = face.mv;
    card.castForFree = opts.free;
    s.castingIid = iid;

    let symbols: CostSymbol[] = parseCost(face.manaCost);

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

    // Targets.
    if (script?.targets && script.targets.length > 0) {
      const chosen = yield* this.chooseTargetsForDefs(script.targets, player, card, iid);
      if (chosen === null) {
        // Should not happen — legality was checked before the intent was accepted.
        this.emit(moveCardRaw(s, iid, 'hand'));
        s.castingIid = null;
        return;
      }
      card.targets = chosen;
    }

    // Pay.
    if (!opts.free) {
      const plan = solvePayment(symbols, s.players[player].manaPool, this.manaSources(player));
      if (!plan) {
        this.emit(moveCardRaw(s, iid, 'hand'));
        s.castingIid = null;
        return;
      }
      this.executePayment(player, plan, symbols);
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
      `casts ${cardName(card)}${opts.free ? ' (free)' : ''}${
        card.targets?.length ? ` → ${card.targets.map((t) => targetLabel(s, t)).join(', ')}` : ''
      }`,
      { player, iids: [iid] },
    );
    this.emit([{ t: 'spellCast', iid, controller: player, free: opts.free }]);

    // CR 117.3c — the player who cast it receives priority again. Passing that
    // priority straight to the opponent is a client convenience (auto-pass), not
    // something the rules do, and burying it here made the engine behave
    // differently depending on whose turn it was.
    this.retainPriority(player);
  }

  private *activateAbility(player: PlayerId, iid: IID, index: number): Eff {
    const s = this.state;
    const source = s.cards[iid];
    if (!source) return;
    const script = getScript(source.oracleId);
    const ability = script?.abilities?.[index];
    if (!ability || ability.kind !== 'activated') return;

    // Pay costs first. Mana abilities and land activations do not use the stack.
    if (!this.payActivationCost(player, source, ability.cost)) return;

    if (ability.isManaAbility) {
      const ctx = this.makeCtx(source, player, [], [], {});
      yield* ability.resolve(ctx);
      return;
    }

    const objIid = s.nextIid++;
    const obj: CardInstance = {
      ...makeCard(objIid, source.oracleId, player, 'stack'),
      isAbility: true,
      abilitySource: iid,
      abilityIndex: index,
      abilityContext: {},
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
    if (cost.mana) {
      const symbols = parseCost(cost.mana);
      const plan = solvePayment(symbols, s.players[player].manaPool, this.manaSources(player, source.iid));
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
    if (isPermanentCard(spell)) {
      yield* this.putOntoBattlefield(spell.iid, { controller: spell.controller });
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
  counterSpell(spellIid: IID, byIid: IID | null): boolean {
    const s = this.state;
    const spell = s.cards[spellIid];
    if (!spell || spell.zone !== 'stack') return false;
    const script = getScript(spell.oracleId);
    if (spellCantBeCountered(s, spellIid, Boolean(script?.cantBeCountered))) {
      logLine(s, `${cardName(spell)} can't be countered`, {
        player: spell.controller,
        iids: [spellIid],
      });
      return false;
    }
    this.events.push({ t: 'spellCountered', iid: spellIid, by: byIid });
    logLine(s, `${cardName(spell)} is countered`, { player: spell.controller, iids: [spellIid] });
    this.emit(moveCardRaw(s, spellIid, 'graveyard'));
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
    this.events.push({
      t: 'stepChange',
      phase: s.phase,
      step: s.step,
      turn: s.turn,
      activePlayer: s.activePlayer,
    });

    switch (s.step) {
      case 'untap': {
        const ap = s.activePlayer;
        s.players[ap].landDropsUsed = 0;
        for (const p of ['p1', 'p2'] as PlayerId[]) {
          s.players[p].spellsCastThisTurn = [];
          s.players[p].spellsCastThisTurnCount = 0;
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
      case 'main': {
        this.fireDelayedTriggers();
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

    const nextIndex = s.stepIndex + 1;
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

  private fireDelayedTriggers(): void {
    const s = this.state;
    const ap = s.activePlayer;
    const ready = s.delayed.filter((d) => d.controller === ap);
    if (ready.length === 0) return;
    s.delayed = s.delayed.filter((d) => d.controller !== ap);
    for (const d of ready) {
      // Mana Drain: "add an amount of {C} equal to that spell's mana value".
      s.players[ap].manaPool.C += d.amount;
      this.events.push({ t: 'manaAdded', player: ap, pool: clonePool(s.players[ap].manaPool) });
      logLine(s, `Mana Drain adds ${d.amount} colorless mana`, { player: ap });
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
      if (!hasKeyword(c, 'Vigilance')) {
        c.tapped = true;
        this.events.push({ t: 'tapped', iid });
      }
    }
    logLine(s, `attacks with ${res.iids.map((i) => nameOf(s, i)).join(', ')}`, {
      player: ap,
      iids: res.iids,
    });
    this.emit([]);
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
      const power = getPower(atk);
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
          deathtouch: hasKeyword(atk, 'Deathtouch'),
          lifelink: hasKeyword(atk, 'Lifelink'),
          lifelinkTo: atk.controller,
        });
        continue;
      }

      // Assign in damage-assignment order; deathtouch makes 1 damage lethal.
      // Everything left over goes onto the last blocker rather than evaporating:
      // nothing here has trample, so that is always at least as good for the
      // attacker, and it is what lifelink actually pays out on.
      let remaining = power;
      const deathtouch = hasKeyword(atk, 'Deathtouch');
      for (let i = 0; i < blockers.length; i++) {
        if (remaining <= 0) break;
        const bIid = blockers[i];
        const b = s.cards[bIid];
        if (!b) continue;
        const isLast = i === blockers.length - 1;
        const lethal = deathtouch ? 1 : Math.max(1, getToughness(b) - b.damage);
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
      const power = getPower(b);
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
          const kept = s.zones[p].hand.length - s.players[p].mulligansTaken;
          logLine(s, `keeps ${kept}`, { player: p });
        } else {
          for (const iid of [...s.zones[p].hand]) moveCardRaw(s, iid, 'library');
          shuffleLibrary(s, p);
          this.events.push({ t: 'shuffle', player: p });
          s.players[p].mulligansTaken++;
          this.draw(p, 7);
          logLine(s, `mulligans to ${7 - s.players[p].mulligansTaken}`, { player: p });
        }
      }
    }

    // London mulligan: bottom N after keeping.
    for (const p of order) {
      const n = Math.min(s.players[p].mulligansTaken, s.zones[p].hand.length);
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
    }

    s.mode = 'playing';
    s.stepInitialized = false;
    // Clear the events the opening hands generated; nothing should animate here.
    this.events = this.events.filter((e) => e.t !== 'draw' && e.t !== 'zoneChange');
  }

  // -------------------------------------------------------------------------
  // Player actions that do not use the stack
  // -------------------------------------------------------------------------

  private playLand(player: PlayerId, iid: IID, face: 'front' | 'back'): void {
    const s = this.state;
    const card = s.cards[iid];
    if (!card || card.zone !== 'hand') return;
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
    if (!producedManaOf(card).includes(kind)) return;
    card.tapped = true;
    s.players[player].manaPool[kind]++;
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

  private *chooseCardsInternal(opts: ChooseCardsOpts): Eff<IID[]> {
    if (opts.cards.length === 0 && opts.min === 0) return [];
    const disabledMap = new Map((opts.disabled ?? []).map((d) => [d.iid, d.reason]));
    const options = opts.cards.map((iid) => ({
      iid,
      disabledReason: disabledMap.get(iid),
    }));
    const selectable = options.filter((o) => !o.disabledReason).length;
    if (selectable === 0 && opts.min === 0) return [];
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
      source: opts.source,
    })) as ChoiceResponse;
    return res.kind === 'cards' ? res.iids : [];
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
      if (candidates.length === 1 && !def.optional) {
        // Only one legal choice — never ask. DESIGN.md 12.1.
        out.push(candidates[0]);
        continue;
      }
      const res = (yield this.request({
        kind: 'chooseTargets',
        player,
        candidates,
        count: 1,
        optional: Boolean(def.optional),
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
      const lib = s.zones[player].library;
      const inOwnDrawStep = s.step === 'draw' && s.activePlayer === player;
      const first = inOwnDrawStep && s.players[player].drawsThisDrawStep === 0;
      if (inOwnDrawStep) s.players[player].drawsThisDrawStep++;

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
      c.damage += opts.amount;
      if (opts.deathtouch) c.deathtouched = true;
      this.sbaDirty = true;
    }
    this.events.push({
      t: 'damage',
      sourceIid: opts.sourceIid,
      target: opts.target,
      amount: opts.amount,
      deathtouch: Boolean(opts.deathtouch),
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
    const s = this.state;
    const out: ManaSource[] = [];
    for (const c of battlefield(s, player)) {
      if (c.tapped || c.iid === excludeIid) continue;
      const produces = producedManaOf(c);
      if (produces.length === 0) continue;
      out.push({
        iid: c.iid,
        produces,
        // Keep Mistrise Village free while its uncounterable ability is unused.
        reserved: c.oracleId === 'mistrise_village' && !hasUnusedShieldConsumed(s, player),
      });
    }
    return out;
  }

  private executePayment(
    player: PlayerId,
    plan: { fromPool: import('./types.js').ManaPool; taps: { iid: IID; produce: ManaKind }[] },
    _symbols: CostSymbol[],
  ): void {
    const s = this.state;
    const pool = s.players[player].manaPool;
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
      counterSpell: (iid) => game.counterSpell(iid, self.iid),
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
        yield* game.putOntoBattlefield(iid, opts);
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
        b.t === 'playLand' && a.iid === b.iid && (a.face ?? 'front') === (b.face ?? 'front')
      );
    case 'castSpell':
      return b.t === 'castSpell' && a.iid === b.iid && Boolean(a.free) === Boolean(b.free);
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

export function producedManaOf(card: CardInstance): ManaKind[] {
  if (card.isToken) return [];
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

  const ps = state.players[player];
  const sorceryTiming =
    state.activePlayer === player && isMainPhase(state) && state.stack.length === 0;

  // Land drops.
  if (sorceryTiming && ps.landDropsUsed < ps.landDropsAllowed) {
    for (const c of cardsIn(state, player, 'hand')) {
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
  }

  // Casting.
  const omniscience = battlefield(state, player).some(
    (c) => c.oracleId === 'omniscience' && c.zone === 'battlefield',
  );
  const flashAll = canCastAsThoughFlash(state, player);
  const sources = untappedManaSources(state, player);

  for (const c of cardsIn(state, player, 'hand')) {
    const face = frontFace(c.oracleId);
    // Lands are not spells — Omniscience cannot "cast" them and Borne Upon a Wind
    // does not let you play them at instant speed.
    if (face.types.includes('Land')) continue;

    const timing = spellTiming(c.oracleId);
    const timingOk = timing === 'instant' || flashAll || sorceryTiming;
    if (!timingOk) continue;

    const script = getScript(c.oracleId);
    if (script?.canCast && !script.canCast(state, player, c)) continue;
    if (script?.targets && !hasAllRequiredTargets(state, script.targets, player, c)) continue;

    if (omniscience) {
      out.push({ intent: { t: 'castSpell', iid: c.iid, free: true }, label: `Cast ${cardName(c)} (free)` });
    }
    let symbols = parseCost(face.manaCost);
    if (script?.hasDelve) {
      const gy = state.zones[player].graveyard.length;
      symbols = reduceGeneric(symbols, Math.min(gy, genericPortion(symbols)));
    }
    if (canPay(symbols, ps.manaPool, sources)) {
      out.push({ intent: { t: 'castSpell', iid: c.iid }, label: `Cast ${cardName(c)}` });
    }
  }

  // Activated abilities.
  for (const c of battlefield(state, player)) {
    const script = getScript(c.oracleId);
    if (!script?.abilities) continue;
    script.abilities.forEach((ab, index) => {
      if (ab.kind !== 'activated') return;
      if (ab.timing === 'sorcery' && !sorceryTiming) return;
      if (ab.canActivate && !ab.canActivate(state, c)) return;
      if (ab.cost.tap && c.tapped) return;
      if (ab.cost.life && ps.life <= 0) return;
      if (ab.cost.mana) {
        const symbols = parseCost(ab.cost.mana);
        const other = sources.filter((src) => !(ab.cost.tap && src.iid === c.iid));
        if (!canPay(symbols, ps.manaPool, other)) return;
      }
      if (ab.targets && !hasAllRequiredTargets(state, ab.targets, player, c)) return;
      out.push({ intent: { t: 'activateAbility', iid: c.iid, index }, label: `${cardName(c)}: ${ab.text}` });
    });
  }

  // Tapping a land for mana on its own is only offered when there is something to
  // spend it on later in the step; the auto-tapper covers the normal case.
  for (const c of battlefield(state, player)) {
    if (c.tapped) continue;
    for (const kind of producedManaOf(c)) {
      out.push({
        intent: { t: 'tapForMana', iid: c.iid, kind },
        label: `Tap ${cardName(c)} for {${kind}}`,
        isManaAbility: true,
      });
    }
  }

  return out;
}

function hasAllRequiredTargets(
  state: GameState,
  defs: TargetDef[],
  player: PlayerId,
  self: CardInstance,
): boolean {
  for (const def of defs) {
    if (def.optional) continue;
    const candidates = def
      .candidates(state, player, self)
      .filter((t) => targetExists(state, t) && !isProtectedFrom(state, t, self.iid, player));
    if (candidates.length === 0) return false;
  }
  return true;
}

export function untappedManaSources(state: GameState, player: PlayerId): ManaSource[] {
  const out: ManaSource[] = [];
  for (const c of battlefield(state, player)) {
    if (c.tapped) continue;
    const produces = producedManaOf(c);
    if (produces.length === 0) continue;
    out.push({ iid: c.iid, produces });
  }
  return out;
}

export { manaValueOfCard, cardName };
export type { ZoneName };
