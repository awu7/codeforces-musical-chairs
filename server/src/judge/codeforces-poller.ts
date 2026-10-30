import { userStatus } from '../cf/api.js';

type SubmissionStatus = Record<string, unknown>;
type PendingSubmission = {
  resolve: (status: SubmissionStatus) => void;
  reject: (error: Error) => void;
  deadline: number;
};

const PENDING_VERDICTS = new Set(['TESTING', 'QUEUED', 'RUNNING', 'SUBMITTED']);

export class CodeforcesSubmissionPoller {
  private readonly pending = new Map<string, Map<number, PendingSubmission>>();
  private readonly polling = new Set<string>();

  waitFor(handle: string, submissionId: number, timeoutMs = 10 * 60_000): Promise<SubmissionStatus> {
    const key = handle.toLowerCase();
    let submissions = this.pending.get(key);
    if (!submissions) {
      submissions = new Map();
      this.pending.set(key, submissions);
    }
    return new Promise((resolve, reject) => {
      submissions!.set(submissionId, { resolve, reject, deadline: Date.now() + timeoutMs });
      this.start(key, handle);
    });
  }

  private start(key: string, handle: string): void {
    if (this.polling.has(key)) return;
    this.polling.add(key);
    void this.pollHandle(key, handle);
  }

  private async pollHandle(key: string, handle: string): Promise<void> {
    try {
      while (this.pending.get(key)?.size) {
        const now = Date.now();
        this.expire(key, now);
        if (!this.pending.get(key)?.size) break;
        const statuses = await userStatus(handle, 50);
        const byId = new Map(statuses.map((status) => [Number(status.id), status]));
        const entries = this.pending.get(key);
        if (!entries) break;
        for (const [id, pending] of entries) {
          const status = byId.get(id);
          if (status && !PENDING_VERDICTS.has(String(status.verdict))) {
            entries.delete(id);
            pending.resolve(status);
          }
        }
        this.expire(key, Date.now());
      }
    } catch (caught) {
      const entries = this.pending.get(key);
      for (const pending of entries?.values() ?? []) pending.reject(caught as Error);
      entries?.clear();
    } finally {
      this.polling.delete(key);
      const entries = this.pending.get(key);
      if (entries?.size) this.start(key, handle);
      else this.pending.delete(key);
    }
  }

  private expire(key: string, now: number): void {
    const entries = this.pending.get(key);
    if (!entries) return;
    for (const [id, pending] of entries) {
      if (now < pending.deadline) continue;
      entries.delete(id);
      pending.reject(new Error(`Codeforces submission ${id} did not finish within 10 minutes`));
    }
  }
}
