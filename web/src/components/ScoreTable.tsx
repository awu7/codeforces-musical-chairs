import type { ScoreRow } from '../../../shared/types';

export default function ScoreTable({ rows, highlight, big }: { rows: ScoreRow[]; highlight?: string; big?: boolean }) {
  return (
    <table className={`table score ${big ? 'big' : ''}`}>
      <thead>
        <tr>
          <th>#</th>
          <th>Team</th>
          <th>Solved</th>
          <th>Points</th>
          <th>Rating</th>
          <th>Solves</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.teamId} className={r.teamId === highlight ? 'hl' : ''}>
            <td>{i + 1}</td>
            <td>{r.teamName}</td>
            <td>{r.solved}</td>
            <td>{r.points}</td>
            <td>{Math.round(r.currentRating)}</td>
            <td className="solves">
              {r.solves.map((s, j) => (
                <span key={j} className="chip" title={`${s.problemId} · round ${s.round} · ${s.minutes.toFixed(1)} min`}>
                  {s.rating}
                </span>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
