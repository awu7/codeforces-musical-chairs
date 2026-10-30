import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connectSocket, type Socket } from 'socket.io-client';
import type { Attempt, Problem, RunResult, SeatView, Team } from '../../shared/types.js';
import { DEFAULT_LANGUAGES } from '../src/defaults.js';
import { createBackend, type Backend } from '../src/index.js';
import type { Runner, RunnerTestResult } from '../src/isolate.js';
import { sameTokens } from '../src/judge/local.js';
import { loadProblemTests, scanProblemTests } from '../src/testdata.js';
import { runSelfSubmitE2e } from './self-submit-e2e.js';

const sockets: Socket[] = [];
const latestViews = new Map<Socket, SeatView>();
let lastRunLimits: { timeMs: number; memoryMb: number } | undefined;
const fakeRunner: Runner = {
  async run(_language, code, input, limits): Promise<RunResult> {
    lastRunLimits = limits;
    const outputs = new Map([['3 4\n', '7\n'], ['10 -2\n', '8\n'], ['1\n', '1\n'], ['2\n', '2\n'], ['3\n', 'wrong\n']]);
    return {
      status: 'ok',
      stdout: code.includes('display-cap') ? 'x'.repeat(70 * 1024) : code.includes('wrong') ? 'wrong\n' : outputs.get(input) ?? '',
      stderr: '',
      compileOutput: '',
      timeMs: 1,
      memoryKb: null,
      exitCode: 0,
      truncated: false,
    };
  },
  async runTests(language, code, tests, limits): Promise<RunnerTestResult[]> {
    const results: RunnerTestResult[] = [];
    for (const test of tests) {
      const result = await fakeRunner.run(language, code, test.input, limits);
      if (result.status !== 'ok') {
        results.push({ run: result, verdict: null });
        break;
      }
      const verdict = sameTokens(result.stdout, test.output) ? 'pass' : 'wrong_answer';
      results.push({ run: result, verdict });
      if (verdict === 'wrong_answer') break;
    }
    return results;
  },
};

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

function waitForView(socket: Socket, predicate: (view: SeatView) => boolean, timeoutMs = 30_000): Promise<SeatView> {
  const latest = latestViews.get(socket);
  if (latest && predicate(latest)) return Promise.resolve(latest);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('seat:view', listener);
      const current = latestViews.get(socket);
      reject(new Error(`Timed out waiting for seat view (phase=${current?.clock.phase ?? 'unknown'}, round=${current?.clock.round ?? 'unknown'}, problem=${current?.slot.problem?.id ?? 'none'})`));
    }, timeoutMs);
    const listener = (view: SeatView) => {
      if (!predicate(view)) return;
      clearTimeout(timer);
      socket.off('seat:view', listener);
      resolve(view);
    };
    socket.on('seat:view', listener);
  });
}

async function connectSeat(base: string, code: string): Promise<{ socket: Socket; view: SeatView }> {
  const socket = connectSocket(base, { transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const reply = await new Promise<{ ok: boolean; view?: SeatView; error?: string }>((resolve) => {
    socket.emit('seat:join', { code }, resolve);
  });
  assert.equal(reply.ok, true, reply.error);
  assert.ok(reply.view);
  latestViews.set(socket, reply.view);
  socket.on('seat:view', (view: SeatView) => latestViews.set(socket, view));
  return { socket, view: reply.view };
}

function submit(socket: Socket, slotId: string, code: string): Promise<{ ok: boolean; submissionId?: string; error?: string }> {
  return new Promise((resolve) => {
    socket.emit('submit', { slotId, lang: 'cpp20', code }, resolve);
  });
}

function updateSlot(
  socket: Socket,
  payload: { slotId: string; lang?: string; code?: string; input?: string; attemptStartedAt?: number | null },
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    socket.emit('slot:update', payload, resolve);
  });
}

async function waitForSubmission(base: string, token: string, id: string): Promise<{ verdict: string | null; status: string }> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const submission = await request<{ verdict: string | null; status: string }>(
      base, `/api/admin/submissions/${id}`, 'GET', undefined, token,
    );
    if (submission.status === 'done' || submission.status === 'error') return submission;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Submission ${id} did not finish in time`);
}

async function waitForPhase(
  views: Array<{ team: Team; seatIndex: number; socket: Socket }>,
  phase: SeatView['clock']['phase'],
  round?: number,
): Promise<SeatView[]> {
  return Promise.all(views.map(({ socket }) => waitForView(
    socket,
    (view) => view.clock.phase === phase && (round === undefined || view.clock.round === round),
  )));
}

async function testOrderedDifficulty(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'musical-chairs-ordered-e2e-'));
  let backend: Backend | null = null;
  try {
    backend = await createBackend({ dataDir, runner: fakeRunner });
    const { store, engine } = backend;
    store.state.config.difficultyMode = 'ordered';
    store.state.config.judgeMode = 'manual';
    store.state.config.uniqueness = 'global';
    const firstTeam = engine.createTeam('Ordered One', 2);
    const secondTeam = engine.createTeam('Ordered Two', 2);
    const trio = engine.createTeam('Ordered Trio', 3);
    const ratings = [1200, 800, 1000, 800];
    for (const [index, rating] of ratings.entries()) {
      const id = `ORDERED-${index + 1}`;
      const problem: Problem = {
        id,
        contestId: 0,
        index: id,
        name: id,
        rating,
        cfRating: null,
        tags: [],
        enabled: true,
        source: 'manual',
        statementHtml: null,
        timeLimit: null,
        memoryLimit: null,
        samples: [],
        extraTests: [],
        testCount: 0,
        needsChecker: false,
        fetchStatus: 'none',
        fetchError: null,
        fetchedAt: null,
      };
      store.state.problems.push(problem);
    }

    engine.start();
    const problemAt = (team: Team, slotIndex: number): string | undefined => {
      const attempt = engine.activeAttempt(team.slots[slotIndex]!);
      return attempt && store.state.problems.find((problem) => problem.id === attempt.problemId)?.id;
    };
    assert.deepEqual(firstTeam.slots.map((_, index) => problemAt(firstTeam, index)), ['ORDERED-2', 'ORDERED-4']);
    assert.deepEqual(secondTeam.slots.map((_, index) => problemAt(secondTeam, index)), ['ORDERED-2', 'ORDERED-4']);
    assert.deepEqual(trio.slots.map((_, index) => problemAt(trio, index)), ['ORDERED-2', 'ORDERED-4', 'ORDERED-3']);

    const firstSlot = firstTeam.slots[0]!;
    const secondSlot = firstTeam.slots[1]!;
    engine.solve(firstSlot, 0);
    assert.equal(problemAt(firstTeam, 0), 'ORDERED-3', 'solving should draw the next rating');
    const expiring = engine.activeAttempt(secondSlot)!;
    engine.finishAttempt(expiring, 'expired');
    engine.drawReplacement(firstTeam, secondSlot);
    assert.equal(problemAt(firstTeam, 1), 'ORDERED-1', 'expiry replacement should continue ascending order');
    engine.solve(firstSlot, 0);
    assert.equal(firstSlot.attemptId, null, 'the team should exhaust its ordered pool');
    engine.retryEmptySlots();
    engine.retryEmptySlots();
    assert.equal(
      store.state.log.filter((entry) => entry.msg.includes(`No more problems — well done! (${firstTeam.name}, slot ${firstSlot.id})`)).length,
      1,
      'ordered exhaustion should be logged once per slot',
    );

    const adminRedrawSlot = secondTeam.slots[0]!;
    engine.finishAttempt(engine.activeAttempt(adminRedrawSlot)!, 'skipped');
    engine.drawReplacement(secondTeam, adminRedrawSlot, undefined, 1200);
    assert.equal(problemAt(secondTeam, 0), 'ORDERED-3', 'ordered admin redraw should ignore rating overrides');
    engine.finishAttempt(engine.activeAttempt(adminRedrawSlot)!, 'skipped');
    engine.drawReplacement(secondTeam, adminRedrawSlot, 'ORDERED-1');
    assert.equal(problemAt(secondTeam, 0), 'ORDERED-1', 'explicit admin problem choice should be honoured');
  } finally {
    if (backend) await backend.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testDiskBackedLocalJudging(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'musical-chairs-disk-tests-'));
  let backend: Backend | null = null;
  try {
    const root = path.join(dataDir, 'tests');
    await mkdir(path.join(root, 'DISK3', 'tests'), { recursive: true });
    await mkdir(path.join(root, 'NEEDS-CHECKER', 'tests'), { recursive: true });
    for (const [name, input, output] of [
      ['001', '1\n', '1\n'],
      ['002', '2\n', '2\n'],
      ['003', '3\n', '3\n'],
    ]) {
      await writeFile(path.join(root, 'DISK3', 'tests', `${name}.in`), input);
      await writeFile(path.join(root, 'DISK3', 'tests', `${name}.out`), output);
    }
    await writeFile(path.join(root, 'DISK3', 'tests', '004.in'), 'unpaired\n');
    await writeFile(path.join(root, 'DISK3', 'tests', '005.out'), 'unpaired output\n');
    await writeFile(path.join(root, 'NEEDS-CHECKER', 'tests', '001.in'), 'yes\n');
    await writeFile(path.join(root, 'NEEDS-CHECKER', 'tests', '001.out'), 'YES\n');
    await writeFile(path.join(root, 'NEEDS-CHECKER', 'needs-checker'), '');

    backend = await createBackend({ dataDir, runner: fakeRunner });
    assert.equal(backend.store.state.config.judgeMode, 'local', 'fresh state defaults to local judging');
    const port = await backend.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const login = await request<{ token: string }>(base, '/api/admin/login', 'POST', {
      password: process.env.ADMIN_PASSWORD ?? 'admin',
    });
    const token = login.token;
    const empty = await request<Problem>(base, '/api/admin/problems/manual', 'POST', {
      id: 'EMPTY', name: 'No local tests', rating: 800,
    }, token);
    const diskProblem = await request<Problem>(base, '/api/admin/problems/manual', 'POST', {
      id: 'DISK3',
      name: 'Disk-backed problem',
      rating: 800,
      samples: [{ input: '1\n', output: '1\n' }, { input: '2\n', output: '2\n' }],
    }, token);
    const needsCheckerProblem = await request<Problem>(base, '/api/admin/problems/manual', 'POST', {
      id: 'NEEDS-CHECKER', name: 'Non-unique answer', rating: 800, enabled: true,
    }, token);
    assert.deepEqual(await scanProblemTests(root, '../DISK3'), { testCount: 0, needsChecker: false });
    assert.deepEqual(await loadProblemTests(root, '../DISK3'), { tests: [] });
    assert.equal(empty.testCount, 0);
    assert.equal(empty.needsChecker, false);
    assert.equal(diskProblem.testCount, 3, 'unpaired files are excluded from the test count');
    assert.equal(diskProblem.needsChecker, false);
    assert.equal(needsCheckerProblem.testCount, 1);
    assert.equal(needsCheckerProblem.needsChecker, true);
    backend.store.state.problems.find((problem) => problem.id === 'DISK3')!.testCount = 0;
    backend.store.state.problems.find((problem) => problem.id === 'NEEDS-CHECKER')!.needsChecker = false;
    const rescanned = await request<Problem[]>(base, '/api/admin/problems/rescan-tests', 'POST', {}, token);
    assert.equal(rescanned.find((problem) => problem.id === 'DISK3')?.testCount, 3);
    assert.equal(rescanned.find((problem) => problem.id === 'NEEDS-CHECKER')?.needsChecker, true);

    const team = await request<Team>(base, '/api/admin/teams', 'POST', { name: 'Disk team', size: 1 }, token);
    await request(base, '/api/admin/game/start', 'POST', {}, token);
    const activeAttempts = backend.store.state.attempts.filter((attempt) => attempt.outcome === 'active');
    assert.equal(activeAttempts.length, 1);
    assert.equal(activeAttempts[0]?.problemId, 'DISK3', 'local mode never draws the problem without tests');
    const connected = await connectSeat(base, team.seats[0]!.code);
    const view = await waitForView(connected.socket, (item) => item.slot.problem?.id === 'DISK3');
    const reply = await submit(connected.socket, view.slot.id, 'disk-run');
    assert.equal(reply.ok, true, reply.error);
    const judged = await waitForSubmission(base, token, reply.submissionId!);
    assert.equal(judged.verdict, 'WRONG_ANSWER');
    const details = await request<{ failedTest: number | null }>(
      base, `/api/admin/submissions/${reply.submissionId}`, 'GET', undefined, token,
    );
    assert.equal(details.failedTest, 3, 'disk test 3 fails after both sample tests pass');
    await request(base, `/api/admin/slots/${view.slot.id}/replace`, 'POST', { problemId: 'EMPTY' }, token);
    assert.equal(
      backend.engine.activeAttempt(backend.engine.findSlot(view.slot.id)!.slot)?.problemId,
      'EMPTY',
      'an explicit admin problem pick remains available without local tests',
    );
    connected.socket.disconnect();
    sockets.splice(sockets.indexOf(connected.socket), 1);
  } finally {
    if (backend) await backend.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function testSpecialAnswerComparison(): void {
  assert.equal(sameTokens('yes', 'YES'), true);
  assert.equal(sameTokens('Yes', 'YES'), true);
  assert.equal(sameTokens('NO', 'YES'), false);
  assert.equal(sameTokens('ABC', 'abc'), false);
}

async function testProblemMetadataMigration(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'musical-chairs-problem-migration-'));
  let backend: Backend | null = null;
  try {
    backend = await createBackend({ dataDir, runner: fakeRunner });
    backend.store.state.config.judgeMode = 'cf_self';
    backend.store.state.problems.push({
      id: 'LEGACY', contestId: 0, index: 'LEGACY', name: 'Legacy', rating: 800, cfRating: null,
      tags: [], enabled: true, source: 'manual', statementHtml: null, timeLimit: null, memoryLimit: null,
      samples: [], extraTests: [], testCount: 0, needsChecker: false, fetchStatus: 'ok', fetchError: null, fetchedAt: null,
    });
    await backend.store.save();
    await backend.close();
    backend = null;

    const statePath = path.join(dataDir, 'state.json');
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      problems: Array<Record<string, unknown>>;
    };
    delete persisted.problems[0]!.testCount;
    delete persisted.problems[0]!.needsChecker;
    await writeFile(statePath, JSON.stringify(persisted));
    backend = await createBackend({ dataDir, runner: fakeRunner });
    assert.equal(backend.store.state.problems[0]?.testCount, 0);
    assert.equal(backend.store.state.problems[0]?.needsChecker, false);
    assert.equal(backend.store.state.config.judgeMode, 'cf_self', 'saved judge modes are not overwritten by the new default');
    await backend.close();
    backend = null;
    const migrated = JSON.parse(await readFile(statePath, 'utf8')) as {
      problems: Array<Record<string, unknown>>;
    };
    assert.equal(migrated.problems[0]?.testCount, 0, 'legacy metadata migration is persisted');
    assert.equal(migrated.problems[0]?.needsChecker, false, 'legacy metadata migration is persisted');
  } finally {
    if (backend) await backend.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testTeamLazyModeMigration(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'musical-chairs-lazy-migration-'));
  let backend: Backend | null = null;
  try {
    backend = await createBackend({ dataDir, runner: fakeRunner });
    backend.store.state.config.lazyMode = true;
    backend.engine.createTeam('Legacy team', 1);
    await backend.close();
    backend = null;

    const statePath = path.join(dataDir, 'state.json');
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      teams: Array<Record<string, unknown>>;
    };
    delete persisted.teams[0]!.lazyMode;
    await writeFile(statePath, JSON.stringify(persisted));

    backend = await createBackend({ dataDir, runner: fakeRunner });
    assert.equal(backend.store.state.teams[0]?.lazyMode, true, 'legacy teams inherit the loaded config lazy mode');
  } finally {
    if (backend) await backend.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function testSlotUpdateAttemptGuards(): Promise<void> {
  const runScenario = async (lazyMode: boolean, maxRoundsPerProblem: number, size: number): Promise<void> => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'musical-chairs-slot-update-e2e-'));
    let backend: Backend | null = null;
    let socket: Socket | null = null;
    try {
      backend = await createBackend({ dataDir, runner: fakeRunner });
      const port = await backend.listen(0, '127.0.0.1');
      const base = `http://127.0.0.1:${port}`;
      const login = await request<{ token: string }>(base, '/api/admin/login', 'POST', {
        password: process.env.ADMIN_PASSWORD ?? 'admin',
      });
      const token = login.token;
      await request(base, '/api/admin/config', 'PUT', {
        autoAdvance: true,
        judgeMode: 'manual',
        lazyMode,
        lazyTransitionSeconds: 0,
        maxRoundsPerProblem,
        roundMinutes: 10,
        transitionSeconds: 0,
        uniqueness: 'team',
      }, token);
      const team = await request<Team>(base, '/api/admin/teams', 'POST', {
        name: lazyMode ? 'Lazy flush' : 'Physical flush',
        size,
      }, token);
      for (const id of ['ROT-A', 'ROT-B', 'ROT-C']) {
        await request(base, '/api/admin/problems/manual', 'POST', {
          id,
          name: id,
          rating: 800,
          samples: [],
        }, token);
      }
      const connected = await connectSeat(base, team.seats[0]!.code);
      socket = connected.socket;
      await request(base, '/api/admin/game/start', 'POST', {}, token);
      const initial = await waitForView(socket, (view) =>
        view.clock.phase === 'running' && view.slot.attemptStartedAt !== null && view.slot.problem !== null);
      const slotId = initial.slot.id;
      const oldAttemptStartedAt = initial.slot.attemptStartedAt!;
      const oldProblemId = initial.slot.problem!.id;

      if (!lazyMode) {
        const oldCode = 'old problem code';
        const initialUpdate = await updateSlot(socket, {
          slotId,
          lang: 'cpp20',
          code: oldCode,
          input: 'old problem input',
          attemptStartedAt: oldAttemptStartedAt,
        });
        assert.deepEqual(initialUpdate, { ok: true }, 'the active attempt accepts its edits');
        assert.equal(backend.store.state.teams[0]?.slots[0]?.code.cpp20, oldCode);
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      await request(base, '/api/admin/game/next-round', 'POST', {}, token);

      if (!lazyMode) {
        const rotated = await waitForView(socket, (view) =>
          view.clock.phase === 'running'
          && view.slot.id === slotId
          && view.slot.attemptStartedAt !== null
          && view.slot.attemptStartedAt !== oldAttemptStartedAt);
        const slot = backend.engine.findSlot(slotId)!.slot;
        const newAttempt = backend.engine.activeAttempt(slot);
        assert.ok(newAttempt);
        assert.equal(newAttempt.outcome, 'active');
        assert.notEqual(newAttempt.problemId, oldProblemId, 'expiration draws a new problem');
        const template = backend.store.state.languages.find((language) => language.id === 'cpp20')!.template;
        assert.equal(slot.code.cpp20, template, 'rotation resets code to the new problem template');

        const stale = await updateSlot(socket, {
          slotId,
          lang: 'py3',
          code: 'stale code',
          input: 'stale input',
          attemptStartedAt: oldAttemptStartedAt,
        });
        assert.deepEqual(stale, { ok: false, error: 'Problem changed' });
        assert.equal(slot.lang, 'cpp20', 'stale language changes are rejected');
        assert.equal(slot.code.cpp20, template, 'stale code is rejected');
        assert.equal(slot.input, '', 'stale input is rejected');

        const current = await updateSlot(socket, {
          slotId,
          lang: 'py3',
          code: 'current code',
          input: 'current input',
          attemptStartedAt: rotated.slot.attemptStartedAt,
        });
        assert.deepEqual(current, { ok: true }, 'the current attempt accepts its edits');
        assert.equal(slot.lang, 'py3');
        assert.equal(slot.code.py3, 'current code');
        assert.equal(slot.input, 'current input');
      } else {
        const slot = backend.engine.findSlot(slotId)!.slot;
        const attempt = backend.engine.activeAttempt(slot);
        assert.ok(attempt);
        assert.equal(attempt.startedAt, oldAttemptStartedAt, 'lazy rotation keeps the same attempt');
        assert.equal(slot.seatIndex, 1, 'lazy rotation moves the slot away from its old seat');
        const lateFlush = await updateSlot(socket, {
          slotId,
          lang: 'cpp20',
          code: 'late lazy code',
          input: 'late lazy input',
          attemptStartedAt: oldAttemptStartedAt,
        });
        assert.deepEqual(lateFlush, { ok: true }, 'a matching late lazy flush remains accepted');
        assert.equal(slot.code.cpp20, 'late lazy code');
        assert.equal(slot.input, 'late lazy input');
      }
    } finally {
      if (socket) {
        socket.disconnect();
        latestViews.delete(socket);
        const index = sockets.indexOf(socket);
        if (index >= 0) sockets.splice(index, 1);
      }
      if (backend) await backend.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };

  await runScenario(false, 1, 1);
  await runScenario(true, 2, 2);
}

async function run(): Promise<void> {
  testSpecialAnswerComparison();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'musical-chairs-e2e-'));
  let backend: Backend | null = null;
  try {
    await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
      config: {},
      languages: DEFAULT_LANGUAGES.map((language) =>
        Object.fromEntries(Object.entries(language).filter(([key]) => !['compile', 'run', 'processes'].includes(key))),
      ),
    }));
    backend = await createBackend({ dataDir, runner: fakeRunner });
    assert.equal(backend.store.state.config.runTimeLimitMs, 2000);
    assert.equal(backend.store.state.config.runMemoryMb, 256);
    assert.equal(backend.store.state.config.compileTimeLimitMs, 15000);
    assert.equal(backend.store.state.config.maxOutputMb, 64);
    assert.equal(backend.store.state.config.judgeMode, 'local');
    assert.equal(backend.store.state.config.difficultyMode, 'dynamic');
    assert.equal(backend.store.state.config.selfSubmitPollSeconds, 5);
    assert.equal(backend.store.state.config.selfSubmitColdPollSeconds, 60);
    assert.equal(backend.store.state.config.selfSubmitHotMinutes, 5);
    assert.equal(backend.store.state.config.selfSubmitClientPolling, false);
    assert.equal(backend.store.state.config.selfSubmitGraceSeconds, 30);
    assert.ok(backend.store.state.config.maxConcurrentRuns > 0 && backend.store.state.config.maxConcurrentRuns <= 4);
    assert.ok(backend.store.state.languages.find((language) => language.id === 'cpp20')?.compile?.length);
    assert.deepEqual(backend.store.state.languages.find((language) => language.id === 'py3')?.run, ['python3', '{src}']);
    const port = await backend.listen(0, '127.0.0.1');
    let base = `http://127.0.0.1:${port}`;
    const login = await request<{ token: string }>(base, '/api/admin/login', 'POST', {
      password: process.env.ADMIN_PASSWORD ?? 'admin',
    });
    const token = login.token;
    await request(base, '/api/admin/config', 'PUT', {
      roundMinutes: 0.25,
      transitionSeconds: 4,
      lazyTransitionSeconds: 1,
      submissionCooldownSeconds: 0,
      uniqueness: 'global',
      judgeMode: 'local',
    }, token);

    const team2 = await request<Team>(base, '/api/admin/teams', 'POST', { name: 'Duo', size: 2 }, token);
    const team3 = await request<Team>(base, '/api/admin/teams', 'POST', { name: 'Trio', size: 3 }, token);
    const ratings = [800, 800, 800, 800, 800, 1000, 1000, 1000, 1200, 1200];
    for (let i = 0; i < ratings.length; i += 1) {
      await request(base, '/api/admin/problems/manual', 'POST', {
        id: `M${i + 1}`,
        name: `Manual ${i + 1}`,
        rating: ratings[i],
        timeLimit: '1 second',
        memoryLimit: '128 megabytes',
        samples: [{ input: '3 4\n', output: '7\n' }],
        extraTests: [{ input: '10 -2\n', output: '8\n' }],
      }, token);
    }

    const joined: Array<{ team: Team; seatIndex: number; socket: Socket; view: SeatView }> = [];
    for (const team of [team2, team3]) {
      for (const seat of team.seats) {
        const connected = await connectSeat(base, seat.code);
        joined.push({ team, seatIndex: seat.index, socket: connected.socket, view: connected.view });
      }
    }
    const initialViews = Promise.all(joined.map(async (entry) => {
      entry.view = await waitForView(entry.socket, (view) => Boolean(view.slot.problem));
    }));
    await request(base, '/api/admin/game/start', 'POST', {}, token);
    await initialViews;
    const initialIds = joined.map((entry) => entry.view.slot.problem?.id);
    assert.equal(new Set(initialIds).size, joined.length, 'every seat should receive a distinct problem');
    const slotsAtSeats = new Map(joined.map((entry) => [
      `${entry.team.id}:${entry.seatIndex}`, entry.view.slot.id,
    ]));

    const solving = joined.find((entry) => entry.team.id === team2.id && entry.seatIndex === 0)!;
    const correctCode = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){long long a,b;if(cin>>a>>b)cout<<a+b<<"\\n";}\n';
    let submissionReply = await submit(solving.socket, solving.view.slot.id, correctCode);
    assert.equal(submissionReply.ok, true, submissionReply.error);
    const accepted = await waitForSubmission(base, token, submissionReply.submissionId!);
    assert.equal(accepted.verdict, 'OK');
    assert.deepEqual(lastRunLimits, { timeMs: 1000, memoryMb: 128 });
    type AdminSnapshot = {
      attempts: Attempt[];
      teams: Team[];
      clock: { roundEndsAt: number | null; transitionEndsAt: number | null };
    };
    let admin = await request<AdminSnapshot>(
      base, '/api/admin/state', 'GET', undefined, token,
    );
    const solved = admin.attempts.find((attempt) => attempt.slotId === solving.view.slot.id && attempt.outcome === 'solved');
    assert.ok(solved);
    const solvingSlot = admin.teams.flatMap((team) => team.slots).find((slot) => slot.id === solving.view.slot.id)!;
    assert.equal(solvingSlot.nextRating, 1000, 'a quick solve should apply the +200 solved rule');
    const newProblem = solvingSlot.attemptId && admin.attempts.find((attempt) => attempt.id === solvingSlot.attemptId);
    assert.ok(newProblem);
    assert.equal(newProblem.rating, 1000, 'replacement should draw from the expected rating bucket');

    submissionReply = await submit(
      solving.socket, solving.view.slot.id, '#include <bits/stdc++.h>\nusing namespace std;\nint main(){cout<<"wrong\\n";}\n',
    );
    assert.equal(submissionReply.ok, true, submissionReply.error);
    const rejected = await waitForSubmission(base, token, submissionReply.submissionId!);
    assert.equal(rejected.verdict, 'WRONG_ANSWER');

    const runResult = await new Promise<RunResult>((resolve) => {
      solving.socket.emit('run', {
        slotId: solving.view.slot.id,
        lang: 'cpp20',
        code: correctCode,
        input: '3 4\n',
      }, resolve);
    });
    assert.equal(runResult.status, 'ok', runResult.stderr);
    assert.equal(runResult.stdout.trim(), '7');

    const displayLimitedRun = await new Promise<RunResult>((resolve) => {
      solving.socket.emit('run', {
        slotId: solving.view.slot.id,
        lang: 'cpp20',
        code: 'display-cap',
        input: '',
      }, resolve);
    });
    assert.equal(displayLimitedRun.stdout.length, 64 * 1024);
    assert.equal(displayLimitedRun.truncated, true);

    await request(base, '/api/admin/config', 'PUT', { judgeMode: 'codeforces' }, token);
    const noAccountSubmission = await submit(solving.socket, solving.view.slot.id, correctCode);
    assert.equal(noAccountSubmission.ok, true, noAccountSubmission.error);
    const noAccountResult = await waitForSubmission(base, token, noAccountSubmission.submissionId!);
    assert.equal(noAccountResult.status, 'error');
    const noAccountDetail = await request<{ message: string | null }>(
      base, `/api/admin/submissions/${noAccountSubmission.submissionId}`, 'GET', undefined, token,
    );
    assert.match(noAccountDetail.message ?? '', /No enabled Codeforces account is configured/);
    await request(base, '/api/admin/config', 'PUT', { judgeMode: 'local' }, token);

    const transitionViews = await waitForPhase(joined, 'transition');
    const transitionView = transitionViews[joined.findIndex((entry) => entry.socket === solving.socket)]!;
    assert.equal(transitionView.lock?.reason, 'transition');
    assert.ok(typeof transitionView.lock?.until === 'number');
    admin = await request<AdminSnapshot>(base, '/api/admin/state', 'GET', undefined, token);
    const physicalSlots = admin.teams.flatMap((team) => team.slots);
    for (const entry of joined) {
      const slot = physicalSlots.find((item) => item.id === slotsAtSeats.get(`${entry.team.id}:${entry.seatIndex}`));
      assert.equal(slot?.seatIndex, entry.seatIndex, 'physical rotation keeps slot ids at their seats');
    }
    await request(base, `/api/admin/teams/${team2.id}`, 'PUT', { lazyMode: true }, token);
    await request(base, `/api/admin/teams/${team3.id}`, 'PUT', { lazyMode: false }, token);
    await waitForPhase(joined, 'running', 2);
    const mixedBefore = await request<AdminSnapshot>(base, '/api/admin/state', 'GET', undefined, token);
    await waitForPhase(joined, 'transition');
    const mixedTransition = await request<AdminSnapshot>(base, '/api/admin/state', 'GET', undefined, token);
    const transitionEndsAt = mixedTransition.clock.transitionEndsAt;
    assert.ok(transitionEndsAt, 'mixed-mode transition has an end time');
    const transitionRemainingMs = transitionEndsAt! - Date.now();
    assert.ok(
      transitionRemainingMs > 1500 && transitionRemainingMs <= 4000,
      `mixed transition should use the physical duration (remaining ${transitionRemainingMs}ms)`,
    );
    for (const team of mixedTransition.teams) {
      const before = mixedBefore.teams.find((item) => item.id === team.id)!;
      for (const slot of team.slots) {
        const oldIndex = before.slots.find((item) => item.id === slot.id)?.seatIndex;
        if (oldIndex === undefined) continue;
        const expected = team.id === team2.id ? (oldIndex - 1 + team.size) % team.size : oldIndex;
        assert.equal(slot.seatIndex, expected, team.id === team2.id
          ? 'lazy team shifts slots during mixed rotation'
          : 'physical team keeps slot indices during mixed rotation');
      }
    }

    await request(base, '/api/admin/config', 'PUT', { lazyMode: true }, token);
    await waitForPhase(joined, 'running', 3);
    const lazyBeforeState = await request<AdminSnapshot>(base, '/api/admin/state', 'GET', undefined, token);
    assert.ok(lazyBeforeState.teams.every((team) => team.lazyMode), 'global lazy mode sets all existing teams');
    const lazyBefore = new Map(lazyBeforeState.teams.flatMap((team) => team.slots.map((slot) => [slot.id, slot.seatIndex])));
    await waitForPhase(joined, 'transition');
    await waitForPhase(joined, 'running', 4);
    admin = await request<AdminSnapshot>(base, '/api/admin/state', 'GET', undefined, token);
    for (const team of admin.teams) {
      for (const slot of team.slots) {
        const oldIndex = lazyBefore.get(slot.id);
        if (oldIndex !== undefined) {
          assert.equal(slot.seatIndex, (oldIndex - 1 + team.size) % team.size, 'lazy rotation shifts slots by one');
        }
      }
    }
    assert.ok(admin.attempts.some((attempt) =>
      attempt.teamId === team2.id && attempt.startRound === 1 && attempt.outcome === 'expired'),
    'unsolved problems expire after team-size rounds');
    for (const team of admin.teams) {
      const used = admin.attempts.filter((attempt) => attempt.teamId === team.id).map((attempt) => attempt.problemId);
      assert.equal(new Set(used).size, used.length, `team ${team.name} never repeats a problem`);
    }

    const beforePause = admin.clock.roundEndsAt!;
    await request(base, '/api/admin/game/pause', 'POST', {}, token);
    const paused = await request<{ clock: { pausedRemainingMs: number | null } }>(base, '/api/admin/state', 'GET', undefined, token);
    assert.equal(paused.clock.pausedRemainingMs !== null, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const remaining = paused.clock.pausedRemainingMs!;
    await request(base, '/api/admin/game/resume', 'POST', {}, token);
    const resumed = await request<{ clock: { roundEndsAt: number | null } }>(base, '/api/admin/state', 'GET', undefined, token);
    assert.ok(resumed.clock.roundEndsAt);
    assert.ok(Math.abs((resumed.clock.roundEndsAt! - Date.now()) - remaining) < 250);
    assert.ok(beforePause > Date.now() - 10_000);

    for (const socket of sockets) socket.disconnect();
    sockets.length = 0;
    await backend.close();
    backend = null;
    const restarted = await createBackend({ dataDir });
    backend = restarted;
    const restartedPort = await restarted.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${restartedPort}`;
    const restored = await request<{ token: string }>(
      base, '/api/admin/login', 'POST', { password: process.env.ADMIN_PASSWORD ?? 'admin' },
    );
    const resumedState = await request<{ clock: { phase: string; round: number; roundEndsAt: number | null } }>(
      base, '/api/admin/state', 'GET', undefined, restored.token,
    );
    assert.equal(resumedState.clock.phase, 'running', 'restart should restore running phase');
    assert.equal(resumedState.clock.round, 4);
    assert.ok(resumedState.clock.roundEndsAt);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const timerAfterRestart = await request<{ clock: { roundEndsAt: number | null } }>(
      base, '/api/admin/state', 'GET', undefined, restored.token,
    );
    assert.equal(timerAfterRestart.clock.roundEndsAt, resumedState.clock.roundEndsAt, 'persisted deadline continues after restart');
    const afterRestartSeat = await connectSeat(base, team2.seats[0]!.code);
    await waitForView(afterRestartSeat.socket, (view) => view.clock.phase === 'running' && view.clock.round === 5, 30_000);

    for (const socket of sockets) socket.disconnect();
    sockets.length = 0;
    await backend.close();
    backend = null;
    await runSelfSubmitE2e();
    await testDiskBackedLocalJudging();
    await testProblemMetadataMigration();
    await testOrderedDifficulty();
    await testTeamLazyModeMigration();
    await testSlotUpdateAttemptGuards();
    console.log('E2E PASS: auth, teams/seats, local disk tests/needs-checker metadata/rescan/migration/draw, sample fallback, stale slot-update rejection, lazy late flush, lazy rotation, expiry, pause/resume, restart persistence, defaults migration, self-submit polling');
  } finally {
    for (const socket of sockets) socket.disconnect();
    if (backend) await backend.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
