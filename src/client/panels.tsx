import { useStore } from './store';
import type { CombatStopMode, StopMode } from './settings';

/** Settings and the shortcut sheet. */

export function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const toggle = useStore((s) => s.toggle);
  const stops = settings.stops;

  const setStop = (patch: Partial<typeof stops>) => update({ stops: { ...stops, ...patch } });

  return (
    <div className="overlay" onClick={() => toggle('settingsOpen')}>
      <div className="dialog" style={{ minWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <h3 style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
          WHEN TO STOP
        </h3>
        <div className="setting-row">
          <div>
            Stop in my own main phase
            <div className="desc">Otherwise your turn flies past unless something forces a stop.</div>
          </div>
          <input
            type="checkbox"
            checked={stops.myMainPhase}
            onChange={(e) => setStop({ myMainPhase: e.target.checked })}
          />
        </div>
        <div className="setting-row">
          <div>
            Opposing spell on the stack
            <div className="desc">
              &ldquo;Only if I can answer&rdquo; is the setting that removes most of the
              clicking in this matchup.
            </div>
          </div>
          <StopSelect
            value={stops.opponentSpellOnStack}
            onChange={(v) => setStop({ opponentSpellOnStack: v })}
          />
        </div>
        <div className="setting-row">
          <div>
            Their end step
            <div className="desc">Where Borne Upon a Wind and flash creatures live.</div>
          </div>
          <StopSelect
            value={stops.opponentEndStep}
            onChange={(v) => setStop({ opponentEndStep: v })}
          />
        </div>
        <div className="setting-row">
          <div>
            Combat steps
            <div className="desc">
              &ldquo;Only if combat matters&rdquo; passes straight from the beginning of
              combat to your second main phase on the turns — most of them — where
              nobody has a creature that could attack.
            </div>
          </div>
          <select
            value={stops.combat}
            onChange={(e) => setStop({ combat: e.target.value as CombatStopMode })}
          >
            <option value="always">always stop</option>
            <option value="ifRelevant">only if combat matters</option>
            <option value="never">never stop</option>
          </select>
        </div>
        <div className="setting-row">
          <div>Their upkeep</div>
          <input
            type="checkbox"
            checked={stops.opponentUpkeep}
            onChange={(e) => setStop({ opponentUpkeep: e.target.checked })}
          />
        </div>

        <h3 style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>COMFORT</h3>
        <div className="setting-row">
          <div>
            Hold priority automatically under Omniscience
            <div className="desc">
              Off by default: an Omniscience turn is mostly ordinary spells, and holding
              for all of them turns each one into a click. <kbd>H</kbd> holds priority
              the moment you actually want to chain.
            </div>
          </div>
          <input
            type="checkbox"
            checked={settings.autoHoldUnderOmniscience}
            onChange={(e) => update({ autoHoldUnderOmniscience: e.target.checked })}
          />
        </div>
        <div className="setting-row">
          <div>
            Warn before losing floating mana
            <div className="desc">Mana Drain mana is usually the whole turn.</div>
          </div>
          <input
            type="checkbox"
            checked={settings.warnOnFloatingMana}
            onChange={(e) => update({ warnOnFloatingMana: e.target.checked })}
          />
        </div>
        <div className="setting-row">
          <div>Show card art</div>
          <input
            type="checkbox"
            checked={settings.showCardArt}
            onChange={(e) => update({ showCardArt: e.target.checked })}
          />
        </div>
        <div className="setting-row">
          <div>
            Card size
            <div className="desc">
              Everything on the table scales with this. Also on the keyboard:
              <kbd>+</kbd> and <kbd>−</kbd>.
            </div>
          </div>
          <select
            value={String(settings.cardScale)}
            onChange={(e) => update({ cardScale: Number(e.target.value) })}
          >
            <option value="0.85">Compact</option>
            <option value="1">Normal</option>
            <option value="1.2">Large</option>
            <option value="1.45">Extra large</option>
          </select>
        </div>
        <div className="setting-row">
          <div>
            Animation speed
            <div className="desc">0 turns animation off entirely.</div>
          </div>
          <input
            type="number"
            min={0}
            max={600}
            step={20}
            value={settings.animationMs}
            onChange={(e) => update({ animationMs: Number(e.target.value) })}
          />
        </div>
        <div className="setting-row">
          <div>
            Auto-pass delay (ms)
            <div className="desc">
              Randomised inside this window so your timing never tells the opponent
              whether you held an answer.
            </div>
          </div>
          <span className="row">
            <input
              type="number"
              min={0}
              max={2000}
              step={50}
              value={settings.autoPassDelayMs[0]}
              onChange={(e) =>
                update({ autoPassDelayMs: [Number(e.target.value), settings.autoPassDelayMs[1]] })
              }
              style={{ width: 76 }}
            />
            <input
              type="number"
              min={0}
              max={3000}
              step={50}
              value={settings.autoPassDelayMs[1]}
              onChange={(e) =>
                update({ autoPassDelayMs: [settings.autoPassDelayMs[0], Number(e.target.value)] })
              }
              style={{ width: 76 }}
            />
          </span>
        </div>

        <div className="actions">
          <button className="primary" onClick={() => toggle('settingsOpen')}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function StopSelect({ value, onChange }: { value: StopMode; onChange: (v: StopMode) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as StopMode)}>
      <option value="always">always stop</option>
      <option value="ifIHaveAnswer">only if I can answer</option>
      <option value="never">never stop</option>
    </select>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Space / F2', 'Pass priority once'],
  ['F6', 'Pass until end of turn'],
  ['F8', 'Pass until my next turn'],
  ['Hold Ctrl', 'Force a stop at the next priority'],
  ['H', 'Toggle hold priority'],
  ['1 – 9', 'Cast or play the nth card in hand'],
  ['Shift + click', 'Show the other ways to play a card (e.g. pay mana under Omniscience)'],
  ['Hold Alt', 'Ignore the trigger policy for the next prompt'],
  ['B', 'Put the open decision aside to look at the board, and bring it back'],
  ['⟳ chip', 'Appears once you repeat something — offers to do it again N times'],
  ['Esc', 'Back out of the current action'],
  ['L', 'Toggle the log panel'],
  [',', 'Settings'],
  ['?', 'This list'],
];

export function HelpPanel() {
  const toggle = useStore((s) => s.toggle);
  return (
    <div className="overlay" onClick={() => toggle('helpOpen')}>
      <div className="dialog" style={{ minWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <div>
          {SHORTCUTS.map(([key, what]) => (
            <div className="setting-row" key={key}>
              <span>{what}</span>
              <kbd>{key}</kbd>
            </div>
          ))}
        </div>
        <div className="prompt">
          Every shortcut also exists as a button, so nothing is hidden behind the
          keyboard. The lines between the boards, beside the log and above your hand
          are all draggable — double click one to put it back.
        </div>
        <div className="actions">
          <button className="primary" onClick={() => toggle('helpOpen')}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
