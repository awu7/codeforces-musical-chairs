import { useState } from 'react';
import type { Attempt, Slot, Team } from '../../../shared/types';
import { VerdictBadge } from '../pages/Client';
import { minutes, problemUrl, useAdmin } from './ctx';
import SlotModal from './SlotModal';

export default function GameTab() {
  const { s, act } = useAdmin();
  const c = s.clock;
  const [lockMsg, setLockMsg] = useState(s.lock.message || 'Eyes up here');
  const [ann, setAnn] = useState(s.announcement ?? '');
  const [setMin, setSetMin] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const post = (p: string, b?: unknown) => act('POST', p, b ?? {}).catch(() => {});

  const unassigned = s.teams.flatMap((t) => t.slots).filter((sl) => !sl.attemptId).length;
  const conn = s.teams.flatMap((t) => t.seats).filter((x) => x.connected > 0).length;
  const total = s.teams.reduce((a, t) => a + t.seats.length, 0);

  return (
    <div>
      <div className="section">
        <h3>Game control</h3>
        <div className="row">
          {c.phase === 'setup' && (
            <button className="primary" onClick={() => post('/game/start')}>
              Start game
            </button>
          )}
          {c.phase === 'running' && <button onClick={() => post('/game/pause')}>Pause</button>}
          {c.phase === 'paused' && (
            <button className="primary" onClick={() => post('/game/resume')}>
              Resume
            </button>
          )}
          {(c.phase === 'running' || c.phase === 'paused') && <button onClick={() => post('/game/next-round')}>End round now</button>}
          {c.phase === 'transition' && c.transitionEndsAt && <button onClick={() => post('/game/skip-transition')}>Skip transition</button>}
          {c.phase === 'transition' && !c.transitionEndsAt && (
            <button className="primary" onClick={() => post('/game/start-round')}>
              Start round {c.round + 1}
            </button>
          )}
          {c.phase !== 'setup' && c.phase !== 'finished' && (
            <button className="danger" onClick={() => confirm('End the game for everyone?') && post('/game/end')}>
              End game
            </button>
          )}
          <span className="spacer" />
          <button
            className="danger"
            onClick={() => {
              if (!confirm('Reset to setup? Clears attempts, submissions and editor contents.')) return;
              post('/game/reset', { keepTeams: true, keepPool: true });
            }}
          >
            Reset game
          </button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="muted">Round time:</span>
          {[-300, -60, -10, 10, 60, 300].map((d) => (
            <button key={d} className="small" disabled={c.phase !== 'running' && c.phase !== 'paused'} onClick={() => post('/game/add-time', { seconds: d })}>
              {d > 0 ? '+' : '−'}
              {Math.abs(d) >= 60 ? `${Math.abs(d) / 60}m` : `${Math.abs(d)}s`}
            </button>
          ))}
          <input className="inline" style={{ width: 80 }} placeholder="min" value={setMin} onChange={(e) => setSetMin(e.target.value)} />
          <button className="small" disabled={!setMin || (c.phase !== 'running' && c.phase !== 'paused')} onClick={() => post('/game/set-remaining', { seconds: Math.round(parseFloat(setMin) * 60) })}>
            Set remaining
          </button>
          <span className="spacer" />
          <label className="field inline">
            <input type="checkbox" checked={s.config.lazyMode} onChange={(e) => act('PUT', '/config', { lazyMode: e.target.checked }).catch(() => {})} /> Lazy mode
          </label>
          <label className="field inline">
            <input type="checkbox" checked={s.config.autoAdvance} onChange={(e) => act('PUT', '/config', { autoAdvance: e.target.checked }).catch(() => {})} /> Auto-advance rounds
          </label>
          <label className="field inline">
            Judge
            <select value={s.config.judgeMode} onChange={(e) => act('PUT', '/config', { judgeMode: e.target.value }).catch(() => {})}>
              <option value="codeforces">Codeforces</option>
              <option value="cf_self">Self-submit on Codeforces (API polling)</option>
              <option value="local">Local (isolate: samples + tests)</option>
              <option value="manual">Manual</option>
              <option value="auto-accept">Auto-accept (testing)</option>
            </select>
          </label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input style={{ width: 260 }} value={lockMsg} onChange={(e) => setLockMsg(e.target.value)} placeholder="Lock message" />
          {s.lock.locked ? (
            <button className="good" onClick={() => post('/lock', { locked: false, message: '' })}>
              Unlock all clients
            </button>
          ) : (
            <button onClick={() => post('/lock', { locked: true, message: lockMsg })}>Lock all clients</button>
          )}
          <span style={{ width: 20 }} />
          <input style={{ width: 360 }} value={ann} onChange={(e) => setAnn(e.target.value)} placeholder="Announcement banner" />
          <button onClick={() => post('/announce', { text: ann || null })}>Announce</button>
          {s.announcement && (
            <button className="ghost" onClick={() => (setAnn(''), post('/announce', { text: null }))}>
              Clear
            </button>
          )}
        </div>
        <div className="row muted" style={{ marginTop: 8, fontSize: 12 }}>
          {conn}/{total} computers connected · {s.problems.filter((p) => p.enabled).length} problems enabled in pool
          {unassigned > 0 && c.phase !== 'setup' && <span className="badge bad">{unassigned} slot(s) without a problem — add problems to the pool</span>}
          {s.lock.locked && <span className="badge warn">clients locked</span>}
        </div>
      </div>

      <div className="section">
        <h3>Teams</h3>
        {!s.teams.length && <div className="muted">No teams yet — create them in the Teams tab.</div>}
        <div className="col">
          {s.teams.map((t) => (
            <TeamCard key={t.id} t={t} onOpen={setOpen} />
          ))}
        </div>
      </div>
      {open && <SlotModal slotId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TeamCard({ t, onOpen }: { t: Team; onOpen: (id: string) => void }) {
  const { s } = useAdmin();
  const row = s.scoreboard.find((r) => r.teamId === t.id);
  const bySeat = new Map<number, Slot>(t.slots.map((sl) => [sl.seatIndex, sl]));
  return (
    <div className="team-card" style={{ opacity: t.enabled ? 1 : 0.5 }}>
      <h4>
        {t.name}
        <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
          {t.size} seats · {row?.solved ?? 0} solved · {row?.points ?? 0} pts {s.config.difficulty.scope === 'team' ? `· team rating ${t.rating}` : ''}
        </span>
      </h4>
      <div className="seats">
        {t.seats.map((seat) => {
          const sl = bySeat.get(seat.index);
          return <SeatCell key={seat.index} t={t} seatIndex={seat.index} slot={sl} onOpen={onOpen} />;
        })}
      </div>
    </div>
  );
}

function SeatCell({ t, seatIndex, slot, onOpen }: { t: Team; seatIndex: number; slot?: Slot; onOpen: (id: string) => void }) {
  const { s } = useAdmin();
  const seat = t.seats[seatIndex];
  const att: Attempt | undefined = slot?.attemptId ? s.attempts.find((a) => a.id === slot.attemptId) : undefined;
  const prob = att ? s.problems.find((p) => p.id === att.problemId) : undefined;
  const subs = att ? s.submissions.filter((x) => x.attemptId === att.id) : [];
  const maxRounds = Math.min(s.config.maxRoundsPerProblem ?? t.size, t.size);
  return (
    <div className="seat" onClick={() => slot && onOpen(slot.id)} style={{ cursor: 'pointer' }}>
      <div className="row">
        <span className={`dot ${seat.connected ? 'on' : ''}`} title={seat.connected ? `${seat.connected} connected` : 'offline'} />
        <b>{seat.label}</b>
        <span className="muted mono" style={{ fontSize: 11 }}>
          {seat.code}
        </span>
        <span className="spacer" />
        {slot && <span className="muted" style={{ fontSize: 11 }}>slot {t.slots.indexOf(slot) + 1}</span>}
      </div>
      {att && prob ? (
        <>
          <div className="pname" title={prob.name}>
            <a href={problemUrl(prob.id, prob.contestId, prob.index)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              {prob.id}
            </a>{' '}
            {prob.name}
          </div>
          <div className="row muted" style={{ fontSize: 12 }}>
            <span className="chip">{att.rating}</span>
            round {att.roundsShown}/{maxRounds} · {minutes(att.activeMs)}m
            {subs[0] && <VerdictBadge s={subs[0]} />}
          </div>
        </>
      ) : (
        <div className="muted">{s.clock.phase === 'setup' ? `next: ${slot?.nextRating ?? '-'}` : 'no problem'}</div>
      )}
    </div>
  );
}
