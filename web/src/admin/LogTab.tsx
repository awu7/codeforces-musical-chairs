import { useState } from 'react';
import { download } from '../lib/api';
import { useAdmin } from './ctx';

export default function LogTab() {
  const { s, act } = useAdmin();
  const [lvl, setLvl] = useState('');
  const rows = [...s.log].reverse().filter((l) => !lvl || l.level === lvl);
  return (
    <div>
      <div className="section">
        <h3>Data</h3>
        <div className="row">
          <button onClick={() => download('/admin/export/results.csv', 'results.csv').catch(() => {})}>Download results CSV</button>
          <button onClick={() => download('/admin/export/state.json', 'state.json').catch(() => {})}>Download full state</button>
          <label className="field inline" style={{ cursor: 'pointer' }}>
            <span className="badge">Restore state from file…</span>
            <input
              type="file"
              hidden
              accept="application/json"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f || !confirm('Replace the entire server state with this file?')) return;
                act('POST', '/import/state', JSON.parse(await f.text())).catch(() => {});
                e.target.value = '';
              }}
            />
          </label>
          <a href="/scoreboard" target="_blank">
            Open scoreboard
          </a>
          <span className="spacer" />
          <button className="danger" onClick={() => confirm('Reset game AND delete all teams?') && act('POST', '/game/reset', { keepTeams: false, keepPool: true }).catch(() => {})}>
            Reset game + teams
          </button>
          <button className="danger" onClick={() => confirm('Reset EVERYTHING including the problem pool?') && act('POST', '/game/reset', { keepTeams: false, keepPool: false }).catch(() => {})}>
            Factory reset
          </button>
        </div>
      </div>
      <div className="section">
        <h3>Event log</h3>
        <div className="row" style={{ marginBottom: 8 }}>
          <select value={lvl} onChange={(e) => setLvl(e.target.value)}>
            <option value="">All</option>
            <option value="info">Info</option>
            <option value="warn">Warnings</option>
            <option value="error">Errors</option>
          </select>
        </div>
        <div className="log">
          {rows.map((l, i) => (
            <div key={i} className={l.level}>
              <span className="muted">{new Date(l.t).toLocaleTimeString()}</span> {l.msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
