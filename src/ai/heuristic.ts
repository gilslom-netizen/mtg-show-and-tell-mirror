import type { Intent, LegalAction } from '../engine/game.js';
import type { MatchState } from '../engine/match.js';
import type { CardView, ChoiceView, PlayerView } from '../engine/redact.js';
import type { ChoiceResponse, IID, OracleId, PlayerId, TargetRef } from '../engine/types.js';
import { handSizeAfter } from '../engine/state.js';
import type { Agent } from './agent.js';
import {
  Basket,
  COMBO_PERMANENTS,
  SELECTION,
  landQuality,
  showAndTellRank,
  threatOf,
} from './cards.js';
import { faceOfView, isLandSource, read, remainingToughness, type Read } from './view.js';

/**
 * Stage 1: the whole deck's plan, written out by hand.
 *
 * Two things about the shape are deliberate, and both are aimed at what comes after
 * it rather than at this agent (DESIGN-AI.md 4, 8.2):
 *
 *  - **It scores the engine's own legal-action list and takes the best.** It does not
 *    decide what it wants and then look for it. That is exactly the interface a
 *    learned policy uses — `score(state ⊕ action)` over the list the engine already
 *    produces — so stage 4 replaces the scoring function and nothing else. It also
 *    means the agent can never propose an illegal action, with no masking anywhere.
 *  - **It is deterministic.** Difficulty comes from search budget, never from noise
 *    (§15), and a deterministic baseline is what makes a regression in another agent
 *    distinguishable from variance.
 *
 * What it does *not* do is the honest boundary of a heuristic. It never bluffs, never
 * reads a bluff, and never holds a counter back for a better spell — those need the
 * opponent model and the search that stages 2–5 are for. It plays its own game well
 * and ignores the fact that someone is sitting opposite.
 */

type ChoiceOf<K extends ChoiceView['kind']> = Extract<ChoiceView, { kind: K }>;

/** One action, with what the heuristic thinks of it. */
export interface RankedAction {
  intent: Intent;
  score: number;
  /** Tapping a land is legal everywhere and is never a candidate for anything. */
  isManaAbility: boolean;
}

/** Lands that come in untapped only if you pay two life. */
const SHOCKLANDS: OracleId[] = [
  'breeding_pool',
  'watery_grave',
  'hallowed_fountain',
  'steam_vents',
];

const FETCHLANDS: OracleId[] = ['flooded_strand', 'polluted_delta'];

/** Lands that enter tapped and surveil 1 on the way in. */
const SURVEIL_LANDS: OracleId[] = [
  'hedge_maze',
  'undercity_sewers',
  'meticulous_archive',
  'thundering_falls',
];

/**
 * A land drop is a use-it-or-lose-it resource and is almost never the wrong play, so
 * every land outranks every spell and the choice between lands is a tie-break inside
 * this band.
 */
const PLAY_LAND_BASE = 900;

/**
 * How many cards each spell takes out of my library and does not put back.
 *
 * This deck's failure mode is not losing to the opponent, it is running out of cards.
 * With an Omniscience on the battlefield every spell in hand is free, and free means
 * the agent will cast all of them — four Atraxas each revealing ten and keeping one
 * of eight types is thirty-two cards on its own. Left ungoverned it draws its entire
 * sixty and dies on the next draw step, having never lost a game to anybody.
 *
 * The fix is arithmetic rather than judgement, which is what §2.1 says this format
 * rewards: the agent knows exactly how many cards it has left and exactly what each
 * spell costs, so it can simply refuse to spend past the reserve. Cards that only
 * look at the library and put the rest back cost only what they keep.
 */
const LIBRARY_COST: Record<OracleId, number> = {
  atraxa_grand_unifier: 8,
  rakshasas_bargain: 4, // two into hand, two into the graveyard
  dig_through_time: 2,
  brainstorm: 1,
  planar_genesis: 1,
  borne_upon_a_wind: 1,
  demonic_tutor: 1,
  assemble_the_team: 1,
  waterlogged_teachings: 1,
};

/** Cards that only look at the library. Everything else pays for itself in board. */
const SELECTION_SPELLS = new Set<OracleId>([
  'brainstorm',
  'dig_through_time',
  'rakshasas_bargain',
  'planar_genesis',
  'borne_upon_a_wind',
  'demonic_tutor',
  'assemble_the_team',
  'waterlogged_teachings',
]);

/**
 * Cards that must be left in the library, always.
 *
 * A bet on how long a game takes: the measured average is 14.1 turns, and ten is
 * enough draw steps to be losing for a reason other than arithmetic.
 */
const LIBRARY_FLOOR = 10;

export class HeuristicAgent implements Agent {
  readonly name = 'heuristic';

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  act(view: PlayerView): Intent {
    return this.rank(view)[0].intent;
  }

  /**
   * Every action available here, best first, with the score behind it.
   *
   * `act` is the first element of this. It is exposed because a search agent needs
   * exactly this list: something has to decide which two or three of the legal
   * actions are worth spending playouts on, and until there is a policy head
   * (§9.3) the heuristic is the thing that knows. Passing is always in the list,
   * scored zero, so "do nothing" is a candidate like any other.
   */
  rank(view: PlayerView): RankedAction[] {
    const r = read(view);
    const scored: RankedAction[] = [
      { intent: { t: 'passPriority' }, score: 0, isManaAbility: false },
    ];
    for (const action of view.legalActions) {
      if (action.intent.t === 'passPriority') continue;
      scored.push({
        intent: action.intent,
        score: this.scoreAction(action, r),
        isManaAbility: Boolean(action.isManaAbility),
      });
    }
    // A stable sort, so two actions the heuristic cannot separate are separated the
    // same way every time and a replay stays a replay.
    return scored.sort((a, b) => b.score - a.score);
  }

  private scoreAction(action: LegalAction, r: Read): number {
    const intent = action.intent;
    switch (intent.t) {
      case 'passPriority':
      case 'concede':
        return 0;
      case 'tapForMana':
        // Never chosen on purpose: the engine's auto-tapper pays for whatever is
        // cast, and floating mana with nothing to spend it on is how a bot spends a
        // turn tapping lands back and forth.
        return 0;
      case 'playLand':
        return this.scoreLand(intent.iid, intent.face ?? 'front', r);
      case 'activateAbility':
        return this.scoreAbility(intent.iid, r);
      case 'castSpell':
        return this.scoreCast(intent.iid, intent.free === true, r);
      case 'turnFaceUp':
        // Cube-only (manifest dread); the maindeck agent never sees one. Neutral
        // rather than never, so a future cube-playing agent at least considers it.
        return 50;
    }
  }

  private scoreLand(iid: IID, face: 'front' | 'back', r: Read): number {
    if (face === 'back') {
      /*
       * Waterlogged Teachings as Inundated Archive.
       *
       * The front face finds Mana Drain or a flash threat, which is worth far more
       * than a tapped dual — so it is only ever the land when the land is what is
       * missing. Scored just inside the land band so that any real land in hand
       * beats it, and so that taking the drop still beats casting a spell: a land
       * drop is gone at end of turn and a Brainstorm is not.
       */
      return r.myLands.length <= 2 ? PLAY_LAND_BASE + 1 : 0;
    }
    const id = r.view.cards[iid]?.oracleId;
    if (!id) return PLAY_LAND_BASE;

    const untapped = this.entersUntapped(id, r);
    // Three is the number that matters: it casts Show and Tell.
    const needMana = r.openMana < 3;
    const tempo = needMana ? (untapped ? 45 : 0) : untapped ? 0 : 20;
    return PLAY_LAND_BASE + tempo + landQuality(id) / 10;
  }

  private entersUntapped(id: OracleId, r: Read): boolean {
    if (SHOCKLANDS.includes(id)) return r.myLife > 6;
    if (FETCHLANDS.includes(id)) return true; // cracked the same turn for a dual
    switch (id) {
      case 'island':
        return true;
      case 'mystic_sanctuary':
        return this.islands(r) >= 3;
      case 'mistrise_village':
        return r.myLands.some(
          (c) =>
            (faceOfView(c)?.subtypes.includes('Forest') ?? false) ||
            (faceOfView(c)?.subtypes.includes('Mountain') ?? false),
        );
      default:
        // The surveil lands, which is the point of them: a free look for the tempo.
        return false;
    }
  }

  private islands(r: Read): number {
    return r.myLands.filter((c) => faceOfView(c)?.subtypes.includes('Island') ?? false).length;
  }

  private scoreAbility(iid: IID, r: Read): number {
    const id = r.view.cards[iid]?.oracleId;
    if (!id) return 0;

    if (FETCHLANDS.includes(id)) {
      // Below a land drop and above every spell: land, crack, then cast, so the
      // mana is there before anything wants to spend it.
      if (r.openMana < 3 && this.hasSomethingToCast(r)) return 700;
      // Otherwise it is still worth turning a fetch into a real land while the
      // manabase is being built, and the shuffle is free value after a Brainstorm.
      if (r.sorceryTiming && r.myLands.length <= 3) return 250;
      return 0;
    }

    /*
     * Mistrise Village's shield is deliberately unused.
     *
     * "The next spell you cast can't be countered" is only worth a card's worth of
     * mana if the opponent is actually holding Mana Drain, and knowing that is the
     * opponent model of §12 — a heuristic that guesses will either waste the mana
     * that would have cast Show and Tell, or protect a Brainstorm. This is a stage 2
     * decision, not a stage 1 one.
     */
    return 0;
  }

  /** Is there anything in hand that more mana would let me cast? */
  private hasSomethingToCast(r: Read): boolean {
    return r.hand.some((c) => !isLandSource(c.oracleId) || c.oracleId === 'waterlogged_teachings');
  }

  private scoreCast(iid: IID, free: boolean, r: Read): number {
    const id = r.view.cards[iid]?.oracleId;
    if (!id) return 0;

    // With an Omniscience out the engine offers both a free cast and a paid one for
    // the same card. Paying is never right.
    if (!free && r.omniMine) return 0;

    // A card that only finds cards is worth nothing once there is nothing left to
    // find, and worth less than nothing near the bottom of the library.
    if (!this.worthDrawing(id, r)) return 0;

    // Reactive spells answer whatever is on the stack and are exempt from both
    // windows below: their whole job is to be cast at the wrong time.
    if (id === 'mana_drain') return this.counterScore(r);
    if (id === 'veil_of_summer') return this.veilScore(r);

    /*
     * Never respond to yourself.
     *
     * You hold priority in order to answer the opponent. Your own spell is not
     * something to answer — it is something to let resolve, and then decide what to
     * do knowing what it did. Casting into your own stack means choosing the next
     * spell blind, and resolving everything backwards.
     *
     * Paid casts could not do this anyway, because sorcery timing already demands an
     * empty stack. Free ones could, and did: with an Omniscience out the agent cast
     * Brainstorm and then, before seeing the three cards, cast Dig Through Time in
     * response to it. From the other side of the table that is not a difficult
     * opponent, it is a visibly broken one.
     *
     * Triggers count. A Hullbreaker Horror trigger or a Bowmasters ping is not a
     * spell and is still the thing that has to happen before the next decision means
     * anything — which is exactly the Bowmasters loop's rule, arrived at once rather
     * than card by card.
     */
    if (r.myStack.length > 0) return 0;

    if (free) return this.freeCastScore(id, r);

    /*
     * Everything else waits for a window where spending mana costs nothing.
     *
     * Half this deck is instants, and without this the agent taps out for Rakshasa's
     * Bargain during its own upkeep and then cannot cast the Show and Tell it drew.
     * The two windows that do not cost a turn are my own main phase and the
     * opponent's end step.
     */
    if (!this.proactiveWindow(r)) return 0;

    switch (id) {
      case 'show_and_tell': {
        const pick = this.bestShowAndTellRankInHand(r);
        if (pick >= 60) return 850; // a combo permanent: this is the deck's whole plan
        if (pick > 0) return 120; // a land: fine, and better than holding it forever
        return 0; // nothing to show — casting it just helps the opponent
      }
      // Hard-casting Omniscience means a Mana Drain resolved for seven or more.
      // If the engine says it is payable, it is the best thing that will ever happen.
      case 'omniscience':
        return 900;
      case 'atraxa_grand_unifier':
        return this.controlsAtraxa(r) ? 200 : 700;
      case 'hullbreaker_horror':
        return 650;
      case 'demonic_tutor':
        return 520;
      case 'rakshasas_bargain':
        return 480;
      case 'dig_through_time':
        return 470;
      case 'assemble_the_team':
        return 440;
      case 'waterlogged_teachings':
        return 400;
      case 'planar_genesis':
        return 380;
      case 'brainstorm':
        return this.brainstormScore(r);
      case 'orcish_bowmasters':
        return this.bowmastersScore(r);
      case 'borne_upon_a_wind':
        // A card, and flash for the rest of the turn. Last in line.
        return 80;
      default:
        return 100;
    }
  }

  private controlsAtraxa(r: Read): boolean {
    return r.myPermanents.some((c) => c.oracleId === 'atraxa_grand_unifier');
  }

  /**
   * Whether to spend library on this spell at all.
   *
   * Two conditions, and the second is the one that matters. A card that finds
   * something is worth its cards only while there is still something to find: once
   * Show and Tell and a permanent are both in hand with the mana to cast them, or
   * once Omniscience is down with a way to win, every further Brainstorm is a card
   * off a library that is the only thing that can beat this deck. That is why the
   * agent stops digging rather than digging to a fixed depth — a fixed depth is
   * either too shallow to find the combo or too deep to survive finding it.
   */
  private worthDrawing(id: OracleId, r: Read): boolean {
    // The first Atraxa is a seven-power flier that happens to reveal ten cards, and
    // nothing about the library should stop it. The second is eight cards and a
    // legend-rule funeral, which is a draw spell and is priced as one.
    const secondAtraxa = id === 'atraxa_grand_unifier' && this.controlsAtraxa(r);
    if (!SELECTION_SPELLS.has(id) && !secondAtraxa) return true;

    const cost = LIBRARY_COST[id] ?? 0;
    if (r.view.players[r.me].libraryCount - cost < LIBRARY_FLOOR) return false;
    return this.stillDigging(r);
  }

  /** Is there still a piece of the plan missing? */
  private stillDigging(r: Read): boolean {
    if (r.omniMine) {
      // Everything in hand is free now. The only thing left worth finding is a way
      // to actually end the game.
      return !this.hasWinCondition(r);
    }
    const haveShowAndTell = (r.handCounts.get('show_and_tell') ?? 0) > 0;
    const haveThreat = COMBO_PERMANENTS.some((id) => (r.handCounts.get(id) ?? 0) > 0);
    // Both halves and the three mana to cast them is the whole deck's plan.
    return !(haveShowAndTell && haveThreat && r.myLands.length >= 3);
  }

  private hasWinCondition(r: Read): boolean {
    if (this.bowmastersLoopLive(r)) return true;
    return r.myCreatures.reduce((n, c) => n + (c.power ?? 0), 0) >= 5;
  }

  private freeCastScore(id: OracleId, r: Read): number {
    switch (id) {
      case 'orcish_bowmasters':
        /*
         * The loop. An Omniscience and a Hullbreaker Horror turn two Bowmasters into
         * "cast one, bounce the other, ping them for one, repeat until they are
         * dead". Each cycle costs nothing and takes a life, so it is simply the game.
         *
         * The order is the whole trick, and getting it wrong is silent in two
         * different ways.
         *
         * The order is the whole trick. The Horror returns a *permanent*, so the copy
         * being bounced has to have finished resolving; and the ping the new one puts
         * on the stack has to resolve too, or the triggers pile up one per cycle
         * while the life total never moves and the loop never reaches the condition
         * that ends it.
         *
         * Both of those are now just the general rule above — nothing of mine on the
         * stack, spell or trigger — so the loop needs no special case of its own. One
         * cycle, one point of damage, which is how a person plays it.
         */
        if (this.bowmastersLoopLive(r)) return 3000;
        return 300;
      case 'atraxa_grand_unifier':
        // A second Atraxa is a legend-rule sacrifice that happens to reveal ten
        // cards. Eight of them come out of a library that is the real clock here.
        return this.controlsAtraxa(r) ? 250 : 800;
      case 'hullbreaker_horror':
        return 750;
      case 'rakshasas_bargain':
        return 700;
      case 'dig_through_time':
        return 680;
      case 'brainstorm':
        return 650;
      case 'demonic_tutor':
        return 620;
      case 'planar_genesis':
        return 600;
      case 'assemble_the_team':
        return 560;
      case 'waterlogged_teachings':
        return 540;
      case 'borne_upon_a_wind':
        return 400;
      case 'mana_drain':
        return this.counterScore(r);
      case 'veil_of_summer':
        return this.veilScore(r);
      case 'show_and_tell':
        // Symmetrical, and there is nothing left it can do for me: whatever I would
        // have shown, Omniscience casts for nothing. All it does is hand the
        // opponent a free Omniscience of their own.
        return 0;
      case 'omniscience':
        // A second one does nothing at all.
        return 0;
      default:
        return 100;
    }
  }

  /**
   * The loop only makes progress while the ping can actually land. Veil of Summer
   * gives the opponent hexproof from black, which removes the Bowmasters trigger
   * outright (CR 603.3d) — so under a Veil the same two Bowmasters would bounce back
   * and forth forever without taking a single life.
   */
  private bowmastersLoopLive(r: Read): boolean {
    if (!r.horrorMine) return false;
    if (!r.myPermanents.some((c) => c.oracleId === 'orcish_bowmasters')) return false;
    if (r.oppLife <= 0) return false;
    return !r.view.effects.some(
      (e) =>
        e.kind === 'grantAbility' &&
        e.ability === 'hexproofFromBlack' &&
        e.players.includes(r.opp),
    );
  }

  /** A window in which mana spent is mana that was going to be wasted anyway. */
  private proactiveWindow(r: Read): boolean {
    if (r.sorceryTiming) return true;
    return !r.isMyTurn && r.view.step === 'end_step' && r.view.stack.length === 0;
  }

  private bestShowAndTellRankInHand(r: Read): number {
    let best = 0;
    for (const c of r.hand) best = Math.max(best, showAndTellRank(c.oracleId, r));
    return best;
  }

  /**
   * Whether a Mana Drain pointed at this spell would actually counter it.
   *
   * Everything this needs is public and the agent was ignoring all of it. In a real
   * game it cast Show and Tell, watched a Veil of Summer resolve — the log even
   * says "spells you control can't be countered this turn" — and then spent its Mana
   * Drain on the next spell anyway. The counter did nothing; the ramp it still gets
   * was worthless, because under an Omniscience every spell already costs nothing.
   *
   * Hullbreaker Horror is the same mistake with no effect to read at all: the card
   * simply cannot be countered, which is a fact about the twenty-five cards.
   *
   * The answer to an uncounterable spell is the Horror's bounce, not a counter —
   * returning it to hand is not countering it, which is the whole reason that half
   * of the trigger exists.
   */
  private counterable(oracleId: OracleId, r: Read): boolean {
    if (oracleId === 'hullbreaker_horror') return false;
    return !r.view.effects.some(
      (e) =>
        e.kind === 'cantBeCountered' &&
        e.controller === r.opp &&
        (e.scope === 'allThisTurn' || !e.consumed),
    );
  }

  private counterScore(r: Read): number {
    const targets = r.oppSpells.filter((s) => this.counterable(s.oracleId, r));
    const best = Math.max(0, ...targets.map((s) => threatOf(s.oracleId, r)));
    // Above everything: a countered Omniscience is a game won, and the mana it
    // refunds often hard-casts one of my own.
    if (best >= 50) return 950;
    // A Brainstorm is not worth a Mana Drain while there are four Omnisciences left
    // in their deck.
    if (best >= 30) return 300;
    return 0;
  }

  /**
   * Veil of Summer answers their answer. It is not something to cast into your own
   * spell, and casting it there is the same mistake as any other self-response.
   *
   * The old rule was "one of mine on the stack and one of theirs anywhere on it",
   * which is not the same question at all. In a real game their Atraxa and their
   * Horror were sitting at the bottom of a six-deep stack, four of my own spells
   * were piled on top, and that read as "they have responded" — so the Veil went
   * off into a stack whose next four objects were all mine. It protected nothing,
   * it announced the card, and it put yet another of my objects above theirs.
   *
   * What matters is what resolves next. If that is mine, the answer has not been
   * played yet and there is nothing to protect against; wait, let them commit, and
   * cast the Veil in response to the counter — which is the line the deck is built
   * on, and the reason it beats a Mana Drain rather than trading with it.
   */
  private veilScore(r: Read): number {
    const top = r.stack[r.stack.length - 1];
    if (!top || top.isAbility || top.controller !== r.opp) return 0;
    // A Veil beats exactly one card in this pool: it makes my spells uncounterable
    // for the turn, so their Mana Drain resolves into nothing. Against anything
    // else of theirs it is a cantrip that would rather be cast later.
    if (top.oracleId !== 'mana_drain') return 0;
    if (r.mySpells.length === 0) return 0;
    return 940;
  }

  private brainstormScore(r: Read): number {
    // Brainstorm without a shuffle puts two cards back that have to be drawn again.
    // An uncracked fetchland turns it into three fresh cards, which is a different
    // card entirely.
    const shuffleAvailable = r.myLands.some(
      (c) => FETCHLANDS.includes(c.oracleId) && !c.tapped,
    );
    if (shuffleAvailable) return 460;
    if (r.myLands.length + r.landsInHand < 3) return 450; // digging for a land
    if (r.hand.length <= 3) return 300;
    return 150;
  }

  private bowmastersScore(r: Read): number {
    // A two mana 1/1 that kills something is a fine deal; one that pings a face is
    // the worst spell in the deck.
    if (r.oppCreatures.some((c) => remainingToughness(c) <= 1)) return 420;
    return 200;
  }

  // -------------------------------------------------------------------------
  // Questions
  // -------------------------------------------------------------------------

  respond(view: PlayerView, choice: ChoiceView): ChoiceResponse {
    const r = read(view);
    switch (choice.kind) {
      case 'mulligan':
        return { kind: 'yesNo', value: this.keepHand(r, choice) };
      case 'simultaneousSecret':
        return { kind: 'secret', iid: this.secretPick(r, choice) };
      case 'chooseCards':
        return { kind: 'cards', iids: this.pickCards(r, choice) };
      case 'chooseTargets':
        return { kind: 'targets', targets: this.pickTargets(r, choice) };
      case 'chooseMode':
        return { kind: 'modes', modes: this.pickModes(r, choice) };
      case 'yesNo':
        return { kind: 'yesNo', value: this.answerYesNo(r, choice) };
      case 'orderTriggers':
        return { kind: 'order', ids: this.orderTriggers(r, choice) };
      case 'declareAttackers':
        return { kind: 'attackers', iids: this.attackers(r, choice) };
      case 'declareBlockers':
        return { kind: 'blockers', blocks: this.blockers(r, choice) };
      case 'distributeDamage':
        return { kind: 'damage', assignment: this.assignDamage(r, choice) };
    }
  }

  /** Play, always. On the draw this deck is a turn behind on a two-card combo. */
  chooseFirst(_match: MatchState, me: PlayerId): PlayerId {
    return me;
  }

  // --- mulligan -------------------------------------------------------------

  /**
   * Keep or ship.
   *
   * The mulligan is decision number one and it moves about 15% of the result in a
   * combo deck, which makes it worth more than most of the rest of this file. The
   * London rule means the hand is always seven cards and some of them go back, so
   * what is being judged is the best `7 - bottomed` of what is showing.
   *
   * The first mulligan is free, which changes this rather than just shifting it: a
   * seven-card hand that fails the seven-card standard is shipped for another seven
   * at no cost at all, so the strict test applies twice rather than once.
   */
  private keepHand(r: Read, choice: ChoiceOf<'mulligan'>): boolean {
    const keep = Math.max(1, handSizeAfter(choice.mulligansTaken));
    // Five is the floor. Below it the hand loses to itself, whatever is in it.
    if (keep <= 4) return true;

    const best = this.rankHand(r).slice(0, keep);
    const lands = best.filter((c) => isLandSource(c.oracleId)).length;
    const action = best.filter(
      (c) => SELECTION.includes(c.oracleId) || c.oracleId === 'show_and_tell',
    ).length;
    const combo = best.some((c) => COMBO_PERMANENTS.includes(c.oracleId));
    const showAndTell = best.some((c) => c.oracleId === 'show_and_tell');

    // One land does not cast a three drop and six lands do not win a game.
    if (lands < 2 || lands > 5) return keep <= 5 && lands >= 1;
    // Both halves of the combo, with mana. Nothing else needs checking.
    if (showAndTell && combo) return true;
    if (keep >= 7) return action >= 2 || (action >= 1 && combo);
    if (keep === 6) return action >= 1;
    return true;
  }

  /**
   * My hand, best card first.
   *
   * Greedy and re-priced after every pick, because the marginal card is what matters:
   * the eighth-best card in a hand of two Omnisciences and five lands is not the
   * eighth-best card in the abstract.
   */
  private rankHand(r: Read): { iid: IID; oracleId: OracleId }[] {
    return this.rankGreedily(r.hand, Basket.fromBoard(r));
  }

  private rankGreedily(
    cards: { iid: IID; oracleId: OracleId }[],
    basket: Basket,
  ): { iid: IID; oracleId: OracleId }[] {
    const left = [...cards];
    const out: { iid: IID; oracleId: OracleId }[] = [];
    while (left.length > 0) {
      let bestIndex = 0;
      let bestValue = -Infinity;
      for (let i = 0; i < left.length; i++) {
        const v = basket.valueOf(left[i].oracleId);
        if (v > bestValue) {
          bestValue = v;
          bestIndex = i;
        }
      }
      const [taken] = left.splice(bestIndex, 1);
      basket.add(taken.oracleId);
      out.push(taken);
    }
    return out;
  }

  // --- Show and Tell --------------------------------------------------------

  private secretPick(r: Read, choice: ChoiceOf<'simultaneousSecret'>): IID | null {
    let best: IID | null = null;
    let bestRank = 0;
    for (const option of choice.myOptions) {
      if (option.disabledReason) continue;
      const id = r.view.cards[option.iid]?.oracleId;
      if (!id) continue;
      const rank = showAndTellRank(id, r);
      if (rank > bestRank) {
        bestRank = rank;
        best = option.iid;
      }
    }
    return best;
  }

  // --- card selection -------------------------------------------------------

  /**
   * Every "which of these" question in the deck.
   *
   * The distinction that decides all of them is whether the cards are being taken or
   * given up. Brainstorm's two back to the library, the London bottoming and Dig
   * Through Time's leftovers are giving up, so they take the worst; every search,
   * every Atraxa type and both halves of Planar Genesis are taking, so they take the
   * best. One value function underneath both, so the agent cannot tutor for a card
   * and then bin it.
   */
  private pickCards(r: Read, choice: ChoiceOf<'chooseCards'>): IID[] {
    /*
     * A prompt that permits nothing wants nothing.
     *
     * Gitaxian Probe shows you their hand through a chooseCards with min and max
     * both zero — the cards are there to be read, not picked, and Confirm is the
     * only answer. Worth guarding on its own, but it also stops a `-0` trap
     * further down: `slice(-max)` with a max of zero is `slice(0)`, the whole
     * list, so the agent answered "select nothing" with every card in the hand
     * and the engine threw. That crashed any game in which the AI cast Probe.
     */
    if (choice.max === 0) return [];

    const selectable = choice.options
      .filter((o) => !o.disabledReason)
      .map((o) => ({ iid: o.iid, oracleId: r.view.cards[o.iid]?.oracleId }))
      .filter((c): c is { iid: IID; oracleId: OracleId } => Boolean(c.oracleId));
    if (selectable.length === 0) return [];

    const source = choice.source?.oracleId;

    // Surveil: how many, not which — anything below the bar goes to the graveyard,
    // where it is Delve fuel rather than a wasted draw.
    if (source && SURVEIL_LANDS.includes(source)) {
      return this.surveilBin(r, selectable, choice.max);
    }

    /*
     * Cards leaving my hand: Brainstorm putting two back, or the London bottoming.
     *
     * Both give up the worst of what is showing. `rankGreedily` returns best first,
     * so the tail is what goes — and the tail is already in "least bad first" order,
     * which is what these prompts want: Brainstorm's first card ends up on top of
     * the library and is therefore seen again soonest.
     */
    if (choice.from === 'hand') {
      const ranked = this.rankGreedily(selectable, Basket.fromBoard(r));
      return ranked.slice(-choice.max).map((c) => c.iid);
    }

    // Dig Through Time ordering its leftovers onto the bottom. They are appended in
    // the order given, so the first one given is the shallowest — best first.
    if (choice.ordered) {
      return this.rankGreedily(selectable, Basket.fromHand(r)).map((c) => c.iid);
    }

    // Planar Genesis: a land onto the battlefield tapped, or any card into hand.
    // The land does not use the land drop, which makes it the better half of the
    // card while the manabase is still short.
    if (source === 'planar_genesis' && choice.min === 0) {
      if (r.myLands.length >= 4) return [];
      const lands = selectable.filter((c) => isLandSource(c.oracleId));
      if (lands.length === 0) return [];
      const best = lands.reduce((a, b) =>
        landQuality(b.oracleId) > landQuality(a.oracleId) ? b : a,
      );
      return [best.iid];
    }

    // Everything else is free value: take as much as it will give.
    const take = Math.max(choice.min, Math.min(choice.max, selectable.length));
    return this.rankGreedily(selectable, Basket.fromHand(r))
      .slice(0, take)
      .map((c) => c.iid);
  }

  /**
   * Which surveilled cards to bin.
   *
   * A card in the graveyard is not lost in this deck — it is a Delve counter, which
   * is what makes Dig Through Time cost two mana. So the bar for binning is lower
   * than it looks, and lower still while there is a Dig in hand to pay for.
   */
  private surveilBin(
    r: Read,
    selectable: { iid: IID; oracleId: OracleId }[],
    max: number,
  ): IID[] {
    const basket = Basket.fromHand(r);
    const wantsFuel =
      r.hand.some((c) => c.oracleId === 'dig_through_time') && r.myGraveyard < 8;
    const bar = wantsFuel ? 58 : 42;
    return selectable
      .filter((c) => basket.valueOf(c.oracleId) < bar)
      .slice(0, max)
      .map((c) => c.iid);
  }

  // --- targets --------------------------------------------------------------

  private pickTargets(r: Read, choice: ChoiceOf<'chooseTargets'>): TargetRef[] {
    const scored = choice.candidates
      .map((t) => ({ t, v: this.targetValue(t, r, choice.source?.oracleId) }))
      .sort((a, b) => b.v - a.v);
    if (choice.optional && (scored.length === 0 || scored[0].v <= 0)) return [];
    return scored.slice(0, choice.count).map((x) => x.t);
  }

  private targetValue(t: TargetRef, r: Read, source: OracleId | undefined): number {
    if (t.kind === 'player') {
      if (t.id === r.me) return -1000; // never, whatever the effect is
      // A ping that finishes them beats every other use of a trigger.
      return r.oppLife <= 1 ? 1000 : 30;
    }

    if (t.kind === 'spell') {
      const id = r.view.cards[t.iid]?.oracleId;
      return id ? threatOf(id, r) : 10;
    }

    if (t.kind === 'card') {
      // Mystic Sanctuary putting an instant or sorcery from my graveyard back on
      // top. Priced with the same function as everything else I might draw.
      const id = r.view.cards[t.iid]?.oracleId;
      return id ? Basket.fromHand(r).valueOf(id) : 10;
    }

    // A permanent. Either something of theirs I want gone, or — for Hullbreaker
    // Horror — one of mine I want back.
    const card = r.view.cards[t.iid];
    if (!card) return 0;
    if (card.controller === r.me) {
      if (source === 'hullbreaker_horror' && card.oracleId === 'orcish_bowmasters') {
        return this.bowmastersLoopLive(r) ? 900 : -1000;
      }
      // Bowmasters shooting my own board, or the Horror bouncing my own Omniscience.
      return -1000;
    }

    if (source === 'orcish_bowmasters') {
      // One damage. Worth spending on a creature only if it kills it.
      return remainingToughness(card) <= 1 ? 60 + this.permanentValue(card) / 10 : 5;
    }
    return this.permanentValue(card);
  }

  /** How much the opponent having this permanent costs me. */
  private permanentValue(card: CardView): number {
    switch (card.oracleId) {
      case 'omniscience':
        return 800;
      case 'atraxa_grand_unifier':
        return 700;
      case 'hullbreaker_horror':
        return 650;
      case 'orcish_bowmasters':
        return 300;
      default:
        return card.isToken ? 100 : 200;
    }
  }

  // --- modes ----------------------------------------------------------------

  private pickModes(r: Read, choice: ChoiceOf<'chooseMode'>): number[] {
    const enabled = choice.modes.filter((m) => m.enabled).map((m) => m.index);
    if (enabled.length === 0) return [];

    if (choice.source?.oracleId === 'hullbreaker_horror') {
      /*
       * Bouncing a spell is a counter that cannot itself be countered, and it works
       * through Veil of Summer and Mistrise Village — so it is the better half
       * whenever there is anything on the stack worth answering.
       *
       * Except against an Omniscience. Then the card lands in a hand it costs
       * nothing to leave again, and the "counter" has achieved one recast. Two
       * Horrors facing each other across two Omnisciences do that to one another
       * literally forever: each bounces the other's Mana Drain, each recasts it for
       * free, no card is ever spent and no life total ever moves. It is a real,
       * non-terminating loop and the arena found it by refusing to finish 65 games
       * out of 600. Bouncing a permanent — their Omniscience for preference — is the
       * half that actually changes something.
       */
      if (enabled.includes(0) && !r.omniTheirs) {
        const best = Math.max(0, ...r.oppSpells.map((s) => threatOf(s.oracleId, r)));
        if (best >= 30) return [0];
      }
      // Only reach for the permanent half when something is actually worth bouncing.
      // Choosing it blindly is how a Horror returns its controller's own Omniscience.
      if (enabled.includes(1) && this.worthBouncing(r)) return [1];
      return choice.min > 0 ? [enabled[0]] : [];
    }
    return enabled.slice(0, Math.max(choice.min, 1));
  }

  private worthBouncing(r: Read): boolean {
    if (this.bowmastersLoopLive(r)) return true;
    return r.oppPermanents.some(
      (c) =>
        !(faceOfView(c)?.types.includes('Land') ?? false) && this.permanentValue(c) >= 250,
    );
  }

  // --- yes/no ---------------------------------------------------------------

  private answerYesNo(r: Read, choice: ChoiceOf<'yesNo'>): boolean {
    const source = choice.source?.oracleId;
    if (source && SHOCKLANDS.includes(source)) {
      /*
       * Two life for an untapped land.
       *
       * A combo deck's life total is a resource until it is the thing losing the
       * game. Paying is right while there is a turn to gain and wrong once Orcish
       * Bowmasters is doing the arithmetic.
       */
      // Planar Genesis puts its land onto the battlefield tapped whatever is paid,
      // so the question it raises here is one where both answers give a tapped land
      // and only one of them costs two life.
      if (r.mySpells.some((s) => s.oracleId === 'planar_genesis')) return false;
      if (r.myLife <= 6) return false;
      return r.openMana < 3 || r.myLands.length <= 3 || r.myLife >= 14;
    }
    // The rest of this pool is "you may", and the may only ever adds something —
    // Mystic Sanctuary putting the best card in my graveyard back on top.
    return true;
  }

  // --- triggers -------------------------------------------------------------

  /**
   * "First will resolve last", so the ordering is by increasing importance: the
   * trigger I most want to see happen goes on the stack last and resolves first.
   */
  private orderTriggers(r: Read, choice: ChoiceOf<'orderTriggers'>): number[] {
    const weight = (sourceIid: IID) => {
      switch (r.view.cards[sourceIid]?.oracleId) {
        case 'atraxa_grand_unifier':
          return 100;
        case 'hullbreaker_horror':
          return 90;
        case 'orcish_bowmasters':
          return 60;
        case 'mystic_sanctuary':
          return 40;
        default:
          return 10;
      }
    };
    return [...choice.triggers]
      .sort((a, b) => weight(a.sourceIid) - weight(b.sourceIid))
      .map((t) => t.id);
  }

  // --- combat ---------------------------------------------------------------

  private attackers(r: Read, choice: ChoiceOf<'declareAttackers'>): IID[] {
    const mine = choice.candidates
      .map((iid) => r.view.cards[iid])
      .filter((c): c is CardView => Boolean(c));
    const blockers = r.oppCreatures.filter((c) => !c.tapped);

    // Lethal is lethal. Nothing else about the board matters.
    const total = mine.reduce((n, c) => n + (c.power ?? 0), 0);
    if (blockers.length === 0 && total >= r.oppLife) return choice.candidates;

    const out: IID[] = [];
    for (const c of mine) {
      const power = c.power ?? 0;
      if (power <= 0) continue;
      const possible = this.canBlock(c, blockers);
      if (possible.length === 0) {
        out.push(c.iid);
        continue;
      }
      // Attack when the creature survives the worst block available to them.
      const worst = Math.max(...possible.map((b) => this.effectivePower(b)));
      const dies = possible.some((b) => this.killsIt(b, c));
      if (!dies && remainingToughness(c) > worst) out.push(c.iid);
    }
    return out;
  }

  private canBlock(attacker: CardView, blockers: CardView[]): CardView[] {
    const kw = faceOfView(attacker)?.keywords ?? [];
    if (!kw.includes('Flying')) return blockers;
    return blockers.filter((b) => {
      const bkw = faceOfView(b)?.keywords ?? [];
      return bkw.includes('Flying') || bkw.includes('Reach');
    });
  }

  private effectivePower(card: CardView): number {
    return card.power ?? 0;
  }

  /** Would `attacker`'s damage kill `defender` in one combat? */
  private killsIt(attacker: CardView, defender: CardView): boolean {
    const kw = faceOfView(attacker)?.keywords ?? [];
    const power = attacker.power ?? 0;
    if (kw.includes('Deathtouch')) return power > 0;
    return power >= remainingToughness(defender);
  }

  private blockers(
    r: Read,
    choice: ChoiceOf<'declareBlockers'>,
  ): { blocker: IID; attacker: IID }[] {
    const attackers = choice.attackers
      .map((iid) => r.view.cards[iid])
      .filter((c): c is CardView => Boolean(c))
      .sort((a, b) => (b.power ?? 0) - (a.power ?? 0));
    const available = choice.blockers
      .map((iid) => r.view.cards[iid])
      .filter((c): c is CardView => Boolean(c));

    const incoming = attackers.reduce((n, c) => n + (c.power ?? 0), 0);
    // Chump blocking is only ever right when the alternative is losing.
    const mustBlock = incoming >= r.myLife;

    const used = new Set<IID>();
    const blocks: { blocker: IID; attacker: IID }[] = [];
    for (const attacker of attackers) {
      let best: CardView | null = null;
      let bestScore = 0;
      for (const b of available) {
        if (used.has(b.iid)) continue;
        const score = this.blockScore(b, attacker, mustBlock);
        if (score > bestScore) {
          bestScore = score;
          best = b;
        }
      }
      if (best) {
        used.add(best.iid);
        blocks.push({ blocker: best.iid, attacker: attacker.iid });
      }
    }
    return blocks;
  }

  private blockScore(blocker: CardView, attacker: CardView, mustBlock: boolean): number {
    const kills = this.killsIt(blocker, attacker);
    const survives = !this.killsIt(attacker, blocker);
    if (kills && survives) return 100;
    if (!kills && survives) return 60; // a wall is worth as much as the damage it eats
    if (kills && !survives) return 50; // a trade
    return mustBlock ? 10 : 0;
  }

  private assignDamage(
    r: Read,
    choice: ChoiceOf<'distributeDamage'>,
  ): Record<IID, number> {
    const assignment: Record<IID, number> = {};
    let left = choice.total;
    for (const iid of choice.blockers) {
      const card = r.view.cards[iid];
      const need = card ? Math.max(1, remainingToughness(card)) : 1;
      const give = Math.min(left, need);
      assignment[iid] = give;
      left -= give;
    }
    // The engine requires every point to be assigned somewhere.
    if (left > 0) {
      const last = choice.blockers[choice.blockers.length - 1];
      assignment[last] = (assignment[last] ?? 0) + left;
    }
    return assignment;
  }
}
