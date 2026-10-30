import { useEffect, useState } from 'react';
import type { DifficultyConfig, GameConfig } from '../../../shared/types';
import { useAdmin } from './ctx';

type Field<T> = { k: keyof T; label: string; type: 'num' | 'bool' | 'text' | 'select' | 'numnull'; opts?: [string, string][]; hint?: string };

const GROUPS: [string, Field<GameConfig>[]][] = [
  [
    'Timing',
    [
      { k: 'eventName', label: 'Event name', type: 'text' },
      { k: 'roundMinutes', label: 'Round length (minutes, K)', type: 'num', hint: 'Applies from the next round; use the game tab to change the current one' },
      { k: 'transitionSeconds', label: 'Move time between rounds (s)', type: 'num' },
      { k: 'totalRounds', label: 'Total rounds (blank = unlimited)', type: 'numnull' },
      { k: 'autoAdvance', label: 'Auto-start next round after move time', type: 'bool' },
    ],
  ],
  [
    'Rotation',
    [
      { k: 'lazyMode', label: 'Lazy mode (rotate problems, not people)', type: 'bool' },
      { k: 'lazyTransitionSeconds', label: 'Lazy mode lock time (s, 0 = instant)', type: 'num' },
      { k: 'rotationDirection', label: 'Direction', type: 'select', opts: [['1', 'Next computer (seat i → i+1)'], ['-1', 'Previous computer (seat i → i−1)']] },
      { k: 'maxRoundsPerProblem', label: 'Rounds before an unsolved problem is replaced (blank = team size)', type: 'numnull', hint: 'Capped at team size so nobody sees a problem twice' },
      { k: 'uniqueness', label: 'Never reuse a problem within', type: 'select', opts: [['team', 'a team'], ['global', 'the whole event']] },
    ],
  ],
  [
    'Judging & scoring',
    [
      { k: 'judgeMode', label: 'Judge', type: 'select', opts: [['codeforces', 'Codeforces (forwarded)'], ['local', 'Local (isolate: samples + tests)'], ['manual', 'Manual (admin decides)'], ['auto-accept', 'Auto-accept (testing)']] },
      { k: 'scoring', label: 'Scoring', type: 'select', opts: [['rating', 'Sum of solved ratings'], ['count', 'Number solved']] },
      { k: 'wrongSubmissionPenalty', label: 'Penalty per wrong submission on a solved problem', type: 'num' },
      { k: 'submissionCooldownSeconds', label: 'Submission cooldown (s)', type: 'num' },
      { k: 'maxSubmissionsPerProblem', label: 'Max submissions per problem (blank = unlimited)', type: 'numnull' },
    ],
  ],
  [
    'Sandbox (isolate)',
    [
      { k: 'allowLocalRun', label: 'Allow local Run on custom input', type: 'bool' },
      { k: 'runTimeLimitMs', label: 'Run time limit (ms)', type: 'num' },
      { k: 'runMemoryMb', label: 'Run memory limit (MB)', type: 'num' },
      { k: 'compileTimeLimitMs', label: 'Compile time limit (ms)', type: 'num' },
      { k: 'maxConcurrentRuns', label: 'Maximum concurrent runs', type: 'num' },
      { k: 'isolateBoxBase', label: 'First isolate box id', type: 'num' },
      { k: 'outputLimitKb', label: 'Run display output limit (KB)', type: 'num' },
      { k: 'maxOutputMb', label: 'Maximum output/file size (MB)', type: 'num' },
    ],
  ],
  [
    'Client',
    [
      { k: 'allowSampleLoad', label: 'Sample load buttons', type: 'bool' },
      { k: 'allowLanguageSwitch', label: 'Allow switching language', type: 'bool' },
      { k: 'showRatingToClients', label: 'Show problem rating', type: 'bool' },
      { k: 'showTagsToClients', label: 'Show problem tags', type: 'bool' },
      { k: 'showRoundsLeftToClients', label: 'Show rounds left for the problem', type: 'bool' },
      { k: 'showScoreboardToClients', label: 'Public scoreboard (clients + /scoreboard)', type: 'bool' },
      { k: 'freezeScoreboard', label: 'Freeze scoreboard', type: 'bool' },
      { k: 'clientEditorFontSize', label: 'Editor font size', type: 'num' },
    ],
  ],
];

const DIFF: Field<DifficultyConfig>[] = [
  { k: 'startRating', label: 'Start rating', type: 'num' },
  { k: 'minRating', label: 'Min rating', type: 'num' },
  { k: 'maxRating', label: 'Max rating', type: 'num' },
  { k: 'step', label: 'Rating step', type: 'num' },
  { k: 'scope', label: 'Track difficulty per', type: 'select', opts: [['slot', 'computer slot'], ['team', 'team']] },
  { k: 'slowSolveDelta', label: 'Δ solved slower than all rules', type: 'num' },
  { k: 'unsolvedDelta', label: 'Δ unsolved (expired)', type: 'num' },
  { k: 'skippedDelta', label: 'Δ replaced by admin', type: 'num' },
  { k: 'fallback', label: 'If no problem at target rating', type: 'select', opts: [['nearest', 'nearest rating'], ['lower', 'lower first'], ['higher', 'higher first']] },
];

function Input<T>({ f, v, set }: { f: Field<T>; v: unknown; set: (x: unknown) => void }) {
  if (f.type === 'bool')
    return (
      <label className="field inline">
        <input type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} />
        {f.label}
      </label>
    );
  return (
    <label className="field" title={f.hint}>
      {f.label}
      {f.type === 'select' ? (
        <select value={String(v)} onChange={(e) => set(/^-?\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value)}>
          {f.opts!.map(([a, b]) => (
            <option key={a} value={a}>
              {b}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={v == null ? '' : String(v)}
          onChange={(e) => {
            const t = e.target.value;
            if (f.type === 'text') set(t);
            else if (t === '' && f.type === 'numnull') set(null);
            else set(t === '' || t === '-' ? t : isNaN(Number(t)) ? v : t.endsWith('.') ? t : Number(t));
          }}
        />
      )}
      {f.hint && <span className="hint">{f.hint}</span>}
    </label>
  );
}

export default function SettingsTab() {
  const { s, act } = useAdmin();
  const [c, setC] = useState<GameConfig>(s.config);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setC(s.config);
  }, [s.config, dirty]);
  const set = (k: keyof GameConfig, v: unknown) => (setC({ ...c, [k]: v }), setDirty(true));
  const setD = (k: keyof DifficultyConfig, v: unknown) => (setC({ ...c, difficulty: { ...c.difficulty, [k]: v } }), setDirty(true));
  const rules = c.difficulty.solvedRules;
  const setRules = (r: typeof rules) => setD('solvedRules', r);
  const save = () =>
    act('PUT', '/config', {
      ...c,
      difficulty: { ...c.difficulty, solvedRules: [...rules].map((r) => ({ maxMinutes: Number(r.maxMinutes), delta: Number(r.delta) })).sort((a, b) => a.maxMinutes - b.maxMinutes) },
    })
      .then(() => setDirty(false))
      .catch(() => {});

  return (
    <div>
      <div className="row section" style={{ position: 'sticky', top: -16, background: 'var(--bg)', padding: '8px 0', zIndex: 5 }}>
        <button className="primary" disabled={!dirty} onClick={save}>
          Save settings
        </button>
        <button disabled={!dirty} onClick={() => (setC(s.config), setDirty(false))}>
          Discard
        </button>
        {dirty && <span className="badge warn">unsaved changes</span>}
      </div>
      {GROUPS.map(([g, fields]) => (
        <div key={g} className="section">
          <h3>{g}</h3>
          <div className="form-grid">
            {fields.map((f) => (
              <Input key={String(f.k)} f={f} v={c[f.k]} set={(v) => set(f.k, v)} />
            ))}
          </div>
        </div>
      ))}
      <div className="section">
        <h3>Dynamic difficulty</h3>
        <div className="form-grid">
          {DIFF.map((f) => (
            <Input key={String(f.k)} f={f} v={c.difficulty[f.k]} set={(v) => setD(f.k, v)} />
          ))}
        </div>
        <div className="col" style={{ marginTop: 12, maxWidth: 520 }}>
          <div className="row">
            <b>Solve-time rules</b>
            <span className="hint">first matching row wins; minutes = active time the problem was open</span>
            <button className="small" onClick={() => setRules([...rules, { maxMinutes: 30, delta: 0 }])}>
              + rule
            </button>
          </div>
          {rules.map((r, i) => (
            <div key={i} className="row">
              solved within
              <input style={{ width: 70 }} value={r.maxMinutes} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, maxMinutes: e.target.value as unknown as number } : x)))} />
              min → rating
              <input style={{ width: 70 }} value={r.delta} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, delta: e.target.value as unknown as number } : x)))} />
              <button className="small danger" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <div className="hint">
            Example: solved in {rules[0]?.maxMinutes ?? '?'} min → {rules[0] ? (rules[0].delta >= 0 ? '+' : '') + rules[0].delta : '?'}; slower → {c.difficulty.slowSolveDelta}; not solved after the
            rotation limit → {c.difficulty.unsolvedDelta}.
          </div>
        </div>
      </div>
    </div>
  );
}
