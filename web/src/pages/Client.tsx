import Editor from '@monaco-editor/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { RunResult, SeatView, SubmissionPublic } from '../../../shared/types';
import { emitAck, fmtMs, makeSocket, remainingMs, serverNow, syncClock, verdictShort } from '../lib/api';
import { useNow } from '../lib/useNow';
import Statement from '../components/Statement';
import ScoreTable from '../components/ScoreTable';

const CODE_KEY = 'mc_seat_code';

type Status = 'idle' | 'connecting' | 'joined' | 'error';

export default function ClientPage() {
  const [seatCode, setSeatCode] = useState<string | null>(() => {
    const q = new URLSearchParams(location.search).get('code');
    if (q) localStorage.setItem(CODE_KEY, q.toUpperCase());
    return localStorage.getItem(CODE_KEY);
  });
  const [view, setView] = useState<SeatView | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const sockRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!seatCode) return;
    const s = makeSocket();
    sockRef.current = s;
    setStatus('connecting');
    const join = async () => {
      try {
        const r = await emitAck<{ ok: boolean; view?: SeatView; error?: string }>(s, 'seat:join', { code: seatCode }, 10000);
        if (r.ok && r.view) {
          syncClock(r.view.clock);
          setView(r.view);
          setStatus('joined');
          setError(null);
        } else {
          setStatus('error');
          setError(r.error ?? 'Could not join');
          if (r.error) {
            localStorage.removeItem(CODE_KEY);
            setSeatCode(null);
          }
        }
      } catch (e) {
        setStatus('error');
        setError(String(e));
      }
    };
    s.on('connect', join);
    s.on('disconnect', () => setStatus('connecting'));
    s.on('seat:view', (v: SeatView) => {
      syncClock(v.clock);
      setView(v);
    });
    s.on('clock', (c) => {
      syncClock(c);
      setView((v) => (v ? { ...v, clock: c } : v));
    });
    s.on('seat:kicked', (p: { reason?: string }) => {
      localStorage.removeItem(CODE_KEY);
      setError(p?.reason ?? 'This seat was reset by the admin');
      setView(null);
      setSeatCode(null);
    });
    return () => {
      s.disconnect();
      sockRef.current = null;
    };
  }, [seatCode]);

  if (!seatCode || !view)
    return (
      <JoinScreen
        busy={!!seatCode && status !== 'error'}
        error={error}
        onJoin={(c) => {
          localStorage.setItem(CODE_KEY, c);
          setError(null);
          setSeatCode(c);
        }}
      />
    );

  return (
    <Workspace
      view={view}
      socket={sockRef.current!}
      connected={status === 'joined'}
      onLeave={() => {
        localStorage.removeItem(CODE_KEY);
        setView(null);
        setSeatCode(null);
      }}
    />
  );
}

function JoinScreen({ busy, error, onJoin }: { busy: boolean; error: string | null; onJoin: (c: string) => void }) {
  const [code, setCode] = useState('');
  return (
    <div className="center-screen">
      <form
        className="card join"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) onJoin(code.trim().toUpperCase());
        }}
      >
        <h1>Musical Chairs</h1>
        <p className="muted">Enter the seat code for this computer.</p>
        <input autoFocus className="code-input" value={code} maxLength={8} placeholder="ABC123" onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <button className="primary" disabled={busy || !code.trim()}>
          {busy ? 'Connecting…' : 'Join'}
        </button>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}

type Tab = 'output' | 'submissions';

function Workspace({ view, socket, connected, onLeave }: { view: SeatView; socket: Socket; connected: boolean; onLeave: () => void }) {
  useNow(250);
  const slot = view.slot;
  const [slotId, setSlotId] = useState(slot.id);
  const [lang, setLang] = useState(slot.lang);
  const [codes, setCodes] = useState<Record<string, string>>(slot.code);
  const [input, setInput] = useState(slot.input);
  const [tab, setTab] = useState<Tab>('output');
  const [run, setRun] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  const [lastSubmit, setLastSubmit] = useState(0);
  const [showBoard, setShowBoard] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const pending = useRef<{ code?: Record<string, string>; input?: string; lang?: string }>({});
  const lastSent = useRef<{ code: Record<string, string>; input: string }>({ code: { ...slot.code }, input: slot.input });
  const timer = useRef<number | null>(null);
  const slotRef = useRef(slot.id);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    pending.current = {};
    const sid = slotRef.current;
    const sends: Promise<unknown>[] = [];
    if (p.code)
      for (const [l, c] of Object.entries(p.code)) {
        lastSent.current.code[l] = c;
        sends.push(emitAck(socket, 'slot:update', { slotId: sid, lang: l, code: c }, 5000).catch(() => {}));
      }
    if (p.input !== undefined || p.lang !== undefined) {
      if (p.input !== undefined) lastSent.current.input = p.input;
      sends.push(emitAck(socket, 'slot:update', { slotId: sid, lang: p.lang, input: p.input }, 5000).catch(() => {}));
    }
    return Promise.all(sends);
  }, [socket]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 400);
  }, [flush]);

  // Merge server view into local editor state
  useEffect(() => {
    if (slot.id !== slotRef.current) {
      const rotated = slotRef.current !== '';
      slotRef.current = slot.id;
      pending.current = {};
      if (timer.current) clearTimeout(timer.current);
      lastSent.current = { code: { ...slot.code }, input: slot.input };
      setSlotId(slot.id);
      setLang(slot.lang);
      setCodes(slot.code);
      setInput(slot.input);
      setRun(null);
      setSubmitMsg(null);
      if (rotated && view.clock.lazyMode) {
        setToast('Rotated — new problem on this computer');
        setTimeout(() => setToast(null), 3500);
      }
      return;
    }
    const p = pending.current;
    setCodes((cur) => {
      let changed = false;
      const next = { ...cur };
      for (const [l, c] of Object.entries(slot.code)) {
        if (p.code?.[l] !== undefined) continue;
        if (c !== cur[l] && c !== lastSent.current.code[l]) {
          next[l] = c;
          lastSent.current.code[l] = c;
          changed = true;
        }
      }
      return changed ? next : cur;
    });
    if (p.input === undefined && slot.input !== lastSent.current.input) {
      setInput(slot.input);
      lastSent.current.input = slot.input;
    }
    if (p.lang === undefined) setLang(slot.lang);
  }, [slot, view.clock.lazyMode]);

  // Flush edits as soon as the round ends
  const lockReason = view.lock?.reason;
  useEffect(() => {
    if (lockReason) flush();
  }, [lockReason, flush]);
  const rem = remainingMs(view.clock);
  useEffect(() => {
    if (view.clock.phase === 'running' && rem !== null && rem < 300) flush();
  }, [rem, view.clock.phase, flush]);

  const code = codes[lang] ?? '';
  const onCode = (v: string | undefined) => {
    const c = v ?? '';
    setCodes((cur) => ({ ...cur, [lang]: c }));
    pending.current.code = { ...(pending.current.code ?? {}), [lang]: c };
    schedule();
  };
  const onInput = (v: string) => {
    setInput(v);
    pending.current.input = v;
    schedule();
  };
  const onLang = (l: string) => {
    setLang(l);
    pending.current.lang = l;
    flush();
  };

  const locked = !!view.lock || !connected;
  const doRun = async () => {
    setRunning(true);
    setTab('output');
    try {
      const r = await emitAck<RunResult>(socket, 'run', { slotId, lang, code, input });
      setRun(r);
    } catch (e) {
      setRun({ status: 'error', stdout: '', stderr: String(e), compileOutput: '', timeMs: 0, memoryKb: null, exitCode: null, truncated: false });
    } finally {
      setRunning(false);
    }
  };
  const doSubmit = async () => {
    await flush();
    setSubmitMsg('Submitting…');
    setTab('submissions');
    try {
      const r = await emitAck<{ ok: boolean; error?: string }>(socket, 'submit', { slotId, lang, code }, 15000);
      setSubmitMsg(r.ok ? null : (r.error ?? 'Submission failed'));
      if (r.ok) setLastSubmit(Date.now());
    } catch (e) {
      setSubmitMsg(String(e));
    }
  };
  const cooldownLeft = Math.max(0, lastSubmit + view.config.submissionCooldownSeconds * 1000 - Date.now());

  const problem = slot.problem;
  const roundsLeft = slot.maxRounds - slot.roundsShown;
  const solved = slot.submissions.some((s) => s.verdict === 'OK');

  return (
    <div className="ws">
      <header className="ws-top">
        <div className="brand">{view.eventName}</div>
        <div className="muted" title="Click to leave this seat" onDoubleClick={() => confirm('Leave this seat?') && onLeave()}>
          {view.team.name} · {view.seat.label}
        </div>
        {!connected && <span className="badge bad">reconnecting…</span>}
        {view.clock.lazyMode && <span className="badge">lazy mode</span>}
        <div className="spacer" />
        {view.config.showScoreboardToClients && (
          <button className="ghost" onClick={() => setShowBoard(true)}>
            Scoreboard
          </button>
        )}
        <div style={{ width: 210 }} />
      </header>
      <CornerTimer view={view} />
      {view.announcement && <div className="announcement">{view.announcement}</div>}
      {toast && <div className="toast">{toast}</div>}

      <div className="ws-main">
        <section className="pane problem-pane">
          {problem ? (
            <>
              <div className="problem-head">
                <h2>
                  {problem.name}
                </h2>
                <div className="chips">
                  <span className="chip">{problem.id}</span>
                  {problem.rating != null && <span className="chip">{problem.rating}</span>}
                  {problem.timeLimit && <span className="chip">{problem.timeLimit}</span>}
                  {problem.memoryLimit && <span className="chip">{problem.memoryLimit}</span>}
                  {view.config.showRoundsLeftToClients && (
                    <span className={`chip ${roundsLeft <= 0 ? 'warn' : ''}`} title="Rounds after this one before the problem is replaced">
                      {roundsLeft <= 0 ? 'last round for this problem' : `${roundsLeft} more round${roundsLeft === 1 ? '' : 's'}`}
                    </span>
                  )}
                  {problem.tags?.map((t) => (
                    <span key={t} className="chip tag">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              {problem.statementHtml ? (
                <Statement html={problem.statementHtml} />
              ) : (
                <div className="muted">
                  Statement not available. <a href={problem.url} target="_blank" rel="noreferrer">Open on Codeforces</a>
                </div>
              )}
            </>
          ) : (
            <div className="center-fill muted">No problem assigned to this computer yet.</div>
          )}
        </section>

        <section className="pane editor-pane">
          <div className="toolbar">
            <select value={lang} onChange={(e) => onLang(e.target.value)} disabled={!view.config.allowLanguageSwitch || locked}>
              {view.languages.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <div className="spacer" />
            {view.config.allowLocalRun && (
              <button onClick={doRun} disabled={locked || running || !problem} title="Run on the input below (Ctrl+')">
                {running ? 'Running…' : 'Run'}
              </button>
            )}
            <button className="primary" onClick={doSubmit} disabled={locked || !problem || cooldownLeft > 0 || solved} title="Submit (Ctrl+Enter)">
              {cooldownLeft > 0 ? `Submit (${Math.ceil(cooldownLeft / 1000)}s)` : 'Submit'}
            </button>
          </div>
          <div className="editor-wrap">
            <Editor
              path={`${slotId}/${lang}`}
              language={view.languages.find((l) => l.id === lang)?.monaco ?? 'plaintext'}
              value={code}
              onChange={onCode}
              theme="vs-dark"
              onMount={(ed, m) => {
                ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => document.getElementById('btn-submit-proxy')?.click());
                ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Quote, () => document.getElementById('btn-run-proxy')?.click());
              }}
              options={{
                fontSize: view.config.clientEditorFontSize,
                minimap: { enabled: false },
                readOnly: locked,
                automaticLayout: true,
                scrollBeyondLastLine: false,
                tabSize: 4,
              }}
            />
            <button id="btn-submit-proxy" hidden onClick={() => !locked && problem && cooldownLeft <= 0 && !solved && doSubmit()} />
            <button id="btn-run-proxy" hidden onClick={() => !locked && problem && view.config.allowLocalRun && !running && doRun()} />
          </div>
          <div className="io">
            <div className="io-col">
              <div className="io-head">
                <span>Input</span>
                <div className="spacer" />
                {view.config.allowSampleLoad &&
                  problem?.samples.map((s, i) => (
                    <button
                      key={i}
                      className="small"
                      disabled={locked}
                      onClick={() => onInput(s.input)}
                    >
                      Sample {i + 1}
                    </button>
                  ))}
                <button className="small ghost" disabled={locked} onClick={() => onInput('')}>
                  Clear
                </button>
              </div>
              <textarea className="mono" spellCheck={false} value={input} readOnly={locked} onChange={(e) => onInput(e.target.value)} />
            </div>
            <div className="io-col">
              <div className="io-head tabs">
                <button className={tab === 'output' ? 'tab active' : 'tab'} onClick={() => setTab('output')}>
                  Output
                </button>
                <button className={tab === 'submissions' ? 'tab active' : 'tab'} onClick={() => setTab('submissions')}>
                  Submissions {slot.submissions.length ? `(${slot.submissions.length})` : ''}
                </button>
              </div>
              {tab === 'output' ? <OutputPanel run={run} running={running} /> : <SubmissionsPanel subs={slot.submissions} msg={submitMsg} />}
            </div>
          </div>
        </section>
      </div>
      <div className="ws-foot muted">
        Solved on this computer: {slot.solvedCount}
        <span className="spacer" />
        Ctrl+Enter submit · Ctrl+' run
      </div>

      {view.lock && <LockOverlay view={view} />}
      {showBoard && view.scoreboard && (
        <div className="modal-bg" onClick={() => setShowBoard(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Scoreboard</h3>
            <ScoreTable rows={view.scoreboard} highlight={view.team.id} />
          </div>
        </div>
      )}
    </div>
  );
}

function CornerTimer({ view }: { view: SeatView }) {
  const c = view.clock;
  const rem = remainingMs(c);
  const label =
    c.phase === 'running' ? `Round ${c.round}${c.totalRounds ? `/${c.totalRounds}` : ''}` : c.phase === 'paused' ? 'Paused' : c.phase === 'transition' ? 'Switching' : c.phase === 'setup' ? 'Not started' : 'Finished';
  const urgent = c.phase === 'running' && rem !== null && rem <= 60000;
  return (
    <div className={`corner-timer ${urgent ? 'urgent' : ''} ${c.phase}`}>
      <div className="ct-label">{label}</div>
      <div className="ct-time">{c.phase === 'running' || c.phase === 'paused' ? fmtMs(rem) : '--:--'}</div>
    </div>
  );
}

function LockOverlay({ view }: { view: SeatView }) {
  const l = view.lock!;
  const left = l.until ? Math.max(0, l.until - serverNow()) : null;
  const title =
    l.reason === 'transition'
      ? view.clock.lazyMode
        ? 'Rotating problems…'
        : 'Time! Move to the next computer'
      : l.reason === 'paused'
        ? 'Paused'
        : l.reason === 'setup'
          ? 'Waiting for the game to start'
          : l.reason === 'finished'
            ? 'Game over'
            : l.reason === 'waiting'
              ? 'Next round starting soon'
              : 'Locked';
  return (
    <div className={`lock-overlay ${l.reason}`}>
      <div className="lock-box">
        {l.reason === 'transition' && !view.clock.lazyMode && <div className="lock-arrow">→</div>}
        <h1>{title}</h1>
        {l.message && l.message !== title && <p>{l.message}</p>}
        {left !== null && <div className="lock-count">{Math.ceil(left / 1000)}</div>}
        {l.reason === 'transition' && left !== null && <div className="muted">seconds until the next round</div>}
      </div>
    </div>
  );
}


function OutputPanel({ run, running }: { run: RunResult | null; running: boolean }) {
  if (running) return <div className="out muted">Running…</div>;
  if (!run) return <div className="out muted">Run your code to see output here.</div>;
  return (
    <div className="out">
      <div className="out-status">
        <span className={`badge ${run.status === 'ok' ? 'good' : 'bad'}`}>{run.status.replace('_', ' ')}</span>
        <span className="muted">
          {run.timeMs} ms{run.exitCode != null && run.exitCode !== 0 ? ` · exit ${run.exitCode}` : ''}
          {run.truncated ? ' · output truncated' : ''}
        </span>
      </div>
      {run.compileOutput && <pre className="mono err">{run.compileOutput}</pre>}
      <pre className="mono">{run.stdout}</pre>
      {run.stderr && <pre className="mono err">{run.stderr}</pre>}
    </div>
  );
}

export function VerdictBadge({ s }: { s: Pick<SubmissionPublic, 'status' | 'verdict' | 'failedTest'> }) {
  if (s.status === 'error') return <span className="badge bad">error</span>;
  if (s.status !== 'done' || !s.verdict) return <span className="badge pending">{s.status}</span>;
  const short = verdictShort[s.verdict] ?? s.verdict;
  return (
    <span className={`badge ${s.verdict === 'OK' ? 'good' : 'bad'}`} title={s.verdict}>
      {short}
      {s.verdict !== 'OK' && s.failedTest ? ` #${s.failedTest}` : ''}
    </span>
  );
}

function SubmissionsPanel({ subs, msg }: { subs: SubmissionPublic[]; msg: string | null }) {
  return (
    <div className="out">
      {msg && <div className="error">{msg}</div>}
      {!subs.length && !msg && <div className="muted">No submissions for this problem yet.</div>}
      {subs.map((s) => (
        <div key={s.id} className="sub-row">
          <span className="muted">{new Date(s.createdAt).toLocaleTimeString()}</span>
          <VerdictBadge s={s} />
          <span className="muted">{s.lang}</span>
          {s.timeMs != null && <span className="muted">{s.timeMs} ms</span>}
          {s.memoryKb != null && <span className="muted">{Math.round(s.memoryKb / 1024)} MB</span>}
          {s.message && <pre className="mono err sub-msg">{s.message}</pre>}
        </div>
      ))}
    </div>
  );
}
