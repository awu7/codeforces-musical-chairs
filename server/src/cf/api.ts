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

const MIN_API_SPACING_MS = 2100;
let apiQueue: Promise<void> = Promise.resolve();
let lastApiCallAt = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestApi(url: string | URL): Promise<{ status?: string; comment?: string; result?: unknown }> {
  const operation = apiQueue.then(async () => {
    for (let retry = 0; ; retry += 1) {
      const waitMs = Math.max(0, lastApiCallAt + MIN_API_SPACING_MS - Date.now());
      if (waitMs) await delay(waitMs);
      lastApiCallAt = Date.now();
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const text = await response.text();
      let body: { status?: string; comment?: string; result?: unknown };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        throw new Error(`Codeforces API returned a non-JSON response (HTTP ${response.status})`);
      }
      const comment = String(body.comment ?? '');
      if (/Call limit exceeded/i.test(comment)) {
        if (retry >= 3) throw new Error(comment);
        await delay(5000);
        continue;
      }
      if (!response.ok) throw new Error(`Codeforces API returned HTTP ${response.status}`);
      if (body.status !== 'OK') throw new Error(comment || 'Codeforces API failed');
      return body;
    }
  });
  apiQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

let problemCache: { expiresAt: number; problems: CfProblem[] } | null = null;

export async function getProblemset(force = false): Promise<CfProblem[]> {
  if (!force && problemCache && problemCache.expiresAt > Date.now()) return problemCache.problems;
  const body = await requestApi('https://codeforces.com/api/problemset.problems');
  const result = body.result as CfProblemset | undefined;
  const problems = result?.problems ?? [];
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
    testCount: 0,
    needsChecker: false,
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
  const body = await requestApi(url);
  return body.result as Array<Record<string, unknown>> ?? [];
}
