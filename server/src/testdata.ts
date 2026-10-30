import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Problem, Sample } from '../../shared/types.js';
import type { Store } from './store.js';

interface TestFiles {
  names: string[];
  needsChecker: boolean;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function testFiles(root: string, id: string): Promise<TestFiles> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return { names: [], needsChecker: false };
  let problemEntries;
  try {
    problemEntries = await readdir(path.join(root, id), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { names: [], needsChecker: false };
    throw error;
  }
  const needsChecker = problemEntries.some((entry) => entry.isFile() && entry.name === 'needs-checker');
  if (!problemEntries.some((entry) => entry.isDirectory() && entry.name === 'tests')) {
    return { names: [], needsChecker };
  }
  let entries;
  try {
    entries = await readdir(path.join(root, id, 'tests'), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { names: [], needsChecker };
    throw error;
  }
  const inputs = new Set(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.in'))
    .map((entry) => entry.name.slice(0, -3)));
  const outputs = new Set(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.out'))
    .map((entry) => entry.name.slice(0, -4)));
  const names = [...inputs].filter((name) => outputs.has(name)).sort();
  return { names, needsChecker };
}

export function testsRoot(store: Pick<Store, 'dir'>): string {
  return path.join(store.dir, 'tests');
}

export async function scanProblemTests(root: string, id: string): Promise<{ testCount: number; needsChecker: boolean }> {
  const files = await testFiles(root, id);
  return { testCount: files.names.length, needsChecker: files.needsChecker };
}

export async function loadProblemTests(root: string, id: string): Promise<{ tests: Sample[] }> {
  const files = await testFiles(root, id);
  const directory = path.join(root, id, 'tests');
  const tests = await Promise.all(files.names.map(async (name) => {
    const [input, output] = await Promise.all([
      readFile(path.join(directory, `${name}.in`), 'utf8'),
      readFile(path.join(directory, `${name}.out`), 'utf8'),
    ]);
    return { input, output };
  }));
  return { tests };
}

export async function refreshProblemTestMetadata(store: Store, problem: Problem): Promise<boolean> {
  const metadata = await scanProblemTests(testsRoot(store), problem.id);
  const changed = problem.testCount !== metadata.testCount || problem.needsChecker !== metadata.needsChecker;
  Object.assign(problem, metadata);
  return changed;
}

export async function refreshAllProblemTestMetadata(store: Store): Promise<boolean> {
  const changed = await Promise.all(store.state.problems.map((problem) => refreshProblemTestMetadata(store, problem)));
  return changed.some(Boolean);
}
