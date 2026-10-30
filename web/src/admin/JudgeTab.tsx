import { useEffect, useState } from 'react';
import type { Language } from '../../../shared/types';
import { useAdmin } from './ctx';

export default function JudgeTab() {
  const { s, act } = useAdmin();
  const [h, setH] = useState('');
  const [pw, setPw] = useState('');
  const [mode, setMode] = useState(s.cfBridge.mode);
  const [cdp, setCdp] = useState(s.cfBridge.cdpUrl ?? '');
  const b = s.cfBridge;
  return (
    <div>
      <div className="section">
        <h3>Codeforces bridge</h3>
        <div className="row">
          <span className={`badge ${b.connected ? 'good' : 'bad'}`}>{b.connected ? 'browser connected' : 'browser not connected'}</span>
          <span className="muted">queue: {b.queueLength}</span>
          {b.lastError && <span className="error">{b.lastError}</span>}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="cdp">Connect to running Chrome (CDP)</option>
            <option value="launch">Launch Chrome</option>
          </select>
          {mode === 'cdp' && <input style={{ width: 260 }} placeholder="http://localhost:9222" value={cdp} onChange={(e) => setCdp(e.target.value)} />}
          <button onClick={() => act('PUT', '/cf/bridge', { mode, cdpUrl: cdp || null }).catch(() => {})}>Apply</button>
          <button onClick={() => act('POST', '/cf/bridge/restart', {}).catch(() => {})}>Restart bridge</button>
        </div>
        <div className="hint" style={{ marginTop: 4 }}>
          Codeforces sits behind Cloudflare, so statements and submissions go through a real Chrome. Start one with <code>google-chrome --remote-debugging-port=9222</code> or let the server
          launch it.
        </div>
      </div>
      <div className="section">
        <h3>Submitter accounts</h3>
        <div className="row">
          <input placeholder="CF handle" value={h} onChange={(e) => setH(e.target.value)} />
          <input placeholder="password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <button
            className="primary"
            disabled={!h || !pw}
            onClick={() =>
              act('POST', '/cf/accounts', { handle: h, password: pw })
                .then(() => (setH(''), setPw('')))
                .catch(() => {})
            }
          >
            Add account
          </button>
          <span className="hint">Accounts are used round-robin, one submission at a time each.</span>
        </div>
        <table className="table" style={{ marginTop: 8, maxWidth: 900 }}>
          <thead>
            <tr>
              <th>Handle</th>
              <th>Status</th>
              <th>Submissions</th>
              <th>Last used</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {s.cfAccounts.map((a) => (
              <tr key={a.handle}>
                <td>
                  <a href={`https://codeforces.com/profile/${a.handle}`} target="_blank" rel="noreferrer">
                    {a.handle}
                  </a>
                </td>
                <td>
                  <span className={`badge ${a.status === 'ready' ? 'good' : a.status === 'error' ? 'bad' : ''}`}>{a.status}</span> <span className="error">{a.lastError}</span>
                </td>
                <td>{a.submissions}</td>
                <td className="muted">{a.lastUsedAt ? new Date(a.lastUsedAt).toLocaleTimeString() : ''}</td>
                <td>
                  <input type="checkbox" checked={a.enabled} onChange={(e) => act('PUT', `/cf/accounts/${a.handle}`, { enabled: e.target.checked }).catch(() => {})} />
                </td>
                <td className="row">
                  <button className="small" onClick={() => act('POST', `/cf/accounts/${a.handle}/login`, {}).catch(() => {})}>
                    Test login
                  </button>
                  <button className="small danger" onClick={() => confirm(`Remove ${a.handle}?`) && act('DELETE', `/cf/accounts/${a.handle}`).catch(() => {})}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!s.cfAccounts.length && <div className="muted">No accounts. Codeforces judging needs at least one.</div>}
      </div>
      <Languages />
    </div>
  );
}

function Languages() {
  const { s, act } = useAdmin();
  const [ls, setLs] = useState<Language[]>(s.languages);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setLs(s.languages);
  }, [s.languages, dirty]);
  const upd = (i: number, p: Partial<Language>) => (setLs(ls.map((l, j) => (j === i ? { ...l, ...p } : l))), setDirty(true));
  const argv = (a?: string[]) => (a ? a.join(' ') : '');
  const parse = (t: string) => (t.trim() ? t.trim().split(/\s+/) : undefined);
  return (
    <div className="section">
      <h3>Languages</h3>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="primary" disabled={!dirty} onClick={() => act('PUT', '/languages', ls).then(() => setDirty(false)).catch(() => {})}>
          Save languages
        </button>
        <button
          onClick={() => {
            setLs([...ls, { id: 'new', name: 'New language', monaco: 'plaintext', cfProgramTypeId: 0, srcFile: 'main.txt', run: [], template: '', enabled: false }]);
            setDirty(true);
          }}
        >
          + language
        </button>
        <span className="hint">
          Placeholders: {'{src}'} {'{dir}'} {'{mem}'}. CF program type ids are the values of the language dropdown on the Codeforces submit page.
        </span>
      </div>
      <div className="col">
        {ls.map((l, i) => (
          <div key={i} className="card">
            <div className="form-grid">
              <label className="field">
                Id
                <input value={l.id} onChange={(e) => upd(i, { id: e.target.value })} />
              </label>
              <label className="field">
                Name
                <input value={l.name} onChange={(e) => upd(i, { name: e.target.value })} />
              </label>
              <label className="field">
                Monaco language
                <input value={l.monaco} onChange={(e) => upd(i, { monaco: e.target.value })} />
              </label>
              <label className="field">
                CF programTypeId
                <input value={l.cfProgramTypeId} onChange={(e) => upd(i, { cfProgramTypeId: Number(e.target.value) || 0 })} />
              </label>
              <label className="field">
                Source file
                <input value={l.srcFile} onChange={(e) => upd(i, { srcFile: e.target.value })} />
              </label>
              <label className="field inline">
                <input type="checkbox" checked={l.enabled} onChange={(e) => upd(i, { enabled: e.target.checked })} /> enabled
              </label>
            </div>
            <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 8 }}>
              <label className="field">
                Compile command
                <input className="mono" defaultValue={argv(l.compile)} onBlur={(e) => upd(i, { compile: parse(e.target.value) })} />
              </label>
              <label className="field">
                Run command
                <input className="mono" defaultValue={argv(l.run)} onBlur={(e) => upd(i, { run: parse(e.target.value) ?? [] })} />
              </label>
            </div>
            <label className="field" style={{ marginTop: 8 }}>
              Template
              <textarea className="mono" rows={5} value={l.template} onChange={(e) => upd(i, { template: e.target.value })} />
            </label>
            <div className="row" style={{ marginTop: 6 }}>
              <span className="spacer" />
              <button className="small danger" onClick={() => (setLs(ls.filter((_, j) => j !== i)), setDirty(true))}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
