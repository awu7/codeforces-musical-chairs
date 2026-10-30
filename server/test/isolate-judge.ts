import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Problem, Submission } from '../../shared/types.js';
import { IsolateRunner } from '../src/isolate.js';
import { LocalJudge } from '../src/judge/local.js';
import { Store } from '../src/store.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'musical-chairs-isolate-judge-'));
const store = new Store(dataDir);
try {
  const testsDir = path.join(dataDir, 'tests', 'MULTI', 'tests');
  await mkdir(testsDir, { recursive: true });
  for (const [index, test] of [
    { input: '1\n', output: '1\n' },
    { input: '2\n', output: '2\n' },
    { input: '3\n', output: 'nope\n' },
  ].entries()) {
    const name = `${String(index + 1).padStart(3, '0')}`;
    await writeFile(path.join(testsDir, `${name}.in`), test.input);
    await writeFile(path.join(testsDir, `${name}.out`), test.output);
  }
  await store.load();
  store.state.config.isolateBoxBase = 700;
  store.state.config.maxConcurrentRuns = 1;
  const runner = new IsolateRunner(store);
  const cpp = store.state.languages.find((item) => item.id === 'cpp20');
  assert.ok(cpp, 'default C++20 compiler is configured');
  const problem: Problem = {
    id: 'MULTI', contestId: 0, index: 'MULTI', name: 'MULTI', rating: 800, cfRating: null,
    tags: [], enabled: true, source: 'manual', statementHtml: null, timeLimit: null, memoryLimit: null,
    samples: [], extraTests: [], testCount: 3, needsChecker: false,
    fetchStatus: 'ok', fetchError: null, fetchedAt: null,
  };
  const submission = {
    code: '#include <iostream>\nint main() { int value; if (std::cin >> value) std::cout << value << "\\n"; }\n',
  } as Submission;
  const result = await new LocalJudge(runner, store).judge(submission, cpp, problem);
  assert.equal(result.verdict, 'WRONG_ANSWER');
  assert.equal(result.passedTests, 2);
  assert.equal(result.failedTest, 3);

  const python = store.state.languages.find((item) => item.id === 'py3');
  assert.ok(python, 'default Python 3 language is configured');
  const pythonCode = 'value = int(input())\nprint(value)\n';
  const runResult = await runner.run(python, pythonCode, '42\n');
  assert.equal(runResult.status, 'ok', runResult.stderr);
  assert.equal(runResult.stdout.trim(), '42');
  const pythonProblem = {
    ...problem,
    id: 'PYTHON',
    index: 'PYTHON',
    samples: [{ input: '17\n', output: '17\n' }],
    testCount: 0,
  };
  const pythonResult = await new LocalJudge(runner, store).judge(
    { code: pythonCode } as Submission,
    python,
    pythonProblem,
  );
  assert.equal(pythonResult.verdict, 'OK', pythonResult.message ?? undefined);
  console.log('ISOLATE JUDGE PASS: compile-once C++ with failedTest 3, Python Run and local judging');
} finally {
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
}
