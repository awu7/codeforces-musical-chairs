import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Problem, Team } from '../../shared/types.js';
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

function currentAttempt(backend: Backend, teamId: string) {
  const team = backend.store.state.teams.find((item) => item.id === teamId)!;
  const slot = team.slots[0]!;
  const attempt = backend.store.state.attempts.find((item) => item.id === slot.attemptId)!;
  return { team, slot, attempt };
}

function cfSubmission(id: number, attempt: ReturnType<typeof currentAttempt>['attempt'], verdict: string, offsetMs = 1000) {
  const problem = attempt && { contestId: Number(attempt.problemId.match(/^\d+/)?.[0]), index: attempt.problemId.replace(/^\d+/, '') };
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

export async function runSelfSubmitE2e(): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'musical-chairs-self-submit-'));
  const polledHandles: string[] = [];
  let responseRows: Array<Record<string, unknown>> = [];
  const api: SelfSubmitApi = {
    async userStatus(handle, count) {
      assert.equal(count, 30);
      polledHandles.push(handle);
      return responseRows;
    },
  };
  let backend: Backend | null = null;
  try {
    backend = await createBackend({ dataDir, selfSubmitApi: api });
    backend.store.state.config.judgeMode = 'cf_self';
    backend.store.state.config.roundMinutes = 60;
    backend.store.state.config.selfSubmitPollSeconds = 0.05;
    backend.store.state.config.selfSubmitGraceSeconds = 30;
    backend.store.state.problems.push(...Array.from({ length: 12 }, (_, index) => makeProblem(3000 + index)));
    const team = backend.engine.createTeam('Self-submit team', 1);
    team.cfHandle = 'selfSubmitTestHandle';
    const noHandleTeam = backend.engine.createTeam('No handle team', 1);
    backend.engine.start();
    await waitFor(() => polledHandles.length > 0, 'first Codeforces API poll');
    assert.ok(polledHandles.every((handle) => handle === 'selfSubmitTestHandle'), 'teams without a handle must never be polled');

    let current = currentAttempt(backend, team.id);
    responseRows = [cfSubmission(1001, current.attempt, 'OK')];
    await waitFor(() => currentAttempt(backend!, team.id).attempt.id !== current.attempt.id, 'matching OK to solve and draw a replacement');
    let submission = backend.store.state.submissions.find((item) => item.cfSubmissionId === 1001)!;
    assert.equal(current.attempt.outcome, 'solved');
    assert.equal(submission.source, 'self');
    assert.equal(submission.judge, 'cf_self');
    assert.equal(submission.lang, 'cpp20');
    assert.equal(submission.code, '');
    assert.equal(submission.seatIndex, current.slot.seatIndex);

    current = currentAttempt(backend, team.id);
    const beforeIgnored = backend.store.state.submissions.length;
    const differentProblem = cfSubmission(1002, current.attempt, 'OK');
    differentProblem.problem = { contestId: 9999, index: 'B' };
    responseRows = [differentProblem];
    const pollsBeforeDifferent = polledHandles.length;
    await waitFor(() => polledHandles.length > pollsBeforeDifferent, 'ignoring a different problem');
    assert.equal(current.attempt.outcome, 'active');
    assert.equal(backend.store.state.submissions.length, beforeIgnored);
    assert.ok(!current.team.processedCfSubmissionIds.includes(1002));

    const tooOld = cfSubmission(1003, current.attempt, 'OK', -120_000);
    responseRows = [tooOld];
    const pollsBeforeOld = polledHandles.length;
    await waitFor(() => polledHandles.length > pollsBeforeOld, 'ignoring a submission older than the grace window');
    assert.equal(current.attempt.outcome, 'active');
    assert.equal(backend.store.state.submissions.length, beforeIgnored);
    assert.ok(!current.team.processedCfSubmissionIds.includes(1003));

    const wrong = cfSubmission(1004, current.attempt, 'WRONG_ANSWER');
    responseRows = [wrong];
    await waitFor(() => current.team.processedCfSubmissionIds.includes(1004), 'recording a wrong answer');
    assert.equal(current.attempt.wrongSubmissions, 1);
    const wrongSubmissionCount = backend.store.state.submissions.filter((item) => item.cfSubmissionId === 1004).length;
    const pollsAfterWrong = polledHandles.length;
    await waitFor(() => polledHandles.length >= pollsAfterWrong + 2, 're-polling the same wrong answer');
    assert.equal(current.attempt.wrongSubmissions, 1, 'a repeated wrong verdict increments the count once');
    assert.equal(backend.store.state.submissions.filter((item) => item.cfSubmissionId === 1004).length, wrongSubmissionCount);

    const pending = cfSubmission(1005, current.attempt, 'TESTING');
    responseRows = [pending];
    const pollsBeforePending = polledHandles.length;
    await waitFor(() => polledHandles.length > pollsBeforePending, 'polling a testing submission');
    assert.ok(!current.team.processedCfSubmissionIds.includes(1005), 'TESTING must remain unprocessed');
    assert.equal(current.attempt.outcome, 'active');
    responseRows = [cfSubmission(1005, current.attempt, 'OK')];
    await waitFor(() => currentAttempt(backend!, team.id).attempt.id !== current.attempt.id, 'later OK to solve the active attempt');
    assert.equal(backend.store.state.submissions.filter((item) => item.cfSubmissionId === 1005).length, 1);
    assert.equal(current.attempt.outcome, 'solved');

    await backend.store.save();
    const submissionCount = backend.store.state.submissions.length;
    const solveCount = backend.store.state.attempts.filter((item) => item.teamId === team.id && item.outcome === 'solved').length;
    const callsBeforeRestart = polledHandles.length;
    await backend.close();
    backend = await createBackend({ dataDir, selfSubmitApi: api });
    await waitFor(() => polledHandles.length > callsBeforeRestart, 'polling after store reload');
    assert.equal(backend.store.state.submissions.length, submissionCount, 'reloading the store must not double-record the same Codeforces submission');
    assert.equal(backend.store.state.attempts.filter((item) => item.teamId === team.id && item.outcome === 'solved').length, solveCount);
    assert.ok(backend.store.state.teams.find((item) => item.id === team.id)?.processedCfSubmissionIds.includes(1005));
    assert.ok(backend.store.state.teams.some((item: Team) => item.id === noHandleTeam.id && !item.cfHandle));
    assert.ok(polledHandles.every((handle) => handle === 'selfSubmitTestHandle'));
  } finally {
    if (backend) await backend.close();
    await rm(dataDir, { recursive: true, force: true });
  }
  console.log('SELF-SUBMIT E2E PASS: matching OK/replacement, mismatched and stale ignored, duplicate WRONG_ANSWER counted once, TESTING then OK, persisted ID deduplication, no-handle team skipped');
}
