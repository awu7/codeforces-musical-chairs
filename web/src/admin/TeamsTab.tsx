import { useState } from 'react';
import type { Team } from '../../../shared/types';
import { useAdmin } from './ctx';

export default function TeamsTab() {
  const { s, act } = useAdmin();
  const [name, setName] = useState('');
  const [size, setSize] = useState('3');
  const [bulk, setBulk] = useState({ count: '4', size: '3', prefix: 'Team ' });
  const [sheet, setSheet] = useState(false);
  const setup = s.clock.phase === 'setup';

  if (sheet)
    return (
      <div>
        <div className="row no-print section">
          <button onClick={() => setSheet(false)}>Back</button>
          <button className="primary" onClick={() => print()}>
            Print
          </button>
          <span className="muted">Seat codes. Open the client at {location.origin}/ and enter the code, or use the link.</span>
        </div>
        {s.teams.map((t) => (
          <div key={t.id} className="section">
            <h3>{t.name}</h3>
            <div className="code-sheet">
              {t.seats.map((x) => (
                <div key={x.index} className="c">
                  <div>{x.label}</div>
                  <div className="code">{x.code}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {location.origin}/?code={x.code}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );

  return (
    <div>
      <div className="section">
        <h3>Create teams</h3>
        <div className="row">
          <input placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} />
          <input type="number" min={1} style={{ width: 70 }} value={size} onChange={(e) => setSize(e.target.value)} />
          <span className="muted">people</span>
          <button className="primary" disabled={!name} onClick={() => act('POST', '/teams', { name, size: Number(size) }).then(() => setName('')).catch(() => {})}>
            Add team
          </button>
          <span style={{ width: 30 }} />
          <span className="muted">Bulk:</span>
          <input type="number" min={1} style={{ width: 60 }} value={bulk.count} onChange={(e) => setBulk({ ...bulk, count: e.target.value })} />
          <span className="muted">teams of</span>
          <input type="number" min={1} style={{ width: 60 }} value={bulk.size} onChange={(e) => setBulk({ ...bulk, size: e.target.value })} />
          <span className="muted">prefix</span>
          <input style={{ width: 100 }} value={bulk.prefix} onChange={(e) => setBulk({ ...bulk, prefix: e.target.value })} />
          <button onClick={() => act('POST', '/teams/bulk', { count: Number(bulk.count), size: Number(bulk.size), prefix: bulk.prefix }).catch(() => {})}>Create</button>
          <span className="spacer" />
          <button onClick={() => setSheet(true)}>Seat code sheet</button>
        </div>
        {!setup && <div className="hint">Team sizes can only be changed during setup.</div>}
      </div>
      <div className="col">
        {s.teams.map((t) => (
          <TeamRow key={t.id} t={t} setup={setup} />
        ))}
      </div>
    </div>
  );
}

function TeamRow({ t, setup }: { t: Team; setup: boolean }) {
  const { act } = useAdmin();
  const [name, setName] = useState(t.name);
  const [size, setSize] = useState(String(t.size));
  const [start, setStart] = useState(t.startRating == null ? '' : String(t.startRating));
  const [rating, setRating] = useState(String(t.rating));
  const put = (b: unknown) => act('PUT', `/teams/${t.id}`, b).catch(() => {});
  return (
    <div className="team-card">
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== t.name && put({ name })} style={{ fontWeight: 600 }} />
        <label className="field inline">
          size
          <input type="number" min={1} disabled={!setup} style={{ width: 60 }} value={size} onChange={(e) => setSize(e.target.value)} onBlur={() => Number(size) !== t.size && put({ size: Number(size) })} />
        </label>
        <label className="field inline" title="Overrides the global start rating for this team">
          start rating
          <input style={{ width: 80 }} placeholder="default" value={start} onChange={(e) => setStart(e.target.value)} onBlur={() => put({ startRating: start === '' ? null : Number(start) })} />
        </label>
        <label className="field inline" title="Used when difficulty scope = team">
          team rating
          <input style={{ width: 80 }} value={rating} onChange={(e) => setRating(e.target.value)} onBlur={() => Number(rating) !== t.rating && put({ rating: Number(rating) })} />
        </label>
        <label className="field inline">
          <input type="checkbox" checked={t.enabled} onChange={(e) => put({ enabled: e.target.checked })} /> enabled
        </label>
        <span className="spacer" />
        <button onClick={() => confirm('Regenerate seat codes? Connected clients are kicked.') && act('POST', `/teams/${t.id}/regenerate-codes`, {}).catch(() => {})}>Regenerate codes</button>
        <button className="danger" onClick={() => confirm(`Delete ${t.name}?`) && act('DELETE', `/teams/${t.id}`).catch(() => {})}>
          Delete
        </button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        {t.seats.map((x) => (
          <SeatLabel key={x.index} teamId={t.id} index={x.index} label={x.label} code={x.code} connected={x.connected} />
        ))}
      </div>
    </div>
  );
}

function SeatLabel({ teamId, index, label, code, connected }: { teamId: string; index: number; label: string; code: string; connected: number }) {
  const { act } = useAdmin();
  const [v, setV] = useState(label);
  return (
    <div className="seat" style={{ minWidth: 170 }}>
      <div className="row">
        <span className={`dot ${connected ? 'on' : ''}`} />
        <input value={v} style={{ width: 100 }} onChange={(e) => setV(e.target.value)} onBlur={() => v !== label && act('PUT', `/teams/${teamId}/seats/${index}`, { label: v }).catch(() => {})} />
      </div>
      <span className="mono" style={{ letterSpacing: 2 }}>
        {code}
      </span>
    </div>
  );
}
