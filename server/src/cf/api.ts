import type { Problem } from '../../../shared/types.js';

interface CfProblem {
  contestId?: number;
  index?: string;
  name?: string;
  rating?: number;
  tags?: string[];
}

interface CfProblemset {
  problems?: CfProblem[];
}

let problemCache: { expiresAt: number; problems: CfProblem[] } | null = null;

export async function getProblemset(force = false): Promise<CfProblem[]> {
  if (!force && problemCache && problemCache.expiresAt > Date.now()) return problemCache.problems;
  const response = await fetch('https://codeforces.com/api/problemset.problems', { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Codeforces API returned HTTP ${response.status}`);
  const body = await response.json() as { status?: string; comment?: string; result?: CfProblemset };
  if (body.status !== 'OK') throw new Error(body.comment ?? 'Codeforces problemset API failed');
  const problems = body.result?.problems ?? [];
  problemCache = { expiresAt: Date.now() + 60 * 60_000, problems };
  return problems;
}

export function problemIdentifier(value: string): { contestId: number; index: string } | null {
  const input = value.trim();
  const urlMatch = input.match(/codeforces\.com\/(?:problemset\/problem|contest)\/(\d+)\/(?:problem\/)?([A-Za-z0-9]+)/i)
    ?? input.match(/codeforces\.com\/gym\/(\d+)\/problem\/([A-Za-z0-9]+)/i);
  const match = urlMatch ?? input.match(/^(\d+)\s*([A-Za-z]\w*)$/);
  if (!match) return null;
  return { contestId: Number(match[1]), index: match[2]!.toUpperCase() };
}

export function problemFromCf(cf: CfProblem): Problem {
  if (!cf.contestId || !cf.index || !cf.name) throw new Error('Codeforces problem metadata is incomplete');
  return {
    id: `${cf.contestId}${cf.index}`,
    contestId: cf.contestId,
    index: cf.index,
    name: cf.name,
    rating: cf.rating ?? 800,
    cfRating: cf.rating ?? null,
    tags: cf.tags ?? [],
    enabled: true,
    source: 'codeforces',
    statementHtml: null,
    timeLimit: null,
    memoryLimit: null,
    samples: [],
    extraTests: [],
    fetchStatus: 'pending',
    fetchError: null,
    fetchedAt: null,
  };
}

export async function userStatus(handle: string, count = 20): Promise<Array<Record<string, unknown>>> {
  const url = new URL('https://codeforces.com/api/user.status');
  url.searchParams.set('handle', handle);
  url.searchParams.set('from', '1');
  url.searchParams.set('count', String(count));
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Codeforces API returned HTTP ${response.status}`);
  const body = await response.json() as { status?: string; comment?: string; result?: Array<Record<string, unknown>> };
  if (body.status !== 'OK') throw new Error(body.comment ?? 'Codeforces user.status API failed');
  return body.result ?? [];
}
