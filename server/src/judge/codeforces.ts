import type { Submission } from '../../../shared/types.js';
import { AccountQueue } from '../cf/account-queue.js';
import { CodeforcesBridge } from '../cf/bridge.js';
import type { Store } from '../store.js';
import { CodeforcesSubmissionPoller } from './codeforces-poller.js';
import type { JudgeResult } from './local.js';

export class CodeforcesJudge {
  private roundRobin = 0;
  private readonly poller = new CodeforcesSubmissionPoller();

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
    let cfSubmissionId: number;
    try {
      cfSubmissionId = await this.accountQueue.run(account.handle, async () => {
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
          const id = await this.bridge.submit(
            account.handle, problem, submission.code, programTypeId, language.srcFile, language.monaco,
          );
          account.lastUsedAt = Date.now();
          this.store.changed();
          return id;
        } catch (error) {
          account.lastError = (error as Error).message;
          account.status = 'error';
          throw error;
        } finally {
          if (account.status === 'busy') account.status = 'ready';
          this.store.changed();
        }
      });
      const latest = await this.poller.waitFor(account.handle, cfSubmissionId);
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
      this.store.changed();
      throw error;
    }
  }
}
