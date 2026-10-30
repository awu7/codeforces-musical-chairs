import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connectSocket, type Socket } from 'socket.io-client';
import type { Attempt, RunResult, SeatView, Team } from '../../shared/types.js';
import { DEFAULT_LANGUAGES } from '../src/defaults.js';
import { createBackend, type Backend } from '../src/index.js';
import type { Runner } from '../src/isolate.js';
import { runSelfSubmitE2e } from './self-submit-e2e.js';

const sockets: Socket[] = [];
const latestViews = new Map<Socket, SeatView>();
let lastRunLimits: { timeMs: number; memoryMb: number } | undefined;
const fakeRunner: Runner = {
  async run(_language, code, input, limits): Promise<RunResult> {
    lastRunLimits = limits;
    const outputs = new Map([['3 4\n', '7\n'], ['10 -2\n', '8\n']]);
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

async function run(): Promise<void> {
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
    assert.equal(backend.store.state.config.selfSubmitPollSeconds, 5);
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
      transitionSeconds: 2,
      lazyTransitionSeconds: 2,
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
    type AdminSnapshot = { attempts: Attempt[]; teams: Team[]; clock: { roundEndsAt: number | null } };
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
    await request(base, '/api/admin/config', 'PUT', { lazyMode: true }, token);
    await waitForPhase(joined, 'running', 2);
    const lazyBefore = new Map(admin.teams.flatMap((team) => team.slots.map((slot) => [slot.id, slot.seatIndex])));
    await waitForPhase(joined, 'transition');
    await waitForPhase(joined, 'running', 3);
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
    assert.equal(resumedState.clock.round, 3);
    assert.ok(resumedState.clock.roundEndsAt);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const timerAfterRestart = await request<{ clock: { roundEndsAt: number | null } }>(
      base, '/api/admin/state', 'GET', undefined, restored.token,
    );
    assert.equal(timerAfterRestart.clock.roundEndsAt, resumedState.clock.roundEndsAt, 'persisted deadline continues after restart');
    const afterRestartSeat = await connectSeat(base, team2.seats[0]!.code);
    await waitForView(afterRestartSeat.socket, (view) => view.clock.phase === 'running' && view.clock.round === 4, 30_000);

    for (const socket of sockets) socket.disconnect();
    sockets.length = 0;
    await backend.close();
    backend = null;
    await runSelfSubmitE2e();
    console.log('E2E PASS: auth, teams/seats, distinct draw, local accept/reject, injected run, physical/lazy rotation, expiry, pause/resume, restart persistence, defaults migration, self-submit polling');
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
