import { useMemo, useState } from 'react';
import type { Problem, Sample } from '../../../shared/types';
import { api } from '../lib/api';
import Statement from '../components/Statement';
import { problemUrl, useAdmin } from './ctx';

type P = AdminProblem;
type AdminProblem = ReturnType<typeof useAdmin>['s']['problems'][number];

export default function ProblemsTab() {
  const { s, act } = useAdmin();
  const [ids, setIds] = useState('');
  const [rating, setRating] = useState('');
  const [bulk, setBulk] = useState({ minRating: '800', maxRating: '2000', perRating: '10', includeTags: '', excludeTags: '', minContestId: '1500', excludeSolvedBy: '' });
  const [q, setQ] = useState('');
  const [fr, setFr] = useState('');
  const [fs, setFs] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<Problem | 'new' | null>(null);
  const [preview, setPreview] = useState<Problem | null>(null);
  const [bulkRating, setBulkRating] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const used = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of s.attempts) m.set(a.problemId, (m.get(a.problemId) ?? 0) + 1);
    return m;
  }, [s.attempts]);

  const dist = useMemo(() => {
    const m = new Map<number, { total: number; usable: number; used: number }>();
    for (const p of s.problems) {
      const d = m.get(p.rating) ?? { total: 0, usable: 0, used: 0 };
      d.total++;
      if (p.enabled && (p.fetchStatus === 'ok' || p.source === 'manual')) d.usable++;
      if (used.has(p.id)) d.used++;
      m.set(p.rating, d);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [s.problems, used]);

  const rows = s.problems
    .filter((p) => (!q || `${p.id} ${p.name} ${p.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase())) && (!fr || p.rating === Number(fr)) && (!fs || (fs === 'disabled' ? !p.enabled : fs === 'used' ? used.has(p.id) : p.fetchStatus === fs)))
    .sort((a, b) => a.rating - b.rating || a.id.localeCompare(b.id));

  const toggle = (id: string) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSel(n);
  };
  const split = (t: string) => t.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch {
      /* shown in header */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="grid2 section">
        <div className="card col">
          <h3>Add Codeforces problems</h3>
          <textarea rows={4} className="mono" placeholder={'1850A, 4A\nhttps://codeforces.com/contest/1352/problem/C\n102001 B (gym)'} value={ids} onChange={(e) => setIds(e.target.value)} />
          <div className="row">
            <input placeholder="pool rating (default: CF rating)" value={rating} onChange={(e) => setRating(e.target.value)} style={{ width: 230 }} />
            <button
              className="primary"
              disabled={busy || !ids.trim()}
              onClick={() =>
                run(async () => {
                  const r = (await act('POST', '/problems', { ids: split(ids), rating: rating ? Number(rating) : undefined })) as { added?: string[] };
                  setMsg(`Added ${r?.added?.length ?? '?'} problem(s); statements are fetched in the background.`);
                  setIds('');
                })
              }
            >
              Add
            </button>
            <button onClick={() => setEdit('new')}>Add manual problem…</button>
          </div>
        </div>
        <div className="card col">
          <h3>Bulk add from the Codeforces problemset</h3>
          <div className="form-grid">
            {(
              [
                ['minRating', 'Min rating'],
                ['maxRating', 'Max rating'],
                ['perRating', 'Problems per rating'],
                ['minContestId', 'Min contest id (recency)'],
                ['includeTags', 'Require any tag (comma sep.)'],
                ['excludeTags', 'Exclude tags'],
                ['excludeSolvedBy', 'Exclude solved by CF handles'],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="field">
                {l}
                <input value={bulk[k]} onChange={(e) => setBulk({ ...bulk, [k]: e.target.value })} placeholder={k === 'excludeTags' ? '*special, interactive' : ''} />
              </label>
            ))}
          </div>
          <div className="row">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = (await act('POST', '/problems/bulk-add', {
                    minRating: Number(bulk.minRating),
                    maxRating: Number(bulk.maxRating),
                    perRating: Number(bulk.perRating),
                    minContestId: bulk.minContestId ? Number(bulk.minContestId) : undefined,
                    includeTags: split(bulk.includeTags),
                    excludeTags: split(bulk.excludeTags),
                    excludeSolvedBy: split(bulk.excludeSolvedBy),
                    excludeExisting: true,
                  })) as { added?: string[] };
                  setMsg(`Added ${r?.added?.length ?? 0} problem(s).`);
                })
              }
            >
              {busy ? 'Working…' : 'Bulk add'}
            </button>
            <span className="hint">Picks random problems per rating step; interactive problems are worth excluding.</span>
          </div>
        </div>
      </div>
      {msg && (
        <div className="row section">
          <span className="badge good">{msg}</span>
          <button className="ghost small" onClick={() => setMsg(null)}>
            ×
          </button>
        </div>
      )}

      <div className="section">
        <h3>Pool by rating (usable / total, used)</h3>
        <div className="dist">
          {dist.map(([r, d]) => (
            <div key={r} className="cell" onClick={() => setFr(fr === String(r) ? '' : String(r))} style={{ cursor: 'pointer', outline: fr === String(r) ? '1px solid var(--accent)' : '' }}>
              <b>{r}</b>
              {d.usable}/{d.total}
              <div className="muted">{d.used} used</div>
            </div>
          ))}
          {!dist.length && <span className="muted">Pool is empty.</span>}
        </div>
      </div>

      <div className="row section">
        <input placeholder="Search id / name / tag" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={fs} onChange={(e) => setFs(e.target.value)}>
          <option value="">Any status</option>
          <option value="ok">Fetched</option>
          <option value="pending">Pending</option>
          <option value="error">Fetch error</option>
          <option value="none">Not fetched</option>
          <option value="disabled">Disabled</option>
          <option value="used">Used</option>
        </select>
        <span className="muted">{rows.length} problems</span>
        <span className="spacer" />
        <button onClick={() => act('POST', '/problems/fetch-missing', {}).catch(() => {})}>Fetch missing statements</button>
        <button
          onClick={() =>
            run(async () => {
              const d = await api('GET', '/admin/problems/export');
              const a = document.createElement('a');
              a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 1)], { type: 'application/json' }));
              a.download = 'problems.json';
              a.click();
            })
          }
        >
          Export
        </button>
        <label className="field inline" style={{ cursor: 'pointer' }}>
          <span className="badge">Import JSON</span>
          <input
            type="file"
            accept="application/json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const d = JSON.parse(await f.text());
              run(() => act('POST', '/problems/import', { problems: Array.isArray(d) ? d : d.problems }));
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {sel.size > 0 && (
        <div className="row section">
          <b>{sel.size} selected</b>
          <button onClick={() => act('POST', '/problems/bulk', { ids: [...sel], enabled: true }).catch(() => {})}>Enable</button>
          <button onClick={() => act('POST', '/problems/bulk', { ids: [...sel], enabled: false }).catch(() => {})}>Disable</button>
          <input placeholder="rating" style={{ width: 80 }} value={bulkRating} onChange={(e) => setBulkRating(e.target.value)} />
          <button disabled={!bulkRating} onClick={() => act('POST', '/problems/bulk', { ids: [...sel], rating: Number(bulkRating) }).catch(() => {})}>
            Set rating
          </button>
          <button className="danger" onClick={() => confirm(`Delete ${sel.size} problems?`) && act('POST', '/problems/bulk', { ids: [...sel], delete: true }).then(() => setSel(new Set())).catch(() => {})}>
            Delete
          </button>
          <button className="ghost" onClick={() => setSel(new Set())}>
            Clear selection
          </button>
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>
              <input type="checkbox" checked={rows.length > 0 && rows.every((r) => sel.has(r.id))} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
            </th>
            <th>Id</th>
            <th>Name</th>
            <th>Pool rating</th>
            <th>CF rating</th>
            <th>Tags</th>
            <th>Statement</th>
            <th>Used</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <ProblemRow key={p.id} p={p} used={used.get(p.id) ?? 0} selected={sel.has(p.id)} onToggle={() => toggle(p.id)} onEdit={setEdit} onPreview={setPreview} />
          ))}
        </tbody>
      </table>
      {edit && <EditModal p={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {preview && (
        <div className="modal-bg" onClick={() => setPreview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h3>
                {preview.id} · {preview.name}
              </h3>
              <span className="muted">
                {preview.timeLimit} · {preview.memoryLimit}
              </span>
              <span className="spacer" />
              <button className="ghost" onClick={() => setPreview(null)}>
                Close
              </button>
            </div>
            {preview.statementHtml ? <Statement html={preview.statementHtml} /> : <span className="muted">No statement.</span>}
            <div className="muted">
              {preview.samples.length} sample(s), {preview.extraTests.length} extra test(s)
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProblemRow({ p, used, selected, onToggle, onEdit, onPreview }: { p: P; used: number; selected: boolean; onToggle: () => void; onEdit: (p: Problem) => void; onPreview: (p: Problem) => void }) {
  const { act } = useAdmin();
  const [r, setR] = useState(String(p.rating));
  const full = () => api<Problem>('GET', `/admin/problems/${encodeURIComponent(p.id)}`);
  return (
    <tr style={{ opacity: p.enabled ? 1 : 0.5 }}>
      <td>
        <input type="checkbox" checked={selected} onChange={onToggle} />
      </td>
      <td>
        <a href={problemUrl(p.id, p.contestId, p.index)} target="_blank" rel="noreferrer">
          {p.id}
        </a>
      </td>
      <td>{p.name}</td>
      <td>
        <input className="inline" value={r} onChange={(e) => setR(e.target.value)} onBlur={() => Number(r) !== p.rating && act('PUT', `/problems/${encodeURIComponent(p.id)}`, { rating: Number(r) }).catch(() => {})} />
      </td>
      <td className="muted">{p.cfRating ?? '–'}</td>
      <td className="muted" style={{ fontSize: 12, maxWidth: 240 }}>
        {p.tags.join(', ')}
      </td>
      <td>
        {p.source === 'manual' ? (
          <span className="badge">manual</span>
        ) : (
          <span className={`badge ${p.fetchStatus === 'ok' ? 'good' : p.fetchStatus === 'error' ? 'bad' : 'pending'}`} title={p.fetchError ?? ''}>
            {p.fetchStatus}
          </span>
        )}{' '}
        <span className="muted" style={{ fontSize: 11 }}>
          {p.samples.length ? `${p.samples.length} samples` : ''}
        </span>
      </td>
      <td>{used || ''}</td>
      <td>
        <input type="checkbox" checked={p.enabled} onChange={(e) => act('PUT', `/problems/${encodeURIComponent(p.id)}`, { enabled: e.target.checked }).catch(() => {})} />
      </td>
      <td className="row" style={{ flexWrap: 'nowrap' }}>
        <button className="small" onClick={() => full().then(onPreview).catch(() => {})}>
          View
        </button>
        <button className="small" onClick={() => full().then(onEdit).catch(() => {})}>
          Edit
        </button>
        {p.source === 'codeforces' && (
          <button className="small" onClick={() => act('POST', `/problems/${encodeURIComponent(p.id)}/refetch`, {}).catch(() => {})}>
            Refetch
          </button>
        )}
        <button className="small danger" onClick={() => confirm(`Delete ${p.id}?`) && act('DELETE', `/problems/${encodeURIComponent(p.id)}`).catch(() => {})}>
          ×
        </button>
      </td>
    </tr>
  );
}

function SamplesEditor({ label, value, onChange }: { label: string; value: Sample[]; onChange: (v: Sample[]) => void }) {
  return (
    <div className="col">
      <div className="row">
        <b>{label}</b>
        <button className="small" onClick={() => onChange([...value, { input: '', output: '' }])}>
          + add
        </button>
      </div>
      {value.map((t, i) => (
        <div key={i} className="row" style={{ alignItems: 'stretch' }}>
          <textarea className="mono" rows={3} style={{ flex: 1 }} placeholder="input" value={t.input} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, input: e.target.value } : x)))} />
          <textarea className="mono" rows={3} style={{ flex: 1 }} placeholder="expected output" value={t.output} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, output: e.target.value } : x)))} />
          <button className="small danger" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function EditModal({ p, onClose }: { p: Problem | null; onClose: () => void }) {
  const { act } = useAdmin();
  const [f, setF] = useState({
    id: p?.id ?? '',
    name: p?.name ?? '',
    rating: String(p?.rating ?? 800),
    tags: p?.tags.join(', ') ?? '',
    timeLimit: p?.timeLimit ?? '1 second',
    memoryLimit: p?.memoryLimit ?? '256 megabytes',
    statementHtml: p?.statementHtml ?? '',
    samples: p?.samples ?? [],
    extraTests: p?.extraTests ?? [],
  });
  const body = {
    name: f.name,
    rating: Number(f.rating),
    tags: f.tags.split(',').map((x) => x.trim()).filter(Boolean),
    timeLimit: f.timeLimit || null,
    memoryLimit: f.memoryLimit || null,
    statementHtml: f.statementHtml || null,
    samples: f.samples,
    extraTests: f.extraTests,
  };
  const save = () =>
    (p ? act('PUT', `/problems/${encodeURIComponent(p.id)}`, body) : act('POST', '/problems/manual', { id: f.id, ...body }))
      .then(onClose)
      .catch(() => {});
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h3>{p ? `Edit ${p.id}` : 'New manual problem'}</h3>
          <span className="spacer" />
          <button className="primary" onClick={save}>
            Save
          </button>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
        <div className="form-grid">
          {!p && (
            <label className="field">
              Id (CF id like 1850A to allow CF judging)
              <input value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} />
            </label>
          )}
          <label className="field">
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label className="field">
            Pool rating
            <input value={f.rating} onChange={(e) => setF({ ...f, rating: e.target.value })} />
          </label>
          <label className="field">
            Tags
            <input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />
          </label>
          <label className="field">
            Time limit
            <input value={f.timeLimit} onChange={(e) => setF({ ...f, timeLimit: e.target.value })} />
          </label>
          <label className="field">
            Memory limit
            <input value={f.memoryLimit} onChange={(e) => setF({ ...f, memoryLimit: e.target.value })} />
          </label>
        </div>
        <label className="field">
          Statement HTML (math as $$$x$$$)
          <textarea className="mono" rows={8} value={f.statementHtml} onChange={(e) => setF({ ...f, statementHtml: e.target.value })} />
        </label>
        <SamplesEditor label="Samples (shown to players)" value={f.samples} onChange={(v) => setF({ ...f, samples: v })} />
        <SamplesEditor label="Extra tests (local judge only)" value={f.extraTests} onChange={(v) => setF({ ...f, extraTests: v })} />
      </div>
    </div>
  );
}
