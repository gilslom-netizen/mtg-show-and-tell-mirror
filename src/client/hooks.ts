import { useEffect, useRef } from 'react';
import type { LegalAction } from '@engine/game';
import type { PlayerView } from '@engine/redact';
import type { IID, PlayerId } from '@engine/types';
import { canAct, useStore, type AutoPassMode } from './store';
import type { Settings } from './settings';

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
    if (view.phase === 'combat') return stops.combat;
    return false;
  }

  if (view.step === 'end_step') {
    if (stops.opponentEndStep === 'never') return false;
    if (stops.opponentEndStep === 'always') return true;
    return canRespond(actions);
  }
  if (view.step === 'upkeep') return stops.opponentUpkeep;
  if (view.phase === 'combat') return stops.combat;
  return false;
}

/**
 * Auto-passes when there is nothing worth stopping for.
 *
 * The delay is randomised inside a fixed window on purpose. If the client passed
 * instantly when it had no answer and slowly when it did, the opponent would read
 * your hand off the clock — a real information leak in other online clients.
 */
export function useAutoPass(viewer: PlayerId) {
  const view = useStore((s) => s.views[viewer]);
  const settings = useStore((s) => s.settings);
  const autoPass = useStore((s) => s.autoPass);
  const forceStop = useStore((s) => s.forceStop);
  const send = useStore((s) => s.send);
  const controls = useStore((s) => s.controls);
  const setAutoPass = useStore((s) => s.setAutoPass);

  // End a "pass until" run when its condition is met.
  useEffect(() => {
    if (!view || autoPass === 'off') return;
    if (autoPass === 'endOfTurn' && view.step === 'untap') setAutoPass('off');
    if (
      autoPass === 'myNextTurn' &&
      view.activePlayer === viewer &&
      view.phase === 'precombat_main'
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
    if (shouldStop(view, settings, autoPass)) return;

    const [lo, hi] = settings.autoPassDelayMs;
    const delay = lo + Math.random() * Math.max(0, hi - lo);
    const t = window.setTimeout(() => send({ t: 'passPriority' }, viewer), delay);
    return () => window.clearTimeout(t);
  });
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
    const source = choice.kind === 'simultaneousSecret' ? undefined : choice.source;
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
      if (policy.bowmasters === 'opponentFace') {
        const opponent: PlayerId = viewer === 'p1' ? 'p2' : 'p1';
        const t = choice.candidates.find((c) => c.kind === 'player' && c.id === opponent);
        if (t) respond({ kind: 'targets', targets: [t] }, viewer);
      }
    }
  }, [view?.choice?.id]); // eslint-disable-line react-hooks/exhaustive-deps
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
