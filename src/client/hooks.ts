import { useEffect, useRef } from 'react';
import { frontFace } from '@engine/oracle';
import type { LegalAction } from '@engine/game';
import type { CardView, PlayerView } from '@engine/redact';
import type { IID, PlayerId, TargetRef } from '@engine/types';
import { canAct, useStore, type AutoPassMode } from './store';
import type { BowmastersPolicy, CombatStopMode, Settings } from './settings';

/**
 * The comfort layer.
 *
 * Everything here is client behaviour: an auto-pass sends a real pass intent, so the
 * engine, the action log and any replay are identical to a human clicking pass.
 */

function meaningful(view: PlayerView): LegalAction[] {
  return view.legalActions.filter((a) => !a.isManaAbility);
}

function canRespond(actions: LegalAction[]): boolean {
  return actions.some((a) => a.intent.t === 'castSpell' || a.intent.t === 'activateAbility');
}

/** Every token this pool can make is a creature; everything else reads its face. */
function isCreature(card: CardView): boolean {
  return card.isToken || frontFace(card.oracleId).types.includes('Creature');
}

/**
 * Whether combat can still do anything this turn.
 *
 * Attackers already declared: yes, obviously — blocks, tricks and damage all
 * follow. Otherwise it comes down to whether the active player has a creature
 * that could be declared as an attacker at all. In this format that is usually
 * nobody: the deck wins by resolving a spell, and a turn with no creature on
 * either side spends three rounds of priority in combat doing nothing. This is
 * what lets both players pass out of the beginning of combat and land in the
 * second main phase instead.
 */
export function combatCanMatter(view: PlayerView): boolean {
  if ((view.combat?.attackers.length ?? 0) > 0) return true;
  // Past the declaration, with nothing declared, combat is over in all but name.
  if (view.step !== 'begin_combat' && view.step !== 'declare_attackers') return false;
  const ap = view.activePlayer;
  return view.battlefield[ap].some((iid) => {
    const c = view.cards[iid];
    return !!c && isCreature(c) && !c.tapped && !c.summoningSick;
  });
}

/** Whether the player should be stopped here rather than passed for automatically. */
export function shouldStop(view: PlayerView, settings: Settings, autoPass: AutoPassMode): boolean {
  const actions = meaningful(view);
  // Nothing to do — the engine passes for us anyway.
  if (actions.length === 0) return false;
  // An explicit "pass until…" run overrides every stop setting.
  if (autoPass !== 'off') return false;

  const me = view.viewer;
  const stops = settings.stops;

  if (view.stack.length > 0) {
    const opposing = view.stack.some((iid) => {
      const c = view.cards[iid];
      return c && c.controller !== me;
    });
    if (!opposing) return false;
    if (stops.opponentSpellOnStack === 'never') return false;
    if (stops.opponentSpellOnStack === 'always') return true;
    // The setting that matters for this deck: stop only when Mana Drain, Veil,
    // Bowmasters or Hullbreaker could actually be cast right now.
    return canRespond(actions);
  }

  const myTurn = view.activePlayer === me;
  const isMain = view.phase === 'precombat_main' || view.phase === 'postcombat_main';

  if (myTurn) {
    if (isMain) return stops.myMainPhase;
    if (view.phase === 'combat') return stopsInCombat(view, stops.combat);
    return false;
  }

  if (view.step === 'end_step') {
    if (stops.opponentEndStep === 'never') return false;
    if (stops.opponentEndStep === 'always') return true;
    return canRespond(actions);
  }
  if (view.step === 'upkeep') return stops.opponentUpkeep;
  if (view.phase === 'combat') return stopsInCombat(view, stops.combat);
  return false;
}

function stopsInCombat(view: PlayerView, mode: CombatStopMode): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return combatCanMatter(view);
}

/**
 * Auto-passes when there is nothing worth stopping for.
 *
 * The delay is randomised inside a fixed window on purpose. If the client passed
 * instantly when it had no answer and slowly when it did, the opponent would read
 * your hand off the clock — a real information leak in other online clients.
 */
/** Card size steps, shared by the keyboard and the settings panel. */
const CARD_SCALES = [0.85, 1, 1.2, 1.45];

function adjustCardScale(direction: 1 | -1): void {
  const { settings, updateSettings } = useStore.getState();
  const i = CARD_SCALES.indexOf(settings.cardScale);
  const from = i === -1 ? 1 : i;
  const next = CARD_SCALES[Math.min(CARD_SCALES.length - 1, Math.max(0, from + direction))];
  if (next !== settings.cardScale) updateSettings({ cardScale: next });
}

export function useAutoPass(viewer: PlayerId) {
  const view = useStore((s) => s.views[viewer]);
  const settings = useStore((s) => s.settings);
  const autoPass = useStore((s) => s.autoPass);
  const forceStop = useStore((s) => s.forceStop);
  const holdPriority = useStore((s) => s.holdPriority);
  const repeat = useStore((s) => s.repeat);
  const send = useStore((s) => s.send);
  const controls = useStore((s) => s.controls);
  const setAutoPass = useStore((s) => s.setAutoPass);

  /*
   * "Pass until end of turn" needs to know which turn it started in.
   *
   * It used to end itself on `step === 'untap'`, which never arrives: the untap
   * step grants nobody priority, so the engine runs straight through it and the
   * client only ever sees a view from the upkeep onwards. The run therefore never
   * stopped — F6 in one turn kept passing through every turn after it, which is
   * exactly the bug. Anchoring to (turn, activePlayer) at the start and ending as
   * soon as either changes is what "until the end of this turn" actually means.
   */
  const runAnchor = useRef<{ turn: number; activePlayer: PlayerId } | null>(null);
  useEffect(() => {
    if (autoPass === 'off') runAnchor.current = null;
    else if (view && !runAnchor.current) {
      runAnchor.current = { turn: view.turn, activePlayer: view.activePlayer };
    }
  }, [autoPass, view]);

  // End a "pass until" run when its condition is met.
  useEffect(() => {
    if (!view || autoPass === 'off') return;
    const anchor = runAnchor.current;
    if (
      autoPass === 'endOfTurn' &&
      anchor &&
      (view.turn !== anchor.turn || view.activePlayer !== anchor.activePlayer)
    ) {
      setAutoPass('off');
      return;
    }
    if (
      autoPass === 'myNextTurn' &&
      view.activePlayer === viewer &&
      view.phase === 'precombat_main' &&
      // Same trap: without this the run ends the instant it starts when it is
      // already your own precombat main.
      anchor &&
      (view.turn !== anchor.turn || view.activePlayer !== anchor.activePlayer)
    ) {
      setAutoPass('off');
    }
  }, [view?.turn, view?.step, view?.activePlayer, autoPass]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!view || view.winner !== null) return;
    // Also covers the window where the opponent is answering a prompt of their own.
    if (!canAct(view, viewer)) return;
    if (!controls(viewer)) return;
    if (forceStop) return;
    // A repeat run is taking actions on this seat; passing for it would end the
    // very window it needs.
    if (repeat) return;
    // Holding priority is a deliberate "do not pass for me" — chaining spells
    // under an Omniscience is the whole reason it exists.
    if (holdPriority) return;
    if (shouldStop(view, settings, autoPass)) return;

    const [lo, hi] = settings.autoPassDelayMs;
    const delay = lo + Math.random() * Math.max(0, hi - lo);
    const t = window.setTimeout(() => send({ t: 'passPriority' }, viewer), delay);
    return () => window.clearTimeout(t);
    // The dependency list is the point, not a formality. With none, every render
    // — a hover, a highlight, an unrelated poll — cancelled the pending timer and
    // started it again, so moving the mouse could hold the pass off indefinitely
    // and passing felt like it randomly stopped working. `view` is a fresh object
    // only when the game state actually changed, which is exactly when the
    // decision is worth taking again.
  }, [view, viewer, settings, autoPass, forceStop, holdPriority, repeat, send, controls]);
}

/**
 * Runs a repeat, one action per state.
 *
 * The step is only taken once the previous one has produced a new view, so this
 * works the same locally and over a network, and a slow server just makes the
 * run slower rather than sending a burst of actions the engine will reject.
 */
export function useRepeatRunner() {
  const repeat = useStore((s) => s.repeat);
  const views = useStore((s) => s.views);
  const advance = useStore((s) => s.advanceRepeat);
  useEffect(() => {
    if (!repeat) return;
    // A tick of the event loop, so the view the store is about to hand out has
    // settled before the next action is measured against it.
    const t = window.setTimeout(() => advance(), 60);
    return () => window.clearTimeout(t);
  }, [repeat, views, advance]);
}

/**
 * Answers the repetitive triggers automatically.
 *
 * Without this, an Omniscience turn asks "Hullbreaker Horror — choose up to one"
 * on literally every free spell, which is what makes the combo unplayable online.
 */
export function useTriggerPolicy(viewer: PlayerId) {
  const view = useStore((s) => s.views[viewer]);
  const policy = useStore((s) => s.settings.triggers);
  const respond = useStore((s) => s.respond);
  const controls = useStore((s) => s.controls);
  const overrideRef = useRef(false);

  // Holding Alt suspends the policy for the next prompt.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') overrideRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') overrideRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(() => {
    const choice = view?.choice;
    if (!view || !choice || !controls(viewer)) return;
    if (overrideRef.current) return;
    const source =
      choice.kind === 'simultaneousSecret' || choice.kind === 'mulligan'
        ? undefined
        : choice.source;
    if (!source) return;

    if (source.oracleId === 'hullbreaker_horror' && choice.kind === 'chooseMode') {
      const spellMode = choice.modes.find((m) => m.index === 0 && m.enabled);
      switch (policy.hullbreaker) {
        case 'ask':
          return;
        case 'none':
          respond({ kind: 'modes', modes: [] }, viewer);
          return;
        case 'bounceOpposingSpell':
          respond({ kind: 'modes', modes: spellMode ? [0] : [] }, viewer);
          return;
        case 'bounceBest': {
          if (spellMode) {
            respond({ kind: 'modes', modes: [0] }, viewer);
            return;
          }
          const permMode = choice.modes.find((m) => m.index === 1 && m.enabled);
          respond({ kind: 'modes', modes: permMode ? [1] : [] }, viewer);
          return;
        }
      }
    }

    if (
      source.oracleId === 'hullbreaker_horror' &&
      choice.kind === 'chooseTargets' &&
      policy.hullbreaker === 'bounceBest'
    ) {
      const best = pickBestBounceTarget(view, choice.candidates, viewer);
      if (best) respond({ kind: 'targets', targets: [best] }, viewer);
      return;
    }

    if (source.oracleId === 'orcish_bowmasters' && choice.kind === 'chooseTargets') {
      const target = bowmastersTarget(policy.bowmasters, choice.candidates, view, viewer);
      if (target) respond({ kind: 'targets', targets: [target] }, viewer);
    }
  }, [view?.choice?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}


/**
 * Where the Orcish Bowmasters ping goes, or null to ask.
 *
 * "Only if obvious" is the default and was, until now, the one setting that did
 * nothing: it was never implemented, so the prompt appeared on every trigger no
 * matter what the policy bar said. Obvious means there is exactly one thing on
 * their side worth pointing at — their face, because they control no creature
 * one damage could matter to. The moment they have a creature the ping is a real
 * decision again and the prompt comes back.
 */
export function bowmastersTarget(
  policy: BowmastersPolicy,
  candidates: TargetRef[],
  view: PlayerView,
  viewer: PlayerId,
): TargetRef | null {
  if (policy === 'ask') return null;
  const opponent: PlayerId = viewer === 'p1' ? 'p2' : 'p1';
  const face = candidates.find((c) => c.kind === 'player' && c.id === opponent);
  if (!face) return null;
  if (policy === 'opponentFace') return face;
  const theirs = candidates.filter(
    (c) =>
      (c.kind === 'player' && c.id === opponent) ||
      (c.kind === 'permanent' && view.cards[c.iid]?.controller === opponent),
  );
  return theirs.length === 1 ? face : null;
}

/** Omniscience first, then Atraxa, then anything else the opponent controls. */
function pickBestBounceTarget(
  view: PlayerView,
  candidates: { kind: string; iid?: IID; id?: string }[],
  viewer: PlayerId,
) {
  const score = (iid?: IID) => {
    if (iid === undefined) return -1;
    const c = view.cards[iid];
    if (!c || c.controller === viewer) return -1;
    if (c.oracleId === 'omniscience') return 100;
    if (c.oracleId === 'atraxa_grand_unifier') return 90;
    if (c.oracleId === 'hullbreaker_horror') return 80;
    return 10;
  };
  let best = null as (typeof candidates)[number] | null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = score(c.iid);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best as never;
}

/** Keyboard shortcuts. Every one of them also exists as a visible button. */
export function useHotkeys(viewer: PlayerId) {
  const send = useStore((s) => s.send);
  const setAutoPass = useStore((s) => s.setAutoPass);
  const setForceStop = useStore((s) => s.setForceStop);
  const setHold = useStore((s) => s.setHoldPriority);
  const toggle = useStore((s) => s.toggle);
  const cancel = useStore((s) => s.cancel);

  useEffect(() => {
    const isTyping = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.key === 'Control') {
        setForceStop(true);
        return;
      }
      const view = useStore.getState().views[viewer];
      switch (e.key) {
        case ' ':
        case 'F2':
          e.preventDefault();
          if (view && canAct(view, viewer)) send({ t: 'passPriority' }, viewer);
          break;
        case 'F6':
          e.preventDefault();
          setAutoPass('endOfTurn');
          break;
        case 'F8':
          e.preventDefault();
          setAutoPass('myNextTurn');
          break;
        case 'Escape':
          cancel();
          setAutoPass('off');
          break;
        case 'h':
        case 'H':
          setHold(!useStore.getState().holdPriority);
          break;
        case '+':
        case '=':
          adjustCardScale(1);
          break;
        case '-':
        case '_':
          adjustCardScale(-1);
          break;
        case 'l':
        case 'L':
          toggle('logOpen');
          break;
        case '?':
        case '/':
          toggle('helpOpen');
          break;
        case ',':
          toggle('settingsOpen');
          break;
        default: {
          // 1-9 cast or play the nth card in hand.
          const n = Number(e.key);
          if (!Number.isNaN(n) && n >= 1 && n <= 9 && view && canAct(view, viewer)) {
            const iid = view.hand[n - 1];
            if (iid === undefined) break;
            const action =
              view.legalActions.find(
                (a) => a.intent.t === 'castSpell' && a.intent.iid === iid && a.intent.free,
              ) ??
              view.legalActions.find(
                (a) =>
                  (a.intent.t === 'castSpell' || a.intent.t === 'playLand') && a.intent.iid === iid,
              );
            if (action) {
              const hold = useStore.getState().holdPriority;
              send(
                action.intent.t === 'castSpell'
                  ? { ...action.intent, holdPriority: hold }
                  : action.intent,
                viewer,
              );
            }
          }
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') setForceStop(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [viewer, send, setAutoPass, setForceStop, setHold, toggle, cancel]);
}

/** Turns Omniscience mode on automatically, so free casts chain without a pass. */
export function useOmniscienceHold(viewer: PlayerId) {
  const view = useStore((s) => s.views[viewer]);
  const enabled = useStore((s) => s.settings.autoHoldUnderOmniscience);
  const setHold = useStore((s) => s.setHoldPriority);
  const omni = view?.omniscienceActive ?? false;
  useEffect(() => {
    if (enabled) setHold(omni);
  }, [omni, enabled, setHold]);
}
