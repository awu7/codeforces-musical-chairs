import Editor from '@monaco-editor/react';
import { useState } from 'react';
import { VerdictBadge } from '../pages/Client';
import { minutes, useAdmin } from './ctx';

export default function SlotModal({ slotId, onClose }: { slotId: string; onClose: () => void }) {
  const { s, act } = useAdmin();
  const team = s.teams.find((t) => t.slots.some((x) => x.id === slotId));
  const slot = team?.slots.find((x) => x.id === slotId);
  const [rating, setRating] = useState('');
  const [pid, setPid] = useState('');
  const [nextR, setNextR] = useState(String(slot?.nextRating ?? ''));
  const [rounds, setRounds] = useState('');
  if (!team || !slot) return null;
  const att = slot.attemptId ? s.attempts.find((a) => a.id === slot.attemptId) : undefined;
  const prob = att && s.problems.find((p) => p.id === att.problemId);
  const history = s.attempts.filter((a) => a.slotId === slot.id).sort((a, b) => b.startedAt - a.startedAt);
  const lang = s.languages.find((l) => l.id === slot.lang);
  const post = (p: string, b?: unknown) => act('POST', p, b ?? {}).catch(() => {});

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h3>
            {team.name} · {team.seats[slot.seatIndex]?.label} · slot {team.slots.indexOf(slot) + 1}
          </h3>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="row">
          {prob ? (
            <span>
              <b>{prob.id}</b> {prob.name} <span className="chip">{att!.rating}</span>
              <span className="muted">
                round {att!.roundsShown} · {minutes(att!.activeMs)} min · {att!.wrongSubmissions} wrong
              </span>
            </span>
          ) : (
            <span className="muted">No active problem</span>
          )}
        </div>
        <div className="row">
          <button className="good" disabled={!att} onClick={() => confirm('Mark the current problem solved?') && post(`/slots/${slot.id}/solve`)}>
            Mark solved
          </button>
          <input className="inline" placeholder="rating" value={rating} onChange={(e) => setRating(e.target.value)} style={{ width: 80 }} />
          <input className="inline" placeholder="problem id (optional)" value={pid} onChange={(e) => setPid(e.target.value)} style={{ width: 160 }} />
          <button
            disabled={s.clock.phase === 'setup'}
            onClick={() => post(`/slots/${slot.id}/replace`, { rating: rating ? Number(rating) : undefined, problemId: pid || undefined, countAsSkip: true })}
          >
            Replace problem
          </button>
          <span className="spacer" />
          <input className="inline" value={nextR} onChange={(e) => setNextR(e.target.value)} style={{ width: 80 }} />
          <button onClick={() => act('PUT', `/slots/${slot.id}`, { nextRating: Number(nextR) }).catch(() => {})}>Set next rating</button>
          <input className="inline" placeholder="rounds" value={rounds} onChange={(e) => setRounds(e.target.value)} style={{ width: 70 }} />
          <button disabled={!att || !rounds} onClick={() => act('PUT', `/slots/${slot.id}`, { roundsShown: Number(rounds) }).catch(() => {})}>
            Set rounds shown
          </button>
          <button className="danger" onClick={() => confirm('Reset the editor to the template?') && post(`/slots/${slot.id}/clear-code`)}>
            Clear code
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          Live code ({lang?.name ?? slot.lang}) · updated {new Date(slot.updatedAt).toLocaleTimeString()}
        </div>
        <div style={{ height: 380, border: '1px solid var(--line)' }}>
          <Editor
            path={`admin/${slot.id}/${slot.lang}`}
            value={slot.code[slot.lang] ?? ''}
            language={lang?.monaco ?? 'plaintext'}
            theme="vs-dark"
            options={{ readOnly: true, minimap: { enabled: false }, automaticLayout: true, fontSize: 13 }}
          />
        </div>
        {slot.input && (
          <details>
            <summary className="muted">Input box</summary>
            <pre className="mono">{slot.input}</pre>
          </details>
        )}
        <h4>History</h4>
        <table className="table">
          <thead>
            <tr>
              <th>Problem</th>
              <th>Rating</th>
              <th>Outcome</th>
              <th>Rounds</th>
              <th>Minutes</th>
              <th>Submissions</th>
            </tr>
          </thead>
          <tbody>
            {history.map((a) => (
              <tr key={a.id}>
                <td>{a.problemId}</td>
                <td>{a.rating}</td>
                <td>{a.outcome}</td>
                <td>
                  {a.startRound}–{a.endRound ?? '…'} ({a.roundsShown})
                </td>
                <td>{minutes(a.activeMs)}</td>
                <td>
                  {s.submissions
                    .filter((x) => x.attemptId === a.id)
                    .map((x) => (
                      <VerdictBadge key={x.id} s={x} />
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
