import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { AdminState } from '../../../shared/types';
import { ApiError, adminToken, api, fmtMs, makeSocket, remainingMs, syncClock } from '../lib/api';
import { useNow } from '../lib/useNow';
import { Ctx } from '../admin/ctx';
import GameTab from '../admin/GameTab';
import TeamsTab from '../admin/TeamsTab';
import ProblemsTab from '../admin/ProblemsTab';
import SubmissionsTab from '../admin/SubmissionsTab';
import SettingsTab from '../admin/SettingsTab';
import JudgeTab from '../admin/JudgeTab';
import LogTab from '../admin/LogTab';

export default function AdminPage() {
  const [token, setToken] = useState(adminToken.get());
  const [s, setS] = useState<AdminState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [conn, setConn] = useState(false);

  const logout = useCallback(() => {
    adminToken.set(null);
    setToken(null);
    setS(null);
  }, []);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    api<AdminState>('GET', '/admin/state')
      .then((st) => {
        if (!alive) return;
        syncClock(st.clock);
        setS(st);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) logout();
        else setErr(String(e.message));
      });
    const sock = makeSocket({ adminToken: token });
    sock.on('connect', () => {
      setConn(true);
      sock.emit('admin:subscribe', null, (st: AdminState) => {
        if (st && 'config' in st) {
          syncClock(st.clock);
          setS(st);
        }
      });
    });
    sock.on('disconnect', () => setConn(false));
    sock.on('admin:state', (st: AdminState) => {
      syncClock(st.clock);
      setS(st);
    });
    sock.on('clock', (c) => {
      syncClock(c);
      setS((p) => (p ? { ...p, clock: c } : p));
    });
    return () => {
      alive = false;
      sock.disconnect();
    };
  }, [token, logout]);

  const act = useCallback(async (method: string, path: string, body?: unknown) => {
    try {
      const r = await api(method, `/admin${path}`, body);
      setErr(null);
      return r;
    } catch (e) {
      setErr(String((e as Error).message));
      throw e;
    }
  }, []);

  if (!token) return <Login onToken={(t) => (adminToken.set(t), setToken(t))} />;
  if (!s) return <div className="center-screen muted">{err ?? 'Loading…'}</div>;

  return (
    <Ctx.Provider value={{ s, act }}>
      <div className="admin">
        <header className="admin-top">
          <b>{s.config.eventName}</b>
          <span className="muted">admin</span>
          <nav>
            {[
              ['game', 'Game'],
              ['teams', 'Teams'],
              ['problems', 'Problems'],
              ['submissions', 'Submissions'],
              ['settings', 'Settings'],
              ['judge', 'Judge & languages'],
              ['log', 'Log & data'],
            ].map(([p, l]) => (
              <NavLink key={p} to={`/admin/${p}`}>
                {l}
              </NavLink>
            ))}
          </nav>
          <div className="spacer" />
          {err && (
            <span className="error" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={err} onClick={() => setErr(null)}>
              {err}
            </span>
          )}
          {!conn && <span className="badge bad">disconnected</span>}
          <HeaderClock s={s} />
          <button className="ghost small" onClick={logout}>
            Log out
          </button>
        </header>
        <div className="admin-body">
          <Routes>
            <Route path="game" element={<GameTab />} />
            <Route path="teams" element={<TeamsTab />} />
            <Route path="problems" element={<ProblemsTab />} />
            <Route path="submissions" element={<SubmissionsTab />} />
            <Route path="settings" element={<SettingsTab />} />
            <Route path="judge" element={<JudgeTab />} />
            <Route path="log" element={<LogTab />} />
            <Route path="*" element={<Navigate to="/admin/game" replace />} />
          </Routes>
        </div>
      </div>
    </Ctx.Provider>
  );
}

function HeaderClock({ s }: { s: AdminState }) {
  useNow(250);
  const c = s.clock;
  return (
    <div className="admin-clock">
      <span className="muted">
        {c.phase} · round {c.round}
        {c.totalRounds ? `/${c.totalRounds}` : ''}
      </span>
      <span className="t">{fmtMs(remainingMs(c))}</span>
    </div>
  );
}

function Login({ onToken }: { onToken: (t: string) => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="center-screen">
      <form
        className="card join"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await api<{ token: string }>('POST', '/admin/login', { password: pw });
            onToken(r.token);
          } catch (e) {
            setErr(String((e as Error).message));
          }
        }}
      >
        <h1>Admin</h1>
        <input type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button className="primary">Log in</button>
        {err && <div className="error">{err}</div>}
      </form>
    </div>
  );
}
