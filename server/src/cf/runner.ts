import type { Language, RunResult } from '../../../shared/types.js';
import { AccountQueue } from './account-queue.js';
import { CodeforcesBridge } from './bridge.js';
import { Store } from '../store.js';

export interface Runner {
  run(language: Language, code: string, input: string): Promise<RunResult>;
}

const NO_ACCOUNT = 'No enabled Codeforces account is configured (needed for running code)';

function errorResult(stderr: string): RunResult {
  return { status: 'error', stdout: '', stderr, compileOutput: '', timeMs: 0, exitCode: null, truncated: false };
}

export class CustomInvocationRunner implements Runner {
  private roundRobin = 0;

  constructor(
    private readonly store: Store,
    private readonly bridge: CodeforcesBridge,
    private readonly accountQueue: AccountQueue,
  ) {}

  async run(language: Language, code: string, input: string): Promise<RunResult> {
    const accounts = this.store.state.cfAccounts.filter((account) => account.enabled);
    if (!accounts.length) return errorResult(NO_ACCOUNT);
    const start = this.roundRobin % accounts.length;
    this.roundRobin = (start + 1) % accounts.length;
    for (let offset = 0; offset < accounts.length; offset += 1) {
      const account = accounts[(start + offset) % accounts.length]!;
      try {
        return await this.accountQueue.run(account.handle, async () => {
          account.status = 'busy';
          account.lastError = null;
          this.store.changed();
          try {
            const result = await this.bridge.customTest(account.handle, code, language.cfProgramTypeId, input);
            account.lastUsedAt = Date.now();
            if (result.status === 'error') {
              account.status = 'error';
              account.lastError = result.stderr;
            } else {
              account.status = 'ready';
            }
            return result;
          } catch (error) {
            account.status = 'error';
            account.lastError = (error as Error).message;
            throw error;
          } finally {
            if (account.status === 'busy') account.status = 'ready';
            this.store.changed();
          }
        });
      } catch (error) {
        const message = (error as Error).message;
        if (/not logged in/i.test(message)) continue;
        return errorResult(message);
      }
    }
    return errorResult(NO_ACCOUNT);
  }
}
