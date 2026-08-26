import { readFileSync } from 'node:fs';
import { MAINDECK } from '../src/engine/deck.js';
import { Game, type Intent } from '../src/engine/game.js';
import { redact } from '../src/engine/redact.js';
import { cardName } from '../src/engine/state.js';
import type { ChoiceResponse, PlayerId } from '../src/engine/types.js';
import type { Agent } from '../src/ai/agent.js';
import { HeuristicAgent } from '../src/ai/heuristic.js';
import { parseArgs } from '../src/ai/args.js';

/**
 * Reading back a game that was actually played.
 *
 * A saved game is `(seed, starting player, action log)`, which is the game rather
 * than a summary of it — so this replays one into the engine and prints what
 * happened, with the hidden information visible, which is exactly what nobody could
 * see at the table.
 *
 * The second half is the useful half. At every decision the computer made, it asks
 * the *current* agent what it would do from the same redacted view, and reports the
 * disagreements. That turns "it played badly" into a list of specific moves, and it
 * says whether a fix since then actually changed the move it was aimed at — which is
 * not something a win rate can tell you.
 */

interface PlayedGame {
  at: number;
  seat: PlayerId;
  opponent: string;
  seed: number;
  startingPlayer: PlayerId;
  winner: PlayerId | 'draw' | null;
  reason: string | null;
  turns: number;
  actions: {
    k: 'intent' | 'choice';
    seat: PlayerId;
    intent?: Intent;
    choiceId?: string;
    response?: ChoiceResponse;
  }[];
}

const args = parseArgs(process.argv.slice(2));
const file = args.file ?? process.argv[2];
if (!file) {
  console.error('usage: npm run ai:review -- --file <games.json> [--game <n>] [--log]');
  process.exit(1);
}

const { games } = JSON.parse(readFileSync(file, 'utf8')) as { games: PlayedGame[] };
const only = args.game ? Number(args.game) : null;
const showLog = args.log === 'true';
const agent: Agent = new HeuristicAgent();

/** A short, readable name for whatever an intent is about. */
function describe(game: Game, intent: Intent): string {
  switch (intent.t) {
    case 'passPriority':
      return 'pass';
    case 'concede':
      return 'concede';
    case 'turnFaceUp':
    case 'playLand':
    case 'castSpell':
    case 'activateAbility':
    case 'tapForMana': {
      const card = game.state.cards[intent.iid];
      const name = card ? cardName(card) : `#${intent.iid}`;
      if (intent.t === 'castSpell') return `cast ${name}${intent.free ? ' (free)' : ''}`;
      if (intent.t === 'playLand') return `play ${name}`;
      if (intent.t === 'tapForMana') return `tap ${name}`;
      if (intent.t === 'turnFaceUp') return `turn ${name} face up`;
      return `activate ${name}`;
    }
  }
}

let gameNumber = 0;
for (const played of games) {
  gameNumber++;
  if (only !== null && gameNumber !== only) continue;

  const game = Game.create({
    gameId: `review-${played.seed}`,
    seed: played.seed,
    deck: MAINDECK,
    startingPlayer: played.startingPlayer,
  });
  game.advance();

  const you = played.seat;
  const bot: PlayerId = you === 'p1' ? 'p2' : 'p1';

  console.log('');
  console.log('='.repeat(78));
  console.log(
    `Game ${gameNumber} — seed ${played.seed}, ${played.startingPlayer} on the play, ` +
      `${played.winner === you ? 'you won' : 'the computer won'} on turn ${played.turns} (${played.reason})`,
  );
  console.log('='.repeat(78));

  const disagreements: string[] = [];
  let botDecisions = 0;

  for (const a of played.actions) {
    // Before the computer's own moves, ask today's agent the same question.
    if (a.seat === bot) {
      const view = redact(game.state, bot);
      try {
        if (a.k === 'intent' && a.intent && !view.choice) {
          botDecisions++;
          const now = agent.act(view, 250);
          if (JSON.stringify(now) !== JSON.stringify(a.intent)) {
            disagreements.push(
              `  turn ${game.state.turn} ${game.state.phase}/${game.state.step}: ` +
                `played "${describe(game, a.intent)}", now would "${describe(game, now)}"`,
            );
          }
        } else if (a.k === 'choice' && a.response && view.choice) {
          botDecisions++;
          const now = agent.respond(view, view.choice, 250);
          if (JSON.stringify(now) !== JSON.stringify(a.response)) {
            disagreements.push(
              `  turn ${game.state.turn} ${view.choice.kind}` +
                `${'source' in view.choice && view.choice.source ? ` (${view.choice.source.oracleId})` : ''}: ` +
                `answered ${JSON.stringify(a.response)}, now ${JSON.stringify(now)}`,
            );
          }
        }
      } catch {
        // A view the agent cannot answer is itself worth nothing here; the replay
        // is the authority and it carries on.
      }
    }

    try {
      if (a.k === 'intent' && a.intent) game.submitIntent(a.seat, a.intent);
      else if (a.k === 'choice' && a.response) {
        /*
         * Answer whatever question is actually open, rather than insisting on the
         * id the log carries.
         *
         * The id is an implementation detail; what the log means is "this is the
         * answer that was given to the question that was open here". Logs recorded
         * before the choice counter moved into the state have ids one ahead of a
         * clean replay wherever Esc was used, and a forensic tool should be able to
         * read a game that was played by an older build.
         */
        const open = game.state.pendingChoice;
        game.submitChoice(a.seat, open?.id ?? a.choiceId ?? '', a.response);
      }
    } catch (e) {
      const st = game.state;
      const open = st.pendingChoice;
      console.log(`  !! could not replay: ${(e as Error).message}`);
      console.log(
        `     at action #${played.actions.indexOf(a)} of ${played.actions.length}: ` +
          `${a.seat} ${a.k} ${JSON.stringify(a.intent ?? a.response)}`,
      );
      console.log(
        `     engine is on turn ${st.turn} ${st.phase}/${st.step}, priority ${st.priorityPlayer}, ` +
          `open choice ${open ? `${open.kind}(${open.id}) for ${'player' in open ? open.player : 'both'}` : 'none'}`,
      );
      if (open && 'prompt' in open) console.log(`     prompt: ${open.prompt}`);
      if (open && 'source' in open && open.source) {
        console.log(`     raised by: ${open.source.oracleId}`);
      }
      console.log('     last few log lines:');
      for (const line of st.log.slice(-6)) {
        console.log(`       t${line.turn} ${line.player ?? '  '} ${line.text}`);
      }
      break;
    }
  }

  const s = game.state;
  console.log('');
  console.log(`Final: you ${s.players[you].life} life, computer ${s.players[bot].life} life`);
  console.log(
    `  your board:     ${s.zones[you].battlefield.map((i) => cardName(s.cards[i])).join(', ') || '(empty)'}`,
  );
  console.log(
    `  computer board: ${s.zones[bot].battlefield.map((i) => cardName(s.cards[i])).join(', ') || '(empty)'}`,
  );
  console.log(
    `  computer hand at the end: ${
      s.zones[bot].hand.map((i) => cardName(s.cards[i])).join(', ') || '(empty)'
    }`,
  );

  console.log('');
  console.log(`Computer decisions: ${botDecisions}. Today's agent would differ on ${disagreements.length}:`);
  for (const d of disagreements.slice(0, 40)) console.log(d);
  if (disagreements.length > 40) console.log(`  … and ${disagreements.length - 40} more`);

  if (showLog) {
    console.log('');
    console.log('Full game log:');
    for (const line of s.log) {
      console.log(`  t${line.turn} ${line.player ?? '  '} ${line.text}`);
    }
  }
}
