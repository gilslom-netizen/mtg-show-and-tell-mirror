import { Game } from '../game.js';
import { MAINDECK } from '../deck.js';
import { nextInt, seedRng, type RngState } from '../rng.js';
import type { ChoiceResponse, GameState, IID, PlayerId } from '../types.js';

/**
 * A bot that plays only legal moves, chosen at random from its own seeded PRNG.
 *
 * Used for fuzzing and for the determinism check. It never reads hidden state it
 * should not have — it goes through the same legalActions/pendingChoice surface a
 * real client does.
 */

export interface BotResult {
  game: Game;
  steps: number;
  finished: boolean;
}

export class RandomBot {
  private rng: RngState;

  constructor(seed: number) {
    this.rng = seedRng(seed);
  }

  private pick<T>(arr: T[]): T {
    return arr[nextInt(this.rng, arr.length)];
  }

  private randomInt(n: number): number {
    return nextInt(this.rng, n);
  }

  private answer(game: Game): void {
    const s = game.state;
    const c = s.pendingChoice;
    if (!c) return;

    if (c.kind === 'simultaneousSecret') {
      for (const p of [...c.awaiting]) {
        const selectable = c.requests[p].options.filter((o) => !o.disabledReason);
        // Take a permanent about two thirds of the time.
        const iid =
          selectable.length > 0 && this.randomInt(3) > 0
            ? this.pick(selectable).iid
            : null;
        game.submitChoice(p, c.id, { kind: 'secret', iid });
      }
      return;
    }

    const player = c.player;
    let response: ChoiceResponse;
    switch (c.kind) {
      case 'chooseCards': {
        const selectable = c.options.filter((o) => !o.disabledReason).map((o) => o.iid);
        const n = c.min + this.randomInt(Math.max(1, c.max - c.min + 1));
        response = { kind: 'cards', iids: shuffleWith(this.rng, selectable).slice(0, Math.min(n, selectable.length)) };
        break;
      }
      case 'chooseTargets':
        response = {
          kind: 'targets',
          targets:
            c.optional && this.randomInt(2) === 0
              ? []
              : shuffleWith(this.rng, [...c.candidates]).slice(0, c.count),
        };
        break;
      case 'chooseMode': {
        const enabled = c.modes.filter((m) => m.enabled).map((m) => m.index);
        const n = c.min + this.randomInt(Math.max(1, c.max - c.min + 1));
        response = { kind: 'modes', modes: shuffleWith(this.rng, enabled).slice(0, Math.min(n, enabled.length)) };
        break;
      }
      case 'yesNo':
        response = { kind: 'yesNo', value: this.randomInt(2) === 0 };
        break;
      case 'mulligan':
        // Keep most hands, so games actually get played.
        response = { kind: 'yesNo', value: this.randomInt(5) > 0 };
        break;
      case 'orderTriggers':
        response = { kind: 'order', ids: shuffleWith(this.rng, c.triggers.map((t) => t.id)) };
        break;
      case 'declareAttackers': {
        const attackers = c.candidates.filter(() => this.randomInt(2) === 0);
        response = { kind: 'attackers', iids: attackers };
        break;
      }
      case 'declareBlockers': {
        const blocks: { blocker: IID; attacker: IID }[] = [];
        for (const b of c.blockers) {
          if (this.randomInt(2) === 0) continue;
          blocks.push({ blocker: b, attacker: this.pick(c.attackers) });
        }
        response = { kind: 'blockers', blocks };
        break;
      }
      case 'distributeDamage': {
        const assignment: Record<IID, number> = {};
        assignment[c.blockers[0]] = c.total;
        response = { kind: 'damage', assignment };
        break;
      }
    }
    game.submitChoice(player, c.id, response!);
  }

  /** Plays until the game ends or the step budget runs out. */
  play(game: Game, maxSteps = 3000): BotResult {
    let steps = 0;
    game.advance();
    while (game.state.winner === null && steps < maxSteps) {
      steps++;
      if (game.state.pendingChoice) {
        this.answer(game);
        continue;
      }
      const p = game.state.priorityPlayer;
      if (p === null) {
        game.advance();
        continue;
      }
      const actions = game.legalActions(p);
      // Heavily bias towards passing so games progress instead of tapping lands
      // back and forth forever.
      const meaningful = actions.filter((a) => !a.isManaAbility);
      if (meaningful.length === 0 || this.randomInt(3) === 0) {
        game.submitIntent(p, { t: 'passPriority' });
      } else {
        game.submitIntent(p, this.pick(meaningful).intent);
      }
    }
    return { game, steps, finished: game.state.winner !== null };
  }
}

function shuffleWith<T>(rng: RngState, arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function newGame(seed: number, startingPlayer: PlayerId = 'p1'): Game {
  return Game.create({
    gameId: `fuzz-${seed}`,
    seed,
    deck: MAINDECK,
    startingPlayer,
  });
}

/** A stable fingerprint of everything that matters about a finished game. */
export function stateHash(s: GameState): string {
  const parts: string[] = [
    String(s.turn),
    s.activePlayer,
    s.phase,
    s.step,
    String(s.winner),
    String(s.endReason),
  ];
  for (const p of ['p1', 'p2'] as PlayerId[]) {
    parts.push(p, String(s.players[p].life));
    for (const zone of ['library', 'hand', 'battlefield', 'graveyard', 'exile'] as const) {
      parts.push(zone + ':' + s.zones[p][zone].map((i) => s.cards[i]?.oracleId ?? '?').join('|'));
    }
  }
  return parts.join('/');
}
