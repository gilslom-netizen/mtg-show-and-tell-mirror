import { MAINDECK } from '../deck';
import { Game, type Intent } from '../game';
import { oracleByName } from '../oracle';
import { cardName, currentFace, moveCardRaw, stepAt } from '../state';
import { TURN_SEQUENCE, type ChoiceResponse, type GameEvent, type IID, type PlayerId, type Phase, type Step } from '../types';

/**
 * Test harness.
 *
 * Tests should read like a described board state, otherwise nobody writes them.
 * Every game starts deterministic (fixed seed, no shuffle) so a failure is always
 * reproducible.
 */

export class Seat {
  constructor(
    private t: TestGame,
    public readonly id: PlayerId,
  ) {}

  private take(names: string[]): IID[] {
    const s = this.t.game.state;
    const out: IID[] = [];
    for (const name of names) {
      const oracleId = oracleByName(name).oracleId;
      const iid = s.zones[this.id].library.find(
        (i) => s.cards[i].oracleId === oracleId && !out.includes(i),
      );
      if (iid === undefined) {
        throw new Error(`No ${name} left in ${this.id}'s library`);
      }
      out.push(iid);
    }
    return out;
  }

  /** Move these cards from library to hand. */
  hand(...names: string[]): IID[] {
    const iids = this.take(names);
    for (const iid of iids) moveCardRaw(this.t.game.state, iid, 'hand');
    return iids;
  }

  /** Put these onto the battlefield, untapped and ready to act. */
  battlefield(...names: string[]): IID[] {
    const iids = this.take(names);
    for (const iid of iids) {
      moveCardRaw(this.t.game.state, iid, 'battlefield', { controller: this.id });
      this.t.game.state.cards[iid].summoningSick = false;
    }
    return iids;
  }

  /** Put these onto the battlefield tapped. */
  battlefieldTapped(...names: string[]): IID[] {
    const iids = this.battlefield(...names);
    for (const iid of iids) this.t.game.state.cards[iid].tapped = true;
    return iids;
  }

  graveyard(...names: string[]): IID[] {
    const iids = this.take(names);
    for (const iid of iids) moveCardRaw(this.t.game.state, iid, 'graveyard');
    return iids;
  }

  /** Force the exact top of the library, in order. */
  libraryTop(...names: string[]): IID[] {
    const iids = this.take(names);
    for (let i = iids.length - 1; i >= 0; i--) {
      moveCardRaw(this.t.game.state, iids[i], 'library', { position: 'top' });
    }
    return iids;
  }

  /** Shrink the library to exactly n cards (exiling the rest out of the way). */
  librarySize(n: number): void {
    const s = this.t.game.state;
    while (s.zones[this.id].library.length > n) {
      const iid = s.zones[this.id].library[s.zones[this.id].library.length - 1];
      moveCardRaw(s, iid, 'exile');
    }
  }

  /**
   * Put n untapped blue-producing lands onto the battlefield.
   * Saves every test from spelling out a manabase.
   */
  manaBase(n: number): IID[] {
    // Ordered so that small manabases still cover B, G and W — several cards in
    // the deck need an off-colour pip off very few lands.
    const preferred = [
      'Watery Grave', // U/B
      'Breeding Pool', // U/G
      'Undercity Sewers', // U/B
      'Hedge Maze', // U/G
      'Hallowed Fountain', // U/W
      'Island', // U
      'Watery Grave',
      'Breeding Pool',
      'Mystic Sanctuary',
      'Mistrise Village',
    ];
    if (n > preferred.length) throw new Error(`Only ${preferred.length} blue sources exist`);
    return this.battlefield(...preferred.slice(0, n));
  }

  life(n: number): void {
    this.t.game.state.players[this.id].life = n;
  }

  handNames(): string[] {
    return this.t.game.state.zones[this.id].hand.map((i) =>
      cardName(this.t.game.state.cards[i]),
    );
  }

  battlefieldNames(): string[] {
    return this.t.game.state.zones[this.id].battlefield.map((i) =>
      this.t.game.state.cards[i].isToken
        ? this.t.game.state.cards[i].token!.name
        : cardName(this.t.game.state.cards[i]),
    );
  }

  graveyardNames(): string[] {
    return this.t.game.state.zones[this.id].graveyard.map((i) =>
      cardName(this.t.game.state.cards[i]),
    );
  }

  libraryNames(): string[] {
    return this.t.game.state.zones[this.id].library.map((i) =>
      cardName(this.t.game.state.cards[i]),
    );
  }

  handSize(): number {
    return this.t.game.state.zones[this.id].hand.length;
  }

  get lifeTotal(): number {
    return this.t.game.state.players[this.id].life;
  }

  /** Find a card by name in a zone this seat owns. */
  find(name: string, zone: 'hand' | 'battlefield' | 'graveyard' | 'library' = 'hand'): IID {
    const s = this.t.game.state;
    const oracleId = oracleByName(name).oracleId;
    const iid = s.zones[this.id][zone].find((i) => s.cards[i].oracleId === oracleId);
    if (iid === undefined) throw new Error(`${name} not found in ${this.id}'s ${zone}`);
    return iid;
  }

  // --- actions -------------------------------------------------------------

  cast(name: string, opts: { free?: boolean; hold?: boolean } = {}): void {
    this.t.intent(this.id, {
      t: 'castSpell',
      iid: this.find(name, 'hand'),
      free: opts.free,
      holdPriority: opts.hold,
    });
  }

  playLand(name: string, face: 'front' | 'back' = 'front'): void {
    this.t.intent(this.id, { t: 'playLand', iid: this.find(name, 'hand'), face });
  }

  activate(name: string, index = 0): void {
    this.t.intent(this.id, { t: 'activateAbility', iid: this.find(name, 'battlefield'), index });
  }

  pass(): void {
    this.t.intent(this.id, { t: 'passPriority' });
  }

  canCast(name: string): boolean {
    const iid = this.t.game.state.zones[this.id].hand.find(
      (i) => this.t.game.state.cards[i].oracleId === oracleByName(name).oracleId,
    );
    if (iid === undefined) return false;
    return this.t.game
      .legalActions(this.id)
      .some((a) => a.intent.t === 'castSpell' && a.intent.iid === iid);
  }
}

export class TestGame {
  game: Game;
  p1: Seat;
  p2: Seat;

  constructor(seed: number, startingPlayer: PlayerId) {
    this.game = Game.create({
      gameId: 'test',
      seed,
      deck: MAINDECK,
      startingPlayer,
      bare: true,
    });
    // Tests drive priority explicitly so that a board where nobody can act does
    // not silently run the whole game out.
    this.game.autoPass = false;
    this.p1 = new Seat(this, 'p1');
    this.p2 = new Seat(this, 'p2');
  }

  get state() {
    return this.game.state;
  }

  seat(p: PlayerId): Seat {
    return p === 'p1' ? this.p1 : this.p2;
  }

  /** Jump to a step with priority already assigned, skipping upkeep and draw. */
  begin(phase: Phase = 'precombat_main', step: Step = 'main'): this {
    const idx = TURN_SEQUENCE.findIndex((x) => x.phase === phase && x.step === step);
    if (idx < 0) throw new Error(`No such step ${phase}/${step}`);
    const s = this.game.state;
    s.stepIndex = idx;
    const at = stepAt(idx);
    s.phase = at.phase;
    s.step = at.step;
    // Let the step's turn-based actions run, so beginning a test in
    // declare_attackers actually asks for attackers.
    s.stepInitialized = false;
    s.priorityPlayer = null;
    s.passed = [];
    this.game.advance();
    return this;
  }

  intent(player: PlayerId, intent: Intent): void {
    this.game.submitIntent(player, intent);
  }

  // --- choices -------------------------------------------------------------

  choice() {
    return this.game.state.pendingChoice;
  }

  expectChoice() {
    const c = this.game.state.pendingChoice;
    if (!c) throw new Error('Expected a pending choice, but none is open');
    return c;
  }

  answer(response: ChoiceResponse, player?: PlayerId): void {
    const c = this.expectChoice();
    const p = player ?? (c.kind === 'simultaneousSecret' ? c.awaiting[0] : c.player);
    if (!p) throw new Error('Cannot infer which player should answer');
    this.game.submitChoice(p, c.id, response);
  }

  /** Answer a chooseCards prompt by card name(s). */
  chooseCards(...names: string[]): void {
    const c = this.expectChoice();
    if (c.kind !== 'chooseCards') throw new Error(`Expected chooseCards, got ${c.kind}`);
    const iids = names.map((n) => {
      const oracleId = oracleByName(n).oracleId;
      const found = c.options.find(
        (o) => this.game.state.cards[o.iid].oracleId === oracleId && !o.disabledReason,
      );
      if (!found) throw new Error(`${n} is not a selectable option here`);
      return found.iid;
    });
    this.answer({ kind: 'cards', iids });
  }

  chooseNoCards(): void {
    this.answer({ kind: 'cards', iids: [] });
  }

  yes(): void {
    this.answer({ kind: 'yesNo', value: true });
  }

  no(): void {
    this.answer({ kind: 'yesNo', value: false });
  }

  chooseMode(...modes: number[]): void {
    this.answer({ kind: 'modes', modes });
  }

  /** Answer a chooseTargets prompt with the player or the named permanent. */
  targetPlayer(p: PlayerId): void {
    this.answer({ kind: 'targets', targets: [{ kind: 'player', id: p }] });
  }

  targetIid(iid: IID): void {
    const c = this.expectChoice();
    if (c.kind !== 'chooseTargets') throw new Error(`Expected chooseTargets, got ${c.kind}`);
    const t = c.candidates.find((x) => x.kind !== 'player' && x.iid === iid);
    if (!t) throw new Error(`iid ${iid} is not a legal target here`);
    this.answer({ kind: 'targets', targets: [t] });
  }

  /** Lock in one side of a Show and Tell style secret choice. */
  secret(player: PlayerId, name: string | null): void {
    const c = this.expectChoice();
    if (c.kind !== 'simultaneousSecret') throw new Error(`Expected simultaneousSecret, got ${c.kind}`);
    let iid: IID | null = null;
    if (name !== null) {
      const oracleId = oracleByName(name).oracleId;
      const opt = c.requests[player].options.find(
        (o) => this.game.state.cards[o.iid].oracleId === oracleId,
      );
      if (!opt) throw new Error(`${name} is not in ${player}'s hand`);
      if (opt.disabledReason) throw new Error(`${name} is not a legal pick: ${opt.disabledReason}`);
      iid = opt.iid;
    }
    this.game.submitChoice(player, c.id, { kind: 'secret', iid });
  }

  /** Whether a card is offered but greyed out in the current secret choice. */
  secretDisabledReason(player: PlayerId, name: string): string | undefined {
    const c = this.expectChoice();
    if (c.kind !== 'simultaneousSecret') throw new Error('Not a secret choice');
    const oracleId = oracleByName(name).oracleId;
    const opt = c.requests[player].options.find(
      (o) => this.game.state.cards[o.iid].oracleId === oracleId,
    );
    return opt?.disabledReason;
  }

  /**
   * Answer every pending choice with a harmless default until none is open.
   * Used to skip past prompts a given test does not care about.
   */
  auto(limit = 60): void {
    let guard = 0;
    while (this.game.state.pendingChoice && guard++ < limit) {
      const c = this.game.state.pendingChoice;
      switch (c.kind) {
        case 'chooseCards': {
          const selectable = c.options.filter((o) => !o.disabledReason).map((o) => o.iid);
          this.answer({ kind: 'cards', iids: selectable.slice(0, c.min) }, c.player);
          break;
        }
        case 'chooseTargets':
          this.answer(
            { kind: 'targets', targets: c.optional ? [] : c.candidates.slice(0, c.count) },
            c.player,
          );
          break;
        case 'chooseMode':
          this.answer(
            {
              kind: 'modes',
              modes: c.min === 0 ? [] : c.modes.filter((m) => m.enabled).slice(0, c.min).map((m) => m.index),
            },
            c.player,
          );
          break;
        case 'yesNo':
          this.answer({ kind: 'yesNo', value: false }, c.player);
          break;
        case 'mulligan':
          this.answer({ kind: 'yesNo', value: true }, c.player);
          break;
        case 'orderTriggers':
          this.answer({ kind: 'order', ids: c.triggers.map((t) => t.id) }, c.player);
          break;
        case 'declareAttackers':
          this.answer({ kind: 'attackers', iids: [] }, c.player);
          break;
        case 'declareBlockers':
          this.answer({ kind: 'blockers', blocks: [] }, c.player);
          break;
        case 'distributeDamage': {
          const assignment: Record<IID, number> = {};
          assignment[c.blockers[0]] = c.total;
          this.answer({ kind: 'damage', assignment }, c.player);
          break;
        }
        case 'simultaneousSecret':
          for (const p of [...c.awaiting]) {
            this.game.submitChoice(p, c.id, { kind: 'secret', iid: null });
          }
          break;
      }
    }
  }

  /** Both players pass until the stack is empty or a choice interrupts. */
  resolveStack(limit = 200): void {
    let guard = 0;
    while (
      this.game.state.stack.length > 0 &&
      !this.game.state.pendingChoice &&
      this.game.state.winner === null &&
      guard++ < limit
    ) {
      const p = this.game.state.priorityPlayer;
      if (!p) break;
      this.game.submitIntent(p, { t: 'passPriority' });
    }
  }

  /** Resolve the stack, auto-answering any prompts along the way. */
  resolveAll(limit = 200): void {
    let guard = 0;
    while (
      (this.game.state.stack.length > 0 || this.game.state.pendingChoice) &&
      this.game.state.winner === null &&
      guard++ < limit
    ) {
      if (this.game.state.pendingChoice) this.auto();
      else this.resolveStack();
    }
  }

  /** Pass priority until a choice opens up, without answering anything. */
  passToChoice(limit = 60): void {
    let guard = 0;
    while (!this.game.state.pendingChoice && this.game.state.winner === null && guard++ < limit) {
      const p = this.game.state.priorityPlayer;
      if (!p) break;
      this.game.submitIntent(p, { t: 'passPriority' });
    }
  }

  /** Pass priority (auto-answering prompts) until a condition holds. */
  passUntilCondition(pred: () => boolean, limit = 600): void {
    let guard = 0;
    while (!pred() && this.game.state.winner === null && guard++ < limit) {
      if (this.game.state.pendingChoice) {
        this.auto();
        continue;
      }
      const p = this.game.state.priorityPlayer;
      if (!p) break;
      this.game.submitIntent(p, { t: 'passPriority' });
    }
  }

  /** Run until the given turn number begins. */
  advanceToTurn(turn: number, limit = 600): void {
    this.passUntilCondition(() => this.game.state.turn >= turn, limit);
  }

  /** Pass priority repeatedly until the given step is reached. */
  passUntil(step: Step, limit = 200): void {
    let guard = 0;
    while (this.game.state.step !== step && this.game.state.winner === null && guard++ < limit) {
      if (this.game.state.pendingChoice) {
        this.auto();
        continue;
      }
      const p = this.game.state.priorityPlayer;
      if (!p) break;
      this.game.submitIntent(p, { t: 'passPriority' });
    }
  }

  // --- assertions ----------------------------------------------------------

  events(): GameEvent[] {
    return this.game.events;
  }

  countEvents(t: GameEvent['t'], predicate?: (e: GameEvent) => boolean): number {
    return this.game.events.filter((e) => e.t === t && (!predicate || predicate(e))).length;
  }

  /** How many times a named card's triggered ability has fired so far. */
  countTriggers(cardNameOrId: string): number {
    const oracleId = oracleByName(cardNameOrId).oracleId;
    return this.game.events.filter(
      (e) => e.t === 'abilityTriggered' && this.game.state.cards[e.sourceIid]?.oracleId === oracleId,
    ).length;
  }

  /** Number of draw events for a player. */
  countDraws(player: PlayerId): number {
    return this.game.events.filter((e) => e.t === 'draw' && e.player === player).length;
  }

  clearEvents(): void {
    this.game.events = [];
  }

  /**
   * Whether a named spell was countered. Checking the graveyard is not enough —
   * a resolved instant or sorcery ends up there too.
   */
  wasCountered(name: string): boolean {
    const oracleId = oracleByName(name).oracleId;
    return this.game.events.some(
      (e) => e.t === 'spellCountered' && this.game.state.cards[e.iid]?.oracleId === oracleId,
    );
  }

  wasResolved(name: string): boolean {
    const oracleId = oracleByName(name).oracleId;
    return this.game.events.some(
      (e) => e.t === 'spellResolved' && this.game.state.cards[e.iid]?.oracleId === oracleId,
    );
  }

  stackNames(): string[] {
    return this.game.state.stack.map((iid) => {
      const c = this.game.state.cards[iid];
      return c.isAbility ? `[${c.abilityLabel}]` : cardName(c);
    });
  }

  logText(): string {
    return this.game.state.log.map((l) => l.text).join('\n');
  }

  /** Every card must always be somewhere. Catches zone-transition bugs. */
  assertCardConservation(): void {
    const s = this.game.state;
    for (const p of ['p1', 'p2'] as PlayerId[]) {
      const zones = s.zones[p];
      const owned = Object.values(s.cards).filter((c) => c.owner === p && !c.isToken && !c.isAbility);
      const inZones =
        zones.library.length +
        zones.hand.length +
        zones.battlefield.length +
        zones.graveyard.length +
        zones.exile.length +
        s.stack.filter((i) => s.cards[i]?.owner === p && !s.cards[i].isAbility && !s.cards[i].isToken)
          .length;
      if (owned.length !== 60) {
        throw new Error(`${p} owns ${owned.length} cards, expected 60`);
      }
      if (inZones !== 60) {
        throw new Error(`${p} has ${inZones} cards across zones, expected 60`);
      }
    }
  }

  /** A card's power/toughness right now. */
  pt(iid: IID): string {
    const c = this.game.state.cards[iid];
    const f = currentFace(c);
    const bonus = c.counters['+1/+1'] ?? 0;
    return `${(Number(f.power) || 0) + bonus}/${(Number(f.toughness) || 0) + bonus}`;
  }
}

export function testGame(
  opts: { seed?: number; startingPlayer?: PlayerId; autoPass?: boolean } = {},
): TestGame {
  const t = new TestGame(opts.seed ?? 1, opts.startingPlayer ?? 'p1');
  if (opts.autoPass) t.game.autoPass = true;
  return t;
}
