import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackend, type Backend } from '../src/index.js';

const problems = ['1850A', '4A'];

async function request<T>(
  base: string,
  route: string,
  method = 'GET',
  body?: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`${method} ${route}: ${result.error ?? response.statusText}`);
  return result;
}

async function run(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'musical-chairs-cf-'));
  let backend: Backend | null = null;
  try {
    backend = await createBackend({ dataDir });
    const port = await backend.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const login = await request<{ token: string }>(base, '/api/admin/login', 'POST', {
      password: process.env.ADMIN_PASSWORD ?? 'admin',
    });
    await request(base, '/api/admin/problems', 'POST', { ids: problems }, login.token);

    const deadline = Date.now() + 90_000;
    const pending = new Set(problems);
    while (pending.size && Date.now() < deadline) {
      for (const id of pending) {
        const problem = await request<{
          fetchStatus: string;
          fetchError: string | null;
          statementHtml: string | null;
          timeLimit: string | null;
          memoryLimit: string | null;
          samples: Array<{ input: string; output: string }>;
        }>(base, `/api/admin/problems/${id}`, 'GET', undefined, login.token);
        if (problem.fetchStatus === 'error') throw new Error(`${id}: ${problem.fetchError}`);
        if (problem.fetchStatus === 'ok') {
          assert.ok(problem.statementHtml?.trim(), `${id} statement HTML`);
          assert.ok(problem.timeLimit, `${id} time limit`);
          assert.ok(problem.memoryLimit, `${id} memory limit`);
          assert.ok(problem.samples.length, `${id} samples`);
          pending.delete(id);
        }
      }
      if (pending.size) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(pending.size, 0, `Statement fetch timed out for ${[...pending].join(', ')}`);
    console.log(`Codeforces bridge PASS: ${problems.join(', ')} statements, limits, samples`);
  } finally {
    if (backend) await backend.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
