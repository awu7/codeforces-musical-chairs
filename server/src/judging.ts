import type { Submission } from '../../shared/types.js';
import { AccountQueue } from './cf/account-queue.js';
import type { Runner } from './cf/runner.js';
import { CodeforcesBridge } from './cf/bridge.js';
import { userStatus } from './cf/api.js';
import { GameEngine } from './engine.js';
import { CodeforcesJudge } from './judge/codeforces.js';
import { LocalJudge } from './judge/local.js';
import { autoAccept, waitingForManualVerdict } from './judge/manual.js';
import { Store } from './store.js';

export class JudgingService {
  private readonly local: LocalJudge;
  private readonly codeforces: CodeforcesJudge;

  constructor(
    private readonly store: Store,
    private readonly engine: GameEngine,
    runner: Runner,
    bridge: CodeforcesBridge,
    accountQueue: AccountQueue,
  ) {
    this.local = new LocalJudge(runner);
    this.codeforces = new CodeforcesJudge(store, bridge, accountQueue);
  }

  async judge(submission: Submission): Promise<void> {
    const current = this.store.state.submissions.find((item) => item.id === submission.id);
    if (!current || current.overridden) return;
    current.status = 'judging';
    current.message = null;
    this.store.changed();
    try {
      const language = this.store.state.languages.find((item) => item.id === current.lang);
      const problem = this.store.state.problems.find((item) => item.id === current.problemId);
      if (!language || !problem) throw new Error('Submission language or problem no longer exists');
      let result;
      let cfSubmissionId: number | null = null;
      if (current.judge === 'manual') {
        result = waitingForManualVerdict(current);
      } else if (current.judge === 'auto-accept') {
        result = await autoAccept();
      } else if (current.judge === 'local') {
        result = await this.local.judge(current, language, problem);
      } else {
        result = await this.codeforces.judge(current, problem.contestId, problem.index, language.cfProgramTypeId);
        cfSubmissionId = result.cfSubmissionId;
      }
      const fresh = this.store.state.submissions.find((item) => item.id === current.id);
      if (!fresh || fresh.overridden) return;
      fresh.status = current.judge === 'manual' ? 'judging' : 'done';
      fresh.verdict = result.verdict;
      fresh.passedTests = result.passedTests;
      fresh.failedTest = result.failedTest;
      fresh.timeMs = result.timeMs;
      fresh.memoryKb = result.memoryKb;
      fresh.cfSubmissionId = cfSubmissionId;
      fresh.message = result.message;
      this.store.log('info', `Submission ${fresh.id}: ${result.verdict}`);
      if (fresh.status === 'done') this.applyVerdict(fresh);
      this.store.changed();
    } catch (error) {
      const fresh = this.store.state.submissions.find((item) => item.id === current.id);
      if (!fresh || fresh.overridden) return;
      fresh.status = 'error';
      fresh.verdict = 'JUDGE_ERROR';
      fresh.message = (error as Error).message;
      this.store.log('error', `Judge error for submission ${fresh.id}: ${fresh.message}`);
      this.store.changed();
    }
  }

  async rejudge(submission: Submission): Promise<void> {
    submission.status = 'queued';
    submission.verdict = null;
    submission.passedTests = null;
    submission.failedTest = null;
    submission.timeMs = null;
    submission.memoryKb = null;
    submission.cfSubmissionId = null;
    submission.message = null;
    submission.overridden = false;
    this.store.changed();
    void this.judge(submission);
  }

  override(submission: Submission, verdict: string): void {
    submission.overridden = true;
    submission.status = 'done';
    submission.verdict = verdict.toUpperCase();
    submission.message = 'Verdict overridden by administrator';
    submission.failedTest = null;
    if (submission.verdict === 'OK') {
      const slot = this.engine.findSlot(submission.slotId)?.slot;
      const attempt = this.store.state.attempts.find((item) => item.id === submission.attemptId && item.outcome === 'active');
      if (slot && attempt?.outcome === 'active' && slot.attemptId === attempt.id) this.engine.solve(slot, submission.seatIndex);
    } else {
      const attempt = this.store.state.attempts.find((item) => item.id === submission.attemptId && item.outcome === 'active');
      if (attempt) attempt.wrongSubmissions += 1;
    }
    this.store.log('info', `Admin set verdict ${submission.verdict} for ${submission.id}`);
    this.store.changed();
  }

  private applyVerdict(submission: Submission): void {
    const attempt = this.store.state.attempts.find((item) => item.id === submission.attemptId && item.outcome === 'active');
    if (!attempt) return;
    const slot = this.engine.findSlot(submission.slotId)?.slot;
    if (!slot || slot.attemptId !== attempt.id) return;
    if (submission.verdict === 'OK') this.engine.solve(slot, submission.seatIndex);
    else attempt.wrongSubmissions += 1;
  }
}

export async function excludeSolvedProblems(handles: string[]): Promise<Set<string>> {
  const used = new Set<string>();
  for (const handle of handles) {
    const submissions = await userStatus(handle, 1000);
    for (const item of submissions) {
      const verdict = item.verdict;
      const problem = item.problem as { contestId?: number; index?: string } | undefined;
      if (verdict === 'OK' && problem?.contestId && problem.index) used.add(`${problem.contestId}${problem.index}`);
    }
  }
  return used;
}
