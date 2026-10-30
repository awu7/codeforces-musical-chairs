import { randomBytes } from 'node:crypto';
import type {
  Attempt,
  GameClock,
  GameConfig,
  Problem,
  ProblemPublic,
  ScoreRow,
  Seat,
  SeatView,
  Slot,
  Submission,
  SubmissionPublic,
  Team,
} from '../../shared/types.js';
import { DEFAULT_LANGUAGES } from './defaults.js';
import { Store } from './store.js';

const JOIN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

function joinCode(): string {
  const bytes = randomBytes(6);
  return [...bytes].map((byte) => JOIN_CHARS[byte % JOIN_CHARS.length]).join('');
}

export class GameEngine {
  private deadlineTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastAccountedAt = Date.now();
  private onChange: (() => void) | null = null;
  private readonly lateFlushSeats = new Map<string, { seatIndex: number; until: number }>();

  constructor(readonly store: Store) {}

  setOnChange(listener: () => void): void {
    this.onChange = listener;
  }

  startScheduler(): void {
    this.lastAccountedAt = Date.now();
    this.scheduleDeadline();
    this.tickTimer = setInterval(() => {
      if (this.store.state.phase !== 'running') return;
      this.accrueActiveTime();
      this.store.changed();
    }, 1000);
    this.tickTimer.unref();
  }

  stopScheduler(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  clock(now = Date.now()): GameClock {
    const state = this.store.state;
    return {
      phase: state.phase,
      round: state.round,
      totalRounds: state.config.totalRounds,
      roundEndsAt: state.phase === 'running' ? state.roundEndsAt : null,
      transitionEndsAt: state.phase === 'transition' ? state.transitionEndsAt : null,
      pausedRemainingMs: state.phase === 'paused' ? state.pausedRemainingMs : null,
      lazyMode: state.config.lazyMode,
      serverNow: now,
    };
  }

  createTeam(name: string, size: number): Team {
    const state = this.store.state;
    if (state.phase !== 'setup') throw new Error('Teams can only be created during setup');
    if (!name.trim()) throw new Error('Team name is required');
    if (!Number.isInteger(size) || size < 1 || size > 20) throw new Error('Team size must be between 1 and 20');
    const teamId = newId('team');
    const initialRating = state.config.difficulty.startRating;
    const seats: Seat[] = Array.from({ length: size }, (_, index) => ({
      index,
      label: `PC ${index + 1}`,
      code: joinCode(),
      connected: 0,
      lastSeen: null,
    }));
    const slots: Slot[] = Array.from({ length: size }, (_, seatIndex) => {
      const slotId = newId('slot');
      const lang = state.languages.find((item) => item.enabled)?.id ?? 'cpp20';
      const language = state.languages.find((item) => item.id === lang);
      return {
        id: slotId,
        teamId,
        seatIndex,
        attemptId: null,
        nextRating: initialRating,
        lang,
        code: language ? { [lang]: language.template } : {},
        input: '',
        updatedAt: Date.now(),
      };
    });
    const team: Team = { id: teamId, name: name.trim(), size, rating: initialRating, startRating: null, seats, slots, enabled: true };
    state.teams.push(team);
    this.store.log('info', `Created team ${team.name}`);
    this.changed();
    return team;
  }

  resizeTeam(team: Team, size: number): void {
    if (this.store.state.phase !== 'setup') throw new Error('Team size can only change during setup');
    if (!Number.isInteger(size) || size < 1 || size > 20) throw new Error('Team size must be between 1 and 20');
    const existingSlots = team.slots;
    if (size < team.size) {
      team.slots = existingSlots.slice(0, size);
    } else {
      for (let index = team.size; index < size; index += 1) {
        const id = newId('slot');
        const lang = this.store.state.languages.find((item) => item.enabled)?.id ?? 'cpp20';
        const language = this.store.state.languages.find((item) => item.id === lang);
        team.slots.push({
          id, teamId: team.id, seatIndex: index, attemptId: null,
          nextRating: team.startRating ?? this.store.state.config.difficulty.startRating,
          lang, code: language ? { [lang]: language.template } : {}, input: '', updatedAt: Date.now(),
        });
      }
    }
    team.seats = Array.from({ length: size }, (_, index) =>
      team.seats[index] ?? { index, label: `PC ${index + 1}`, code: joinCode(), connected: 0, lastSeen: null },
    );
    team.size = size;
    this.changed();
  }

  regenerateCodes(team: Team): void {
    for (const seat of team.seats) seat.code = joinCode();
    this.changed();
  }

  start(): void {
    if (this.store.state.phase !== 'setup') throw new Error('Game can only start from setup');
    this.store.state.round = 1;
    this.store.state.phase = 'running';
    this.store.state.roundEndsAt = Date.now() + this.store.state.config.roundMinutes * 60_000;
    this.store.state.transitionEndsAt = null;
    this.store.state.pausedRemainingMs = null;
    this.lastAccountedAt = Date.now();
    for (const team of this.store.state.teams.filter((item) => item.enabled)) {
      team.rating = team.startRating ?? this.store.state.config.difficulty.startRating;
      for (const slot of team.slots) {
        slot.nextRating = team.startRating ?? this.store.state.config.difficulty.startRating;
        this.drawForSlot(team, slot, 1);
      }
    }
    this.store.log('info', 'Game started');
    this.changed();
  }

  pause(): void {
    const state = this.store.state;
    if (state.phase !== 'running') throw new Error('Game is not running');
    this.accrueActiveTime();
    state.pausedRemainingMs = Math.max(0, (state.roundEndsAt ?? Date.now()) - Date.now());
    state.roundEndsAt = null;
    state.phase = 'paused';
    this.store.log('info', 'Game paused');
    this.changed();
  }

  resume(): void {
    const state = this.store.state;
    if (state.phase !== 'paused') throw new Error('Game is not paused');
    state.phase = 'running';
    state.roundEndsAt = Date.now() + (state.pausedRemainingMs ?? 0);
    state.pausedRemainingMs = null;
    this.lastAccountedAt = Date.now();
    this.store.log('info', 'Game resumed');
    this.changed();
  }

  nextRound(): void {
    if (this.store.state.phase !== 'running') throw new Error('Game is not running');
    this.beginTransition();
  }

  startRound(): void {
    if (this.store.state.phase !== 'transition' || this.store.state.transitionEndsAt !== null) {
      throw new Error('Game is not waiting for an admin to start a round');
    }
    this.startNextRound();
  }

  skipTransition(): void {
    if (this.store.state.phase !== 'transition') throw new Error('Game is not in transition');
    this.finishTransition();
  }

  end(): void {
    this.accrueActiveTime();
    this.store.state.phase = 'finished';
    this.store.state.roundEndsAt = null;
    this.store.state.transitionEndsAt = null;
    this.store.state.pausedRemainingMs = null;
    this.store.log('info', 'Game ended');
    this.changed();
  }

  reset(keepTeams: boolean, keepPool: boolean): void {
    const state = this.store.state;
    state.phase = 'setup';
    state.round = 0;
    state.roundEndsAt = null;
    state.transitionEndsAt = null;
    state.pausedRemainingMs = null;
    state.attempts = [];
    state.submissions = [];
    state.lastSubmissionAt = {};
    state.announcement = null;
    state.lock = { locked: false, message: '' };
    if (!keepTeams) state.teams = [];
    else {
      for (const team of state.teams) {
        for (const slot of team.slots) {
          slot.attemptId = null;
          slot.code = {};
          slot.input = '';
        }
      }
    }
    if (!keepPool) state.problems = [];
    this.store.log('info', 'Game reset');
    this.changed();
  }

  addTime(seconds: number): void {
    const state = this.store.state;
    if (state.phase === 'running' && state.roundEndsAt !== null) state.roundEndsAt += seconds * 1000;
    else if (state.phase === 'paused') state.pausedRemainingMs = Math.max(0, (state.pausedRemainingMs ?? 0) + seconds * 1000);
    else throw new Error('Time can only be adjusted while running or paused');
    this.changed();
  }

  setRemaining(seconds: number): void {
    const state = this.store.state;
    if (state.phase === 'running') state.roundEndsAt = Date.now() + seconds * 1000;
    else if (state.phase === 'paused') state.pausedRemainingMs = seconds * 1000;
    else throw new Error('Remaining time can only be set while running or paused');
    this.changed();
  }

  private beginTransition(): void {
    const state = this.store.state;
    this.accrueActiveTime();
    const maxRounds = state.config.totalRounds;
    if (maxRounds !== null && state.round >= maxRounds) {
      this.end();
      return;
    }
    this.rotate();
    state.phase = 'transition';
    state.roundEndsAt = null;
    const seconds = state.config.lazyMode ? state.config.lazyTransitionSeconds : state.config.transitionSeconds;
    state.transitionEndsAt = Date.now() + Math.max(0, seconds * 1000);
    state.pausedRemainingMs = null;
    this.store.log('info', `Round ${state.round} ended`);
    this.changed();
    if (seconds <= 0) this.finishTransition();
  }

  private rotate(): void {
    const state = this.store.state;
    for (const team of state.teams.filter((item) => item.enabled)) {
      for (const slot of team.slots) {
        this.lateFlushSeats.set(slot.id, { seatIndex: slot.seatIndex, until: Date.now() + 3000 });
        const attempt = this.activeAttempt(slot);
        if (attempt) {
          const maxRounds = Math.min(state.config.maxRoundsPerProblem ?? team.size, team.size);
          if (attempt.roundsShown >= maxRounds) {
            this.finishAttempt(attempt, 'expired');
            this.drawForSlot(team, slot, state.round + 1);
          } else {
            attempt.roundsShown += 1;
          }
        } else {
          this.drawForSlot(team, slot, state.round + 1);
        }
      }
      if (state.config.lazyMode) {
        for (const slot of team.slots) {
          slot.seatIndex = (slot.seatIndex - state.config.rotationDirection + team.size) % team.size;
        }
      }
    }
  }

  private finishTransition(): void {
    const state = this.store.state;
    if (state.phase !== 'transition') return;
    state.transitionEndsAt = null;
    if (!state.config.autoAdvance) {
      this.changed();
      return;
    }
    this.startNextRound();
  }

  private startNextRound(): void {
    const state = this.store.state;
    const next = state.round + 1;
    if (state.config.totalRounds !== null && next > state.config.totalRounds) {
      this.end();
      return;
    }
    state.round = next;
    state.phase = 'running';
    state.transitionEndsAt = null;
    state.roundEndsAt = Date.now() + state.config.roundMinutes * 60_000;
    this.lastAccountedAt = Date.now();
    for (const team of state.teams.filter((item) => item.enabled)) {
      for (const slot of team.slots) if (!slot.attemptId) this.drawForSlot(team, slot, next);
    }
    this.store.log('info', `Round ${next} started`);
    this.changed();
  }

  private drawForSlot(team: Team, slot: Slot, startRound: number): void {
    const state = this.store.state;
    const difficulty = state.config.difficulty;
    const baseRating = difficulty.scope === 'team' ? team.rating : slot.nextRating;
    const target = this.roundRating(baseRating);
    const eligible = (rating: number): Problem[] => state.problems.filter((problem) => {
      if (!problem.enabled || problem.rating !== rating) return false;
      if (problem.source !== 'manual' && problem.fetchStatus !== 'ok') return false;
      if (state.config.uniqueness === 'team') {
        return !state.attempts.some((attempt) => attempt.teamId === team.id && attempt.problemId === problem.id);
      }
      return !state.attempts.some((attempt) => attempt.problemId === problem.id);
    });
    let candidates = eligible(target);
    if (candidates.length === 0) {
      for (let distance = difficulty.step; distance <= difficulty.maxRating - difficulty.minRating; distance += difficulty.step) {
        const ratings = difficulty.fallback === 'lower' ? [target - distance] :
          difficulty.fallback === 'higher' ? [target + distance] : [target - distance, target + distance];
        for (const rating of ratings) {
          if (rating < difficulty.minRating || rating > difficulty.maxRating) continue;
          candidates = eligible(rating);
          if (candidates.length) break;
        }
        if (candidates.length) break;
      }
    }
    const problem = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : undefined;
    if (!problem) {
      slot.attemptId = null;
      this.store.log('warn', `No unused problem available for ${team.name} at rating ${target}`);
      return;
    }
    this.createAttempt(team, slot, problem, startRound);
  }

  private createAttempt(team: Team, slot: Slot, problem: Problem, startRound: number): void {
    const state = this.store.state;
    const lang = state.languages.find((item) => item.id === slot.lang);
    const attempt: Attempt = {
      id: newId('attempt'),
      teamId: team.id,
      slotId: slot.id,
      problemId: problem.id,
      rating: problem.rating,
      startedAt: Date.now(),
      startRound,
      endedAt: null,
      endRound: null,
      roundsShown: 1,
      activeMs: 0,
      outcome: 'active',
      wrongSubmissions: 0,
      solvedBySeat: null,
    };
    state.attempts.push(attempt);
    slot.attemptId = attempt.id;
    slot.code = lang ? { [slot.lang]: lang.template } : {};
    slot.input = '';
    slot.updatedAt = Date.now();
    this.store.log('info', `Drew ${problem.id} (${problem.rating}) for ${team.name}`);
  }

  private roundRating(value: number): number {
    const { minRating, maxRating, step } = this.store.state.config.difficulty;
    return Math.max(minRating, Math.min(maxRating, Math.round(value / step) * step));
  }

  activeAttempt(slot: Slot): Attempt | undefined {
    return this.store.state.attempts.find((attempt) => attempt.id === slot.attemptId && attempt.outcome === 'active');
  }

  solve(slot: Slot, seatIndex: number | null): Attempt | null {
    const attempt = this.activeAttempt(slot);
    if (!attempt) return null;
    attempt.solvedBySeat = seatIndex;
    this.finishAttempt(attempt, 'solved');
    const team = this.store.state.teams.find((item) => item.id === slot.teamId);
    if (team) this.drawForSlot(team, slot, this.store.state.round);
    this.store.log('info', `Solved ${attempt.problemId}`);
    this.changed();
    return attempt;
  }

  finishAttempt(attempt: Attempt, outcome: 'solved' | 'expired' | 'skipped'): void {
    if (attempt.outcome !== 'active') return;
    this.accrueActiveTime();
    attempt.outcome = outcome;
    attempt.endedAt = Date.now();
    attempt.endRound = this.store.state.round;
    if (outcome !== 'solved') this.store.log('info', `Problem ${attempt.problemId} ${outcome}`);
    const team = this.store.state.teams.find((item) => item.id === attempt.teamId);
    const slot = team?.slots.find((item) => item.id === attempt.slotId);
    if (!team || !slot) return;
    const difficulty = this.store.state.config.difficulty;
    let delta: number;
    if (outcome === 'solved') {
      const minutes = attempt.activeMs / 60_000;
      delta = difficulty.solvedRules.find((rule) => minutes <= rule.maxMinutes)?.delta ?? difficulty.slowSolveDelta;
    } else if (outcome === 'expired') delta = difficulty.unsolvedDelta;
    else delta = difficulty.skippedDelta;
    const next = this.roundRating((difficulty.scope === 'team' ? team.rating : attempt.rating) + delta);
    if (difficulty.scope === 'team') team.rating = next;
    else slot.nextRating = next;
  }

  private accrueActiveTime(): void {
    const now = Date.now();
    if (this.store.state.phase === 'running') {
      const elapsed = Math.max(0, now - this.lastAccountedAt);
      if (elapsed) {
        for (const attempt of this.store.state.attempts) if (attempt.outcome === 'active') attempt.activeMs += elapsed;
      }
    }
    this.lastAccountedAt = now;
  }

  findSlot(id: string): { team: Team; slot: Slot } | undefined {
    for (const team of this.store.state.teams) {
      const slot = team.slots.find((item) => item.id === id);
      if (slot) return { team, slot };
    }
    return undefined;
  }

  findSeat(code: string): { team: Team; seat: Seat } | undefined {
    for (const team of this.store.state.teams) {
      const seat = team.seats.find((item) => item.code === code.toUpperCase());
      if (seat) return { team, seat };
    }
    return undefined;
  }

  acceptsLateFlush(slotId: string, seatIndex: number): boolean {
    const previous = this.lateFlushSeats.get(slotId);
    if (!previous || previous.until < Date.now() || previous.seatIndex !== seatIndex) return false;
    return this.store.state.phase === 'transition' || (this.store.state.config.lazyMode && this.store.state.phase === 'running');
  }

  drawReplacement(team: Team, slot: Slot, problemId?: string, rating?: number): void {
    if (rating !== undefined) slot.nextRating = this.roundRating(rating);
    if (problemId) {
      const problem = this.store.state.problems.find((item) => item.id === problemId);
      if (!problem) throw new Error(`Problem ${problemId} does not exist`);
      this.createAttempt(team, slot, problem, Math.max(1, this.store.state.round));
    } else {
      this.drawForSlot(team, slot, Math.max(1, this.store.state.round));
    }
  }

  retryEmptySlots(): void {
    if (this.store.state.phase === 'setup' || this.store.state.phase === 'finished') return;
    for (const team of this.store.state.teams.filter((item) => item.enabled)) {
      for (const slot of team.slots) if (!slot.attemptId) this.drawForSlot(team, slot, Math.max(1, this.store.state.round));
    }
    this.changed();
  }

  problemPublic(problem: Problem, client: boolean): ProblemPublic {
    const config = this.store.state.config;
    return {
      id: problem.id,
      name: problem.name,
      url: problem.contestId <= 0 ? '' : problem.contestId >= 100000
        ? `https://codeforces.com/gym/${problem.contestId}/problem/${problem.index}`
        : `https://codeforces.com/problemset/problem/${problem.contestId}/${problem.index}`,
      rating: !client || config.showRatingToClients ? problem.rating : null,
      tags: !client || config.showTagsToClients ? problem.tags : null,
      statementHtml: problem.statementHtml,
      timeLimit: problem.timeLimit,
      memoryLimit: problem.memoryLimit,
      samples: client && !config.allowSampleLoad ? [] : problem.samples,
    };
  }

  scoreboard(): ScoreRow[] {
    const state = this.store.state;
    const teams = state.teams.map((team) => {
      const solved = state.attempts.filter((attempt) => attempt.teamId === team.id && attempt.outcome === 'solved');
      const ratingSum = solved.reduce((sum, attempt) => sum + attempt.rating, 0);
      const points = (state.config.scoring === 'count' ? solved.length : ratingSum) -
        solved.reduce((sum, attempt) => sum + attempt.wrongSubmissions * state.config.wrongSubmissionPenalty, 0);
      const lastSolve = Math.max(0, ...solved.map((attempt) => attempt.endedAt ?? 0));
      const slotsRating = team.slots.length
        ? team.slots.reduce((sum, slot) => sum + slot.nextRating, 0) / team.slots.length
        : team.rating;
      return {
        teamId: team.id, teamName: team.name, solved: solved.length, points, ratingSum,
        currentRating: state.config.difficulty.scope === 'team' ? team.rating : slotsRating,
        solves: solved.map((attempt) => ({
          problemId: attempt.problemId,
          rating: attempt.rating,
          minutes: attempt.activeMs / 60_000,
          round: attempt.endRound ?? attempt.startRound,
        })),
        lastSolve,
      };
    });
    return teams.sort((a, b) => b.points - a.points || a.lastSolve - b.lastSolve)
      .map(({ lastSolve: _lastSolve, ...row }) => row);
  }

  lockForSeat(): import('../../shared/types.js').LockInfo | null {
    const state = this.store.state;
    if (state.lock.locked) return { reason: 'admin', message: state.lock.message || 'Locked by admin', until: null };
    if (state.phase === 'setup') return { reason: 'setup', message: 'Waiting for the game to start', until: null };
    if (state.phase === 'paused') return { reason: 'paused', message: 'Game paused', until: null };
    if (state.phase === 'finished') return { reason: 'finished', message: 'Game finished', until: null };
    if (state.phase === 'transition') return {
      reason: state.transitionEndsAt === null ? 'waiting' : 'transition',
      message: state.transitionEndsAt === null ? 'Waiting for next round' : 'Round transition',
      until: state.transitionEndsAt,
    };
    return null;
  }

  seatView(team: Team, seat: Seat): SeatView {
    const slot = team.slots.find((item) => item.seatIndex === seat.index);
    const attempt = slot ? this.activeAttempt(slot) : undefined;
    const problem = attempt ? this.store.state.problems.find((item) => item.id === attempt.problemId) : undefined;
    const submissions: SubmissionPublic[] = attempt
      ? this.store.state.submissions.filter((item) => item.attemptId === attempt.id)
        .sort((a, b) => b.createdAt - a.createdAt).map(({ code: _code, cfAccount: _account, ...item }) => item)
      : [];
    const langs = this.store.state.languages.filter((item) => item.enabled);
    const maxRounds = Math.min(this.store.state.config.maxRoundsPerProblem ?? team.size, team.size);
    return {
      eventName: this.store.state.config.eventName,
      team: { id: team.id, name: team.name, size: team.size },
      seat: { index: seat.index, label: seat.label },
      clock: this.clock(),
      lock: this.lockForSeat(),
      announcement: this.store.state.announcement,
      config: {
        allowLocalRun: this.store.state.config.allowLocalRun,
        allowSampleLoad: this.store.state.config.allowSampleLoad,
        allowLanguageSwitch: this.store.state.config.allowLanguageSwitch,
        clientEditorFontSize: this.store.state.config.clientEditorFontSize,
        showRoundsLeftToClients: this.store.state.config.showRoundsLeftToClients,
        showScoreboardToClients: this.store.state.config.showScoreboardToClients,
        submissionCooldownSeconds: this.store.state.config.submissionCooldownSeconds,
        judgeMode: this.store.state.config.judgeMode,
      },
      languages: langs.map(({ id, name, monaco }) => ({ id, name, monaco })),
      slot: {
        id: slot?.id ?? '',
        problem: problem ? this.problemPublic(problem, true) : null,
        lang: slot?.lang ?? '',
        code: slot?.code ?? {},
        input: slot?.input ?? '',
        roundsShown: attempt?.roundsShown ?? 0,
        maxRounds,
        solvedCount: slot ? this.store.state.attempts.filter((item) => item.slotId === slot.id && item.outcome === 'solved').length : 0,
        submissions,
      },
      scoreboard: this.store.state.config.showScoreboardToClients ? this.visibleScoreboard() : null,
      rev: this.store.state.rev,
    };
  }

  visibleScoreboard(): ScoreRow[] {
    if (this.store.state.config.freezeScoreboard && this.store.state.frozenScoreboard) return this.store.state.frozenScoreboard;
    return this.scoreboard();
  }

  changed(): void {
    this.store.changed();
    this.scheduleDeadline();
    this.onChange?.();
  }

  private scheduleDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    const state = this.store.state;
    let deadline: number | null = null;
    if (state.phase === 'running') deadline = state.roundEndsAt;
    else if (state.phase === 'transition') deadline = state.transitionEndsAt;
    if (deadline === null) return;
    this.deadlineTimer = setTimeout(() => {
      if (this.store.state.phase === 'running') this.beginTransition();
      else if (this.store.state.phase === 'transition') this.finishTransition();
    }, Math.max(0, deadline - Date.now()));
    this.deadlineTimer.unref();
  }

  submissionForClient(submission: Submission): SubmissionPublic {
    const { code: _code, cfAccount: _cfAccount, ...publicSubmission } = submission;
    return publicSubmission;
  }
}
