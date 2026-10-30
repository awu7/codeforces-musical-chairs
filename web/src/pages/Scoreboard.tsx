import { useEffect, useState } from 'react';
import type { GameClock, ScoreRow } from '../../../shared/types';
import { api, fmtMs, remainingMs, syncClock } from '../lib/api';
import { useNow } from '../lib/useNow';
import ScoreTable from '../components/ScoreTable';

export default function ScoreboardPage() {
  useNow(500);
  const [data, setData] = useState<{ eventName: string; clock: GameClock; rows: ScoreRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const d = await api<{ eventName: string; clock: GameClock; rows: ScoreRow[] }>('GET', '/scoreboard');
        syncClock(d.clock);
        if (!stop) {
          setData(d);
          setErr(null);
        }
      } catch (e) {
        if (!stop) setErr(String((e as Error).message));
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
  if (!data) return <div className="center-screen muted">{err ?? 'Loading…'}</div>;
  const c = data.clock;
  return (
    <div className="board-page">
      <header>
        <h1>{data.eventName}</h1>
        <div className="spacer" />
        <div className="board-clock">
          <span className="muted">{c.phase === 'running' ? `Round ${c.round}${c.totalRounds ? `/${c.totalRounds}` : ''}` : c.phase}</span>
          <span className="big-time">{fmtMs(remainingMs(c))}</span>
        </div>
      </header>
      <ScoreTable rows={data.rows} big />
    </div>
  );
}
