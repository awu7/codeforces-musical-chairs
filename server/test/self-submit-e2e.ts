import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connectSocket, type Socket } from 'socket.io-client';
import type { Problem, Seat, Team } from '../../shared/types.js';
import { createBackend, type Backend } from '../src/index.js';
import type { SelfSubmitApi } from '../src/judge/self-submit.js';

function makeProblem(contestId: number): Problem {
  return {
    id: `${contestId}A`,
    contestId,
    index: 'A',
    name: `Problem ${contestId}A`,
    rating: 800,
    cfRating: 800,
    tags: [],
    enabled: true,
    source: 'codeforces',
    statementHtml: null,
    timeLimit: '1 second',
    memoryLimit: '256 megabytes',
    samples: [],
    extraTests: [],
    testCount: 0,
    needsChecker: false,
    fetchStatus: 'ok',
    fetchError: null,
    fetchedAt: Date.now(),
  };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function emitAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event} ack`)), 3000);
    socket.emit(event, payload, (reply: T) => {
      clearTimeout(timeout);
      resolve(reply);
    });
  });
}

async function connectSeat(port: number, code: string): Promise<Socket> {
  const socket = connectSocket(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const joined = await emitAck<{ ok: boolean; error?: string }>(socket, 'seat:join', { code });
  assert.equal(joined.ok, true, joined.error);
  return socket;
}

function currentAttempt(backend: Backend, teamId: string, seatIndex = 0) {
  const team = backend.store.state.teams.find((item) => item.id === teamId)!;
  const slot = team.slots.find((item) => item.seatIndex === seatIndex)!;
  const attempt = backend.store.state.attempts.find((item) => item.id === slot.attemptId)!;
  return { team, slot, attempt };
}

function cfSubmission(
  id: number,
  attempt: ReturnType<typeof currentAttempt>['attempt'],
  verdict: string,
  offsetMs = 1000,
) {
  const problem = {
    contestId: Number(attempt.problemId.match(/^\d+/)?.[0]),
    index: attempt.problemId.replace(/^\d+/, ''),
  };
  return {
    id,
    creationTimeSeconds: Math.floor((attempt.startedAt + offsetMs) / 1000),
    problem,
    verdict,
    programmingLanguage: 'GNU C++20 (64)',
    passedTestCount: verdict === 'OK' ? 3 : 1,
    timeConsumedMillis: 12,
    memoryConsumedBytes: 4096,
  };
}

function countHandle(calls: string[], handle: string): number {
  return calls.filter((item) => item === handle).length;
}

async function testLegacyHandleMigration(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'musical-chairs-self-submit-migration-'));
  let backend: Backend | null = null;
  try {
    backend = await createBackend({ dataDir });
    const team = backend.engine.createTeam('Legacy team', 2);
    const legacyTeam = team as Team & { cfHandle?: string; selfSubmitStatus?: unknown };
    legacyTeam.cfHandle = 'legacyHandle';
    delete legacyTeam.selfSubmitStatus;
    for (const seat of team.seats) {
      delete (seat as Partial<Seat>).cfHandle;
      delete (seat as Partial<Seat>).selfSubmitStatus;
      delete (seat as Partial<Seat>).submitClickedAt;
      delete (seat as Partial<Seat>).refreshRequestedAt;
    }
    await backend.store.save();
    await backend.close();
    backend = await createBackend({ dataDir });
    const migrated = backend.store.state.teams.find((item) => item.id === team.id)!;
    assert.equal((migrated as Team & { cfHandle?: string }).cfHandle, undefined);
    assert.ok(migrated.seats.every((seat) => seat.cfHandle === 'legacyHandle'));
    assert.ok(migrated.seats.every((seat) => seat.selfSubmitStatus.lastPollAt === null));
    assert.ok(migrated.seats.every((seat) => seat.selfSubmitStatus.lastError === null));
    assert.ok(migrated.seats.every((seat) => seat.submitClickedAt === null));
    assert.ok(migrated.seats.every((seat) => seat.refreshRequestedAt === null));
  } finally {
    if (backend) await backend.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function runSelfSubmitE2e(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'musical-chairs-self-submit-'));
  const polledHandles: string[] = [];
  const responseRows = new Map<string, Array<Record<string, unknown>>>();
  const api: SelfSubmitApi = {
    async userStatus(handle, count) {
      assert.equal(count, 30);
      polledHandles.push(handle);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return responseRows.get(handle) ?? [];
    },
  };
  let backend: Backend | null = null;
  let seatASocket: Socket | null = null;
  let seatBSocket: Socket | null = null;
  try {
    backend = await createBackend({ dataDir, selfSubmitApi: api });
    backend.store.state.config.judgeMode = 'cf_self';
    backend.store.state.config.roundMinutes = 60;
    backend.store.state.config.selfSubmitPollSeconds = 0.05;
    backend.store.state.config.selfSubmitColdPollSeconds = 60;
    backend.store.state.config.selfSubmitHotMinutes = 5;
    backend.store.state.config.selfSubmitGraceSeconds = 30;
    backend.store.state.problems.push(...Array.from({ length: 12 }, (_, index) => makeProblem(3000 + index)));
    const team = backend.engine.createTeam('Self-submit team', 2);
    const noHandleTeam = backend.engine.createTeam('No handle team', 1);
    const port = await backend.listen(0, '127.0.0.1');
    seatASocket = await connectSeat(port, team.seats[0]!.code);
    seatBSocket = await connectSeat(port, team.seats[1]!.code);

    const invalid = await emitAck<{ ok: boolean; error?: string }>(seatASocket, 'seat:setHandle', { handle: 'ab' });
    assert.equal(invalid.ok, false, 'invalid handles must be rejected');
    const savedA = await emitAck<{ ok: boolean; handle?: string }>(seatASocket, 'seat:setHandle', { handle: ' handleSeatA ' });
    assert.equal(savedA.ok, true);
    assert.equal(savedA.handle, 'handleSeatA');

    backend.engine.start();
    const savedB = await emitAck<{ ok: boolean; handle?: string }>(seatBSocket, 'seat:setHandle', { handle: 'handleSeatB' });
    assert.equal(savedB.ok, true, 'seat handles may be changed after the game starts');
    await waitFor(
      () => countHandle(polledHandles, 'handleSeatA') > 0 && countHandle(polledHandles, 'handleSeatB') > 0,
      'polling both configured seat handles',
    );
    assert.ok(polledHandles.every((handle) => handle === 'handleSeatA' || handle === 'handleSeatB'));
    assert.ok(backend.store.state.teams.find((item) => item.id === noHandleTeam.id)!.seats.every((seat) => !seat.cfHandle));

    const seatA = backend.store.state.teams.find((item) => item.id === team.id)!.seats[0]!;
    seatA.selfSubmitStatus.lastPollAt = Date.now() - 6000;
    seatA.submitClickedAt = null;
    seatA.refreshRequestedAt = null;
    const pollsBeforeRefresh = countHandle(polledHandles, 'handleSeatA');
    const refresh = await emitAck<{ ok: boolean; refreshRequestedAt?: number }>(seatASocket, 'seat:refreshVerdicts', {});
    assert.equal(refresh.ok, true);
    const duplicateRefresh = await emitAck<{ ok: boolean; error?: string }>(seatASocket, 'seat:refreshVerdicts', {});
    assert.equal(duplicateRefresh.ok, false);
    assert.equal(duplicateRefresh.error, 'Just checked — wait a few seconds');
    await waitFor(() => countHandle(polledHandles, 'handleSeatA') > pollsBeforeRefresh, 'refreshing a cold seat before its cold interval');
    assert.ok(seatA.selfSubmitStatus.lastPollAt! >= refresh.refreshRequestedAt!);
    assert.ok(Date.now() - refresh.refreshRequestedAt! < 5000, 'refresh should bypass the cold interval');

    seatA.submitClickedAt = Date.now() - 6 * 60_000;
    const attemptInSeatA = currentAttempt(backend, team.id, 0);
    const clientVerdict = cfSubmission(1003, attemptInSeatA.attempt, 'OK');
    const disabledClientVerdict = await emitAck<{ ok: boolean }>(seatBSocket, 'seat:cfVerdict', { submission: clientVerdict });
    assert.equal(disabledClientVerdict.ok, false, 'browser verdicts are rejected when client polling is disabled');
    backend.store.state.config.selfSubmitClientPolling = true;
    backend.store.changed();
    const unrelatedClientVerdict = cfSubmission(1002, attemptInSeatA.attempt, 'OK');
    unrelatedClientVerdict.problem = { contestId: 9999, index: 'B' };
    const ignoredClientVerdict = await emitAck<{ ok: boolean; applied?: boolean }>(seatBSocket, 'seat:cfVerdict', { submission: unrelatedClientVerdict });
    assert.equal(ignoredClientVerdict.ok, true);
    assert.equal(ignoredClientVerdict.applied, false, 'a browser verdict for a non-current problem is ignored');
    assert.ok(!team.processedCfSubmissionIds.includes(1002));
    const clientResult = await emitAck<{ ok: boolean; applied?: boolean }>(seatBSocket, 'seat:cfVerdict', { submission: clientVerdict });
    assert.equal(clientResult.ok, true);
    assert.equal(clientResult.applied, true);
    await waitFor(
      () => currentAttempt(backend!, team.id, 0).attempt.id !== attemptInSeatA.attempt.id,
      'a browser-reported OK from seat B solving seat A’s slot',
    );
    const submission = backend.store.state.submissions.find((item) => item.cfSubmissionId === 1003)!;
    assert.equal(attemptInSeatA.attempt.outcome, 'solved');
    assert.equal(submission.source, 'self');
    assert.equal(submission.judge, 'cf_self');
    assert.equal(submission.lang, 'cpp20');
    assert.equal(submission.code, '');
    assert.equal(submission.seatIndex, attemptInSeatA.slot.seatIndex);
    responseRows.set('handleSeatB', [clientVerdict]);
    const callsBeforeClick = countHandle(polledHandles, 'handleSeatB');
    const click = await emitAck<{ ok: boolean }>(seatBSocket, 'seat:submitClicked', {});
    assert.equal(click.ok, true);
    await waitFor(() => countHandle(polledHandles, 'handleSeatB') > callsBeforeClick, 'server polling the client-discovered verdict');
    assert.equal(backend.store.state.submissions.filter((item) => item.cfSubmissionId === 1003).length, 1, 'client and server polling must deduplicate by CF id');
    const callsAfterFirstHotPoll = countHandle(polledHandles, 'handleSeatB');
    assert.ok(callsAfterFirstHotPoll > callsBeforeClick);
    const coldCalls = countHandle(polledHandles, 'handleSeatA');
    await waitFor(() => countHandle(polledHandles, 'handleSeatB') >= callsAfterFirstHotPoll + 2, 'repeated hot polling');
    assert.equal(countHandle(polledHandles, 'handleSeatA'), coldCalls, 'the cold seat must not be re-polled during hot polling');

    let current = currentAttempt(backend, team.id, 0);
    const beforeIgnored = backend.store.state.submissions.length;
    const differentProblem = cfSubmission(1004, current.attempt, 'OK');
    differentProblem.problem = { contestId: 9999, index: 'B' };
    responseRows.set('handleSeatB', [differentProblem]);
    const pollsBeforeDifferent = countHandle(polledHandles, 'handleSeatB');
    await waitFor(() => countHandle(polledHandles, 'handleSeatB') > pollsBeforeDifferent, 'ignoring a different problem');
    assert.equal(current.attempt.outcome, 'active');
    assert.equal(backend.store.state.submissions.length, beforeIgnored);
    assert.ok(!current.team.processedCfSubmissionIds.includes(1004));

    const tooOld = cfSubmission(1005, current.attempt, 'OK', -120_000);
    responseRows.set('handleSeatB', [tooOld]);
    const pollsBeforeOld = countHandle(polledHandles, 'handleSeatB');
    await waitFor(() => countHandle(polledHandles, 'handleSeatB') > pollsBeforeOld, 'ignoring a submission older than the grace window');
    assert.equal(current.attempt.outcome, 'active');
    assert.equal(backend.store.state.submissions.length, beforeIgnored);
    assert.ok(!current.team.processedCfSubmissionIds.includes(1005));

    const wrong = cfSubmission(1006, current.attempt, 'WRONG_ANSWER');
    responseRows.set('handleSeatB', [wrong]);
    await waitFor(() => current.team.processedCfSubmissionIds.includes(1006), 'recording a wrong answer');
    assert.equal(current.attempt.wrongSubmissions, 1);
    const wrongSubmissionCount = backend.store.state.submissions.filter((item) => item.cfSubmissionId === 1006).length;
    const pollsAfterWrong = countHandle(polledHandles, 'handleSeatB');
    await waitFor(() => countHandle(polledHandles, 'handleSeatB') >= pollsAfterWrong + 2, 're-polling the same wrong answer');
    assert.equal(current.attempt.wrongSubmissions, 1, 'a repeated wrong verdict increments the count once');
    assert.equal(backend.store.state.submissions.filter((item) => item.cfSubmissionId === 1006).length, wrongSubmissionCount);

    const pending = cfSubmission(1007, current.attempt, 'TESTING');
    responseRows.set('handleSeatB', [pending]);
    const pollsBeforePending = countHandle(polledHandles, 'handleSeatB');
    await waitFor(() => countHandle(polledHandles, 'handleSeatB') > pollsBeforePending, 'polling a testing submission');
    assert.ok(!current.team.processedCfSubmissionIds.includes(1007), 'TESTING must remain unprocessed');
    assert.equal(current.attempt.outcome, 'active');
    responseRows.set('handleSeatB', [cfSubmission(1007, current.attempt, 'OK')]);
    await waitFor(() => currentAttempt(backend!, team.id, 0).attempt.id !== current.attempt.id, 'later OK to solve the active attempt');
    assert.equal(backend.store.state.submissions.filter((item) => item.cfSubmissionId === 1007).length, 1);
    assert.equal(current.attempt.outcome, 'solved');

    await backend.store.save();
    const submissionCount = backend.store.state.submissions.length;
    const solveCount = backend.store.state.attempts.filter((item) => item.teamId === team.id && item.outcome === 'solved').length;
    const callsBeforeRestart = countHandle(polledHandles, 'handleSeatB');
    seatASocket.disconnect();
    seatBSocket.disconnect();
    seatASocket = null;
    seatBSocket = null;
    await backend.close();
    backend = await createBackend({ dataDir, selfSubmitApi: api });
    await waitFor(() => countHandle(polledHandles, 'handleSeatB') > callsBeforeRestart, 'polling after store reload');
    assert.equal(backend.store.state.submissions.length, submissionCount, 'reloading the store must not double-record the same Codeforces submission');
    assert.equal(backend.store.state.attempts.filter((item) => item.teamId === team.id && item.outcome === 'solved').length, solveCount);
    const persistedTeam = backend.store.state.teams.find((item) => item.id === team.id)!;
    assert.ok(persistedTeam.processedCfSubmissionIds.includes(1007));
    assert.deepEqual(persistedTeam.seats.map((seat) => seat.cfHandle), ['handleSeatA', 'handleSeatB']);
    const persistedNoHandle = backend.store.state.teams.find((item) => item.id === noHandleTeam.id)!;
    assert.ok(persistedNoHandle.seats.every((seat) => !seat.cfHandle));
    assert.ok(polledHandles.every((handle) => handle === 'handleSeatA' || handle === 'handleSeatB'));
  } finally {
    seatASocket?.disconnect();
    seatBSocket?.disconnect();
    if (backend) await backend.close();
    await rm(dataDir, { recursive: true, force: true });
  }
  await testLegacyHandleMigration();
  console.log('SELF-SUBMIT E2E PASS: per-seat handles, validation/persistence/migration, client verdict ingestion and toggle, server/client deduplication, cross-seat slot matching, hot/cold polling, refresh priority/cooldown, stale filtering, duplicate verdicts, TESTING then OK, restart deduplication, no-handle seats skipped');
}
