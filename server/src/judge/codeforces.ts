import type { Submission } from '../../../shared/types.js';
import { userStatus } from '../cf/api.js';
import { AccountQueue } from '../cf/account-queue.js';
import { CodeforcesBridge } from '../cf/bridge.js';
import { Store } from '../store.js';
import type { JudgeResult } from './local.js';

export class CodeforcesJudge {
  private roundRobin = 0;

  constructor(
    private readonly store: Store,
    private readonly bridge: CodeforcesBridge,
    private readonly accountQueue: AccountQueue,
  ) {}

  async judge(submission: Submission, contestId: number, index: string, programTypeId: number): Promise<JudgeResult & { cfSubmissionId: number }> {
    const accounts = this.store.state.cfAccounts.filter((account) => account.enabled);
    if (!accounts.length) throw new Error('No enabled Codeforces account is configured');
    const account = accounts[this.roundRobin % accounts.length]!;
    this.roundRobin += 1;
    return this.accountQueue.run(account.handle, async () => {
      account.status = 'busy';
      account.lastError = null;
      submission.cfAccount = account.handle;
      this.store.changed();
      try {
        const problem = this.store.state.problems.find((item) => item.id === submission.problemId);
        if (!problem) throw new Error(`Problem ${submission.problemId} no longer exists`);
        if (problem.contestId !== contestId || problem.index !== index) {
          throw new Error('Submission problem metadata does not match the selected problem');
        }
        const language = this.store.state.languages.find((item) => item.id === submission.lang);
        if (!language) throw new Error(`Language ${submission.lang} no longer exists`);
        const cfSubmissionId = await this.bridge.submit(
          account.handle, problem, submission.code, programTypeId, language.srcFile, language.monaco,
        );
        this.store.changed();
        const deadline = Date.now() + 10 * 60_000;
        let latest: Record<string, unknown> | undefined;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const statuses = await userStatus(account.handle);
          latest = statuses.find((item) => Number(item.id) === cfSubmissionId);
          if (latest && !['TESTING', 'QUEUED', 'RUNNING', 'SUBMITTED'].includes(String(latest.verdict))) break;
        }
        if (!latest || ['TESTING', 'QUEUED', 'RUNNING', 'SUBMITTED'].includes(String(latest.verdict))) {
          throw new Error(`Codeforces submission ${cfSubmissionId} did not finish within 10 minutes`);
        }
        const verdict = String(latest.verdict ?? 'JUDGE_ERROR');
        const passed = Number(latest.passedTestCount ?? 0);
        const ok = verdict === 'OK';
        return {
          cfSubmissionId,
          verdict,
          passedTests: passed,
          failedTest: ok || !Number.isFinite(passed) ? null : passed + 1,
          timeMs: Number.isFinite(Number(latest.timeConsumedMillis)) ? Number(latest.timeConsumedMillis) : null,
          memoryKb: Number.isFinite(Number(latest.memoryConsumedBytes))
            ? Math.round(Number(latest.memoryConsumedBytes) / 1024) : null,
          message: null,
        };
      } catch (error) {
        account.lastError = (error as Error).message;
        account.status = 'error';
        throw error;
      } finally {
        if (account.status === 'busy') account.status = 'ready';
        this.store.changed();
      }
    });
  }
}
