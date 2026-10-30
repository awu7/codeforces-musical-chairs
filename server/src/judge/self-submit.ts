import type { Attempt, Seat, Team } from '../../../shared/types.js';
import { userStatus } from '../cf/api.js';
import type { GameEngine } from '../engine.js';
import type { JudgingService } from '../judging.js';
import type { Store } from '../store.js';

export interface SelfSubmitApi {
  userStatus(handle: string, count: number): Promise<Array<Record<string, unknown>>>;
}

const defaultApi: SelfSubmitApi = { userStatus };
const PENDING_VERDICTS = new Set(['TESTING', 'QUEUED', 'RUNNING', 'SUBMITTED']);

interface PollCandidate {
  team: Team;
  seat: Seat;
  handle: string;
  hot: boolean;
  refreshPending: boolean;
  lastPollAt: number | null;
  intervalMs: number;
}

export class SelfSubmitWatcher {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;

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
    const now = Date.now();
    const candidates = this.candidates(now);
    if (candidates.length === 0) return 1000;
    const nextDueAt = Math.min(...candidates.map((candidate) =>
      candidate.refreshPending ? now : (candidate.lastPollAt ?? 0) + candidate.intervalMs,
    ));
    return Math.max(25, Math.min(1000, nextDueAt - now));
  }

  private async pollNext(): Promise<void> {
    if (this.stopped || !this.isEnabled()) return;
    const now = Date.now();
    const due = this.candidates(now)
      .filter((candidate) => candidate.refreshPending || candidate.lastPollAt === null || now - candidate.lastPollAt >= candidate.intervalMs)
      .sort((left, right) =>
        Number(right.refreshPending) - Number(left.refreshPending)
        || Number(right.hot) - Number(left.hot)
        || (left.lastPollAt ?? 0) - (right.lastPollAt ?? 0),
      );
    const candidate = due[0];
    if (candidate) await this.pollTeamHandle(candidate.team.id, candidate.handle);
  }

  private isEnabled(): boolean {
    const { phase, config } = this.store.state;
    return config.judgeMode === 'cf_self' && (phase === 'running' || phase === 'transition' || phase === 'paused');
  }

  private candidates(now: number): PollCandidate[] {
    const config = this.store.state.config;
    const hotWindowMs = Math.max(0, config.selfSubmitHotMinutes * 60_000);
    const hotIntervalMs = Math.max(1, config.selfSubmitPollSeconds * 1000);
    const coldIntervalMs = Math.max(1, config.selfSubmitColdPollSeconds * 1000);
    return this.store.state.teams.flatMap((team) => {
      if (!team.enabled || !team.slots.some((slot) => this.engine.activeAttempt(slot))) return [];
      return team.seats.flatMap((seat) => {
        const handle = seat.cfHandle?.trim();
        if (!handle) return [];
        const clickedAt = seat.submitClickedAt;
        const hot = clickedAt !== null && clickedAt <= now && now - clickedAt <= hotWindowMs;
        const refreshPending = seat.refreshRequestedAt !== null
          && (seat.selfSubmitStatus.lastPollAt === null || seat.refreshRequestedAt > seat.selfSubmitStatus.lastPollAt);
        return [{
          team,
          seat,
          handle,
          hot,
          refreshPending,
          lastPollAt: seat.selfSubmitStatus.lastPollAt,
          intervalMs: hot ? hotIntervalMs : coldIntervalMs,
        }];
      });
    });
  }

  private async pollTeamHandle(teamId: string, handle: string): Promise<void> {
    const team = this.store.state.teams.find((item) => item.id === teamId);
    if (!team) return;
    const matchingSeats = () => team.seats.filter((seat) => seat.cfHandle?.trim().toLowerCase() === handle.toLowerCase());
    const seats = matchingSeats();
    if (seats.length === 0) return;
    const polledAt = Date.now();
    for (const seat of seats) {
      seat.selfSubmitStatus.lastPollAt = polledAt;
      seat.selfSubmitStatus.lastError = null;
    }
    this.store.changed();
    try {
      const submissions = await this.api.userStatus(handle, 30);
      const currentTeam = this.store.state.teams.find((item) => item.id === teamId);
      if (!currentTeam || !currentTeam.enabled || !this.isEnabled()) return;
      if (!currentTeam.seats.some((seat) => seat.cfHandle?.trim().toLowerCase() === handle.toLowerCase())) return;
      this.ingest(teamId, submissions);
    } catch (error) {
      const currentTeam = this.store.state.teams.find((item) => item.id === teamId);
      if (!currentTeam) return;
      const message = (error as Error).message;
      for (const seat of currentTeam.seats) {
        if (seat.cfHandle?.trim().toLowerCase() === handle.toLowerCase()) seat.selfSubmitStatus.lastError = message;
      }
      this.store.log('warn', `Self-submit polling failed for ${currentTeam.name} (${handle}): ${message}`);
      this.store.changed();
    }
  }

  ingest(teamId: string, submissions: Array<Record<string, unknown>>): number {
    const team = this.store.state.teams.find((item) => item.id === teamId);
    if (!team || !team.enabled || !this.isEnabled()) return 0;
    const ordered = submissions
      .map((submission) => ({
        submission,
        id: Number(submission.id),
        createdAt: Number(submission.creationTimeSeconds) * 1000,
      }))
      .filter((entry) => Number.isSafeInteger(entry.id) && entry.id > 0)
      .sort((left, right) => left.createdAt - right.createdAt || left.id - right.id);
    const processed = new Set(team.processedCfSubmissionIds);
    let applied = 0;
    for (const entry of ordered) {
      if (processed.has(entry.id)) continue;
      const verdict = String(entry.submission.verdict ?? '').toUpperCase();
      if (!verdict || PENDING_VERDICTS.has(verdict)) continue;
      const attempt = this.matchingAttempt(team, entry.submission, entry.createdAt);
      if (!attempt || !this.judging.recordSelfSubmittedVerdict(team, attempt, entry.submission)) continue;
      team.processedCfSubmissionIds.push(entry.id);
      processed.add(entry.id);
      applied += 1;
    }
    if (applied > 0) {
      team.processedCfSubmissionIds = team.processedCfSubmissionIds.slice(-500);
      this.store.changed();
    }
    return applied;
  }

  private matchingAttempt(team: Team, submission: Record<string, unknown>, createdAt: number): Attempt | undefined {
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
