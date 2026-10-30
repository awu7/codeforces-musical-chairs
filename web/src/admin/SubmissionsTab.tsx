import Editor from '@monaco-editor/react';
import { useState } from 'react';
import type { Submission } from '../../../shared/types';
import { VerdictBadge } from '../pages/Client';
import { api } from '../lib/api';
import { useAdmin } from './ctx';

const VERDICTS = ['OK', 'WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'RUNTIME_ERROR', 'COMPILATION_ERROR', 'REJECTED'];

export default function SubmissionsTab() {
  const { s, act } = useAdmin();
  const [team, setTeam] = useState('');
  const [verdict, setVerdict] = useState('');
  const [prob, setProb] = useState('');
  const [view, setView] = useState<Submission | null>(null);
  const teamName = (id: string) => s.teams.find((t) => t.id === id)?.name ?? id;
  const rows = s.submissions.filter(
    (x) =>
      (!team || x.teamId === team) &&
      (!prob || x.problemId.toLowerCase().includes(prob.toLowerCase())) &&
      (!verdict || (verdict === 'pending' ? x.status !== 'done' && x.status !== 'error' : verdict === 'error' ? x.status === 'error' : x.verdict === verdict)),
  );
  const pendingManual = s.submissions.filter((x) => x.judge === 'manual' && x.status === 'judging').length;
  return (
    <div>
      <div className="row section">
        <select value={team} onChange={(e) => setTeam(e.target.value)}>
          <option value="">All teams</option>
          {s.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
          <option value="">All verdicts</option>
          <option value="pending">Pending</option>
          <option value="error">Judge error</option>
          {VERDICTS.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <input placeholder="problem" value={prob} onChange={(e) => setProb(e.target.value)} style={{ width: 110 }} />
        <span className="muted">
          {rows.length} shown (latest {s.submissions.length})
        </span>
        {pendingManual > 0 && <span className="badge warn">{pendingManual} awaiting manual judgement</span>}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Team</th>
            <th>Seat</th>
            <th>Problem</th>
            <th>Lang</th>
            <th>Judge</th>
            <th>Verdict</th>
            <th>Time / mem</th>
            <th>CF</th>
            <th>Message</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.id}>
              <td>{new Date(x.createdAt).toLocaleTimeString()}</td>
              <td>{teamName(x.teamId)}</td>
              <td>{x.seatIndex + 1}</td>
              <td>{x.problemId}</td>
              <td>{x.lang}</td>
              <td className="muted">{x.judge}</td>
              <td>
                <VerdictBadge s={x} /> {x.overridden && <span className="muted" title="Set manually">✎</span>}
              </td>
              <td className="muted">
                {x.timeMs != null ? `${x.timeMs} ms` : ''} {x.memoryKb != null ? `${Math.round(x.memoryKb / 1024)} MB` : ''}
              </td>
              <td>
                {x.cfSubmissionId && (
                  <a href={`https://codeforces.com/problemset/submission/${parseInt(x.problemId)}/${x.cfSubmissionId}`} target="_blank" rel="noreferrer">
                    {x.cfSubmissionId}
                  </a>
                )}
              </td>
              <td className="muted" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={x.message ?? ''}>
                {x.message}
              </td>
              <td className="row" style={{ flexWrap: 'nowrap' }}>
                <button className="small" onClick={() => api<Submission>('GET', `/admin/submissions/${x.id}`).then(setView).catch(() => {})}>
                  Code
                </button>
                <button className="small" onClick={() => act('POST', `/submissions/${x.id}/rejudge`, {}).catch(() => {})}>
                  Rejudge
                </button>
                <select
                  className="small"
                  value=""
                  onChange={(e) => e.target.value && act('POST', `/submissions/${x.id}/verdict`, { verdict: e.target.value }).catch(() => {})}
                >
                  <option value="">Set verdict…</option>
                  {VERDICTS.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view && (
        <div className="modal-bg" onClick={() => setView(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h3>
                {teamName(view.teamId)} · {view.problemId} · {view.lang}
              </h3>
              <VerdictBadge s={view} />
              <span className="spacer" />
              <button className="ghost" onClick={() => setView(null)}>
                Close
              </button>
            </div>
            {view.message && <pre className="mono error">{view.message}</pre>}
            <div style={{ height: 500 }}>
              <Editor
                path={`sub/${view.id}`}
                value={view.code}
                language={s.languages.find((l) => l.id === view.lang)?.monaco ?? 'plaintext'}
                theme="vs-dark"
                options={{ readOnly: true, minimap: { enabled: false }, automaticLayout: true }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
