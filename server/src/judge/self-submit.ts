import { userStatus } from '../cf/api.js';
import type { GameEngine } from '../engine.js';
import type { JudgingService } from '../judging.js';
import type { Store } from '../store.js';

export interface SelfSubmitApi {
  userStatus(handle: string, count: number): Promise<Array<Record<string, unknown>>>;
}

const defaultApi: SelfSubmitApi = { userStatus };
const PENDING_VERDICTS = new Set(['TESTING', 'QUEUED', 'RUNNING', 'SUBMITTED']);

export class SelfSubmitWatcher {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;
  private nextTeamIndex = 0;

  constructor(
    private readonly store: Store,
    private readonly engine: GameEngine,
    private readonly judging: JudgingService,
    private readonly api: SelfSubmitApi = defaultApi,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.pollNext().finally(() => {
        this.inFlight = null;
        this.schedule(this.nextDelay());
      });
    }, delayMs);
    this.timer.unref();
  }

  private nextDelay(): number {
    if (!this.isEnabled()) return 1000;
    const teams = this.store.state.teams;
    const pollMs = Math.max(1, this.store.state.config.selfSubmitPollSeconds * 1000);
    const now = Date.now();
    const nextPollAt = teams
      .filter((team) => this.hasActiveAttempts(team) && team.enabled && Boolean(team.cfHandle?.trim()))
      .reduce((next, team) => Math.min(next, (team.selfSubmitStatus.lastPollAt ?? 0) + pollMs), Infinity);
    return Number.isFinite(nextPollAt) ? Math.max(25, Math.min(1000, nextPollAt - now)) : 1000;
  }

  private async pollNext(): Promise<void> {
    if (this.stopped || !this.isEnabled()) return;
    const teams = this.store.state.teams;
    const now = Date.now();
    const pollMs = Math.max(1, this.store.state.config.selfSubmitPollSeconds * 1000);
    for (let offset = 0; offset < teams.length; offset += 1) {
      const index = (this.nextTeamIndex + offset) % teams.length;
      const team = teams[index]!;
      if (!this.isEligible(team) || now - (team.selfSubmitStatus.lastPollAt ?? 0) < pollMs) continue;
      this.nextTeamIndex = (index + 1) % teams.length;
      await this.pollTeam(team.id, team.cfHandle!.trim());
      return;
    }
  }

  private isEnabled(): boolean {
    const { phase, config } = this.store.state;
    return config.judgeMode === 'cf_self' && (phase === 'running' || phase === 'transition' || phase === 'paused');
  }

  private isEligible(team: (typeof this.store.state.teams)[number]): boolean {
    return team.enabled && Boolean(team.cfHandle?.trim()) && this.hasActiveAttempts(team);
  }

  private hasActiveAttempts(team: (typeof this.store.state.teams)[number]): boolean {
    return team.slots.some((slot) => this.engine.activeAttempt(slot) !== undefined);
  }

  private async pollTeam(teamId: string, handle: string): Promise<void> {
    const team = this.store.state.teams.find((item) => item.id === teamId);
    if (!team) return;
    team.selfSubmitStatus.lastPollAt = Date.now();
    team.selfSubmitStatus.lastError = null;
    this.store.changed();
    try {
      const submissions = await this.api.userStatus(handle, 30);
      const currentTeam = this.store.state.teams.find((item) => item.id === teamId);
      if (!currentTeam || currentTeam.cfHandle?.trim().toLowerCase() !== handle.toLowerCase() || !this.isEnabled()) return;
      const ordered = submissions
        .map((submission) => ({
          submission,
          id: Number(submission.id),
          createdAt: Number(submission.creationTimeSeconds) * 1000,
        }))
        .filter((entry) => Number.isSafeInteger(entry.id) && entry.id > 0)
        .sort((left, right) => left.createdAt - right.createdAt || left.id - right.id);
      const processed = new Set(currentTeam.processedCfSubmissionIds);
      let changed = false;
      for (const entry of ordered) {
        if (processed.has(entry.id)) continue;
        const verdict = String(entry.submission.verdict ?? '').toUpperCase();
        if (!verdict || PENDING_VERDICTS.has(verdict)) continue;
        const attempt = this.matchingAttempt(currentTeam, entry.submission, entry.createdAt);
        if (!attempt || !this.judging.recordSelfSubmittedVerdict(currentTeam, attempt, entry.submission)) continue;
        currentTeam.processedCfSubmissionIds.push(entry.id);
        processed.add(entry.id);
        changed = true;
      }
      if (changed) currentTeam.processedCfSubmissionIds = currentTeam.processedCfSubmissionIds.slice(-500);
      if (changed) this.store.changed();
    } catch (error) {
      const currentTeam = this.store.state.teams.find((item) => item.id === teamId);
      if (!currentTeam) return;
      currentTeam.selfSubmitStatus.lastError = (error as Error).message;
      this.store.log('warn', `Self-submit polling failed for ${currentTeam.name}: ${currentTeam.selfSubmitStatus.lastError}`);
      this.store.changed();
    }
  }

  private matchingAttempt(
    team: (typeof this.store.state.teams)[number],
    submission: Record<string, unknown>,
    createdAt: number,
  ) {
    const problem = submission.problem as { contestId?: unknown; index?: unknown } | undefined;
    const contestId = Number(problem?.contestId);
    const index = String(problem?.index ?? '').toUpperCase();
    if (!Number.isFinite(contestId) || !index || !Number.isFinite(createdAt)) return undefined;
    const minimumCreatedAt = this.store.state.config.selfSubmitGraceSeconds * 1000;
    for (const slot of team.slots) {
      const attempt = this.engine.activeAttempt(slot);
      if (!attempt || attempt.teamId !== team.id || createdAt < attempt.startedAt - minimumCreatedAt) continue;
      const currentProblem = this.store.state.problems.find((item) => item.id === attempt.problemId);
      if (currentProblem?.contestId === contestId && currentProblem.index.toUpperCase() === index) return attempt;
    }
    return undefined;
  }
}
