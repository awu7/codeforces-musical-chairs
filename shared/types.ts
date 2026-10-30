// Shared contract between server and web. Type-only; no runtime code.

export type Phase = 'setup' | 'running' | 'paused' | 'transition' | 'finished';
export type JudgeMode = 'codeforces' | 'local' | 'manual' | 'auto-accept';
export type AttemptOutcome = 'active' | 'solved' | 'expired' | 'skipped';

export interface Language {
  id: string;               // e.g. "cpp20"
  name: string;             // e.g. "C++20 (GCC)"
  monaco: string;           // monaco language id: "cpp" | "python" | "java" ...
  cfProgramTypeId: number;  // Codeforces programTypeId used when forwarding
  srcFile: string;          // e.g. "main.cpp", "Main.java"
  template: string;         // initial editor contents
  enabled: boolean;
}

export interface SolvedRule { maxMinutes: number; delta: number } // first rule with solveMinutes <= maxMinutes wins

export interface DifficultyConfig {
  startRating: number;
  minRating: number;
  maxRating: number;
  step: number;                   // rating granularity of the pool (CF: 100)
  scope: 'slot' | 'team';         // next rating based on the slot's last problem, or a per-team rating
  solvedRules: SolvedRule[];      // sorted by maxMinutes asc
  slowSolveDelta: number;         // solved, but slower than every rule
  unsolvedDelta: number;          // expired after maxRoundsPerProblem rounds
  skippedDelta: number;           // admin skipped / replaced
  fallback: 'nearest' | 'lower' | 'higher'; // when no unused problem at the target rating
}

export interface GameConfig {
  roundMinutes: number;            // K
  transitionSeconds: number;       // lock time between rounds (physical mode)
  lazyMode: boolean;               // rotate slots between seats instead of people moving
  lazyTransitionSeconds: number;   // lock time in lazy mode (default 0 = instant)
  rotationDirection: 1 | -1;       // physical: person at seat i moves to i+dir; lazy: slot at seat i moves to i-dir (same relative effect)
  maxRoundsPerProblem: number | null; // null = team size
  totalRounds: number | null;      // auto-finish after this many rounds; null = unlimited
  autoAdvance: boolean;            // false = after transition, wait for admin to start next round
  judgeMode: JudgeMode;
  difficulty: DifficultyConfig;
  uniqueness: 'team' | 'global';   // never reuse a problem within a team / across all teams
  scoring: 'count' | 'rating';
  wrongSubmissionPenalty: number;  // points subtracted per rejected submission on a solved problem (0 = none)
  allowLocalRun: boolean;
  submissionCooldownSeconds: number;
  maxSubmissionsPerProblem: number | null;
  showScoreboardToClients: boolean;
  freezeScoreboard: boolean;
  showRatingToClients: boolean;
  showTagsToClients: boolean;
  showRoundsLeftToClients: boolean;
  allowSampleLoad: boolean;
  allowLanguageSwitch: boolean;
  clientEditorFontSize: number;
  eventName: string;
}

export interface Sample { input: string; output: string }

export interface Problem {
  id: string;               // "1850A" (gym: "102001A")
  contestId: number;
  index: string;
  name: string;
  rating: number;           // pool bucket (defaults to CF rating, admin-editable)
  cfRating: number | null;
  tags: string[];
  enabled: boolean;
  source: 'codeforces' | 'manual';
  statementHtml: string | null;   // inner HTML of the statement body (legend, input/output spec, notes), math as CF $$$...$$$
  timeLimit: string | null;       // e.g. "1 second"
  memoryLimit: string | null;     // e.g. "256 megabytes"
  samples: Sample[];
  extraTests: Sample[];           // admin-provided, used only by the local judge
  fetchStatus: 'none' | 'pending' | 'ok' | 'error';
  fetchError: string | null;
  fetchedAt: number | null;
}

// What clients see (no extraTests; rating/tags hidden per config)
export interface ProblemPublic {
  id: string;
  name: string;
  url: string;
  rating: number | null;
  tags: string[] | null;
  statementHtml: string | null;
  timeLimit: string | null;
  memoryLimit: string | null;
  samples: Sample[];            // empty if !allowSampleLoad (statement still shows them)
}

export interface Seat {
  index: number;
  label: string;          // e.g. "PC 1"
  code: string;           // 6-char join code
  connected: number;      // number of connected sockets
  lastSeen: number | null;
}

export interface Slot {
  id: string;
  teamId: string;
  seatIndex: number;              // seat currently displaying this slot
  attemptId: string | null;       // active attempt (null = no problem available)
  nextRating: number;             // rating that will be used for the next problem drawn into this slot
  lang: string;
  code: Record<string, string>;   // per language id
  input: string;
  updatedAt: number;
}

export interface Team {
  id: string;
  name: string;
  size: number;
  rating: number;                 // used when difficulty.scope === 'team'
  startRating: number | null;     // per-team override of difficulty.startRating
  seats: Seat[];
  slots: Slot[];                  // always `size` slots
  enabled: boolean;
}

export interface Attempt {
  id: string;
  teamId: string;
  slotId: string;
  problemId: string;
  rating: number;
  startedAt: number;
  startRound: number;
  endedAt: number | null;
  endRound: number | null;
  roundsShown: number;            // rounds (incl. partial) this problem has been displayed
  activeMs: number;               // time spent in 'running' phase while displayed (solve time)
  outcome: AttemptOutcome;
  wrongSubmissions: number;
  solvedBySeat: number | null;
}

export type SubmissionStatus = 'queued' | 'submitting' | 'judging' | 'done' | 'error';

export interface Submission {
  id: string;
  teamId: string;
  slotId: string;
  seatIndex: number;
  attemptId: string;
  problemId: string;
  lang: string;
  code: string;
  createdAt: number;
  judge: JudgeMode;
  status: SubmissionStatus;
  verdict: string | null;          // CF verdict strings: OK, WRONG_ANSWER, TIME_LIMIT_EXCEEDED, COMPILATION_ERROR, RUNTIME_ERROR, MEMORY_LIMIT_EXCEEDED, ...
  passedTests: number | null;
  failedTest: number | null;
  timeMs: number | null;
  memoryKb: number | null;
  cfSubmissionId: number | null;
  cfAccount: string | null;
  message: string | null;          // error / compile log / judge notes
  overridden: boolean;             // verdict set manually by admin
}

export type SubmissionPublic = Omit<Submission, 'code' | 'cfAccount'>;

export interface RunRequest { slotId: string; lang: string; code: string; input: string }
export interface RunResult {
  status: 'ok' | 'compile_error' | 'runtime_error' | 'timeout' | 'memory' | 'error';
  stdout: string;
  stderr: string;
  compileOutput: string;
  timeMs: number;
  exitCode: number | null;
  truncated: boolean;
}

// Clock: client computes remaining = endsAt - (Date.now() + (serverNow - receivedAt))
export interface GameClock {
  phase: Phase;
  round: number;                   // 1-based, 0 before start
  totalRounds: number | null;
  roundEndsAt: number | null;      // epoch ms, phase === 'running'
  transitionEndsAt: number | null; // epoch ms, phase === 'transition'
  pausedRemainingMs: number | null;// phase === 'paused'
  lazyMode: boolean;
  serverNow: number;
}

export interface LockInfo {
  reason: 'setup' | 'paused' | 'transition' | 'admin' | 'finished' | 'waiting';
  message: string;
  until: number | null;            // epoch ms (transition countdown)
}

export interface ScoreRow {
  teamId: string;
  teamName: string;
  solved: number;
  points: number;
  ratingSum: number;
  currentRating: number;           // team.rating, or mean of slot.nextRating
  solves: { problemId: string; rating: number; minutes: number; round: number }[];
}

export interface SeatView {
  eventName: string;
  team: { id: string; name: string; size: number };
  seat: { index: number; label: string };
  clock: GameClock;
  lock: LockInfo | null;
  announcement: string | null;
  config: Pick<GameConfig, 'allowLocalRun' | 'allowSampleLoad' | 'allowLanguageSwitch' | 'clientEditorFontSize' | 'showRoundsLeftToClients' | 'showScoreboardToClients' | 'submissionCooldownSeconds' | 'judgeMode'>;
  languages: Pick<Language, 'id' | 'name' | 'monaco'>[];
  slot: {
    id: string;
    problem: ProblemPublic | null;
    lang: string;
    code: Record<string, string>;
    input: string;
    roundsShown: number;
    maxRounds: number;
    solvedCount: number;           // problems solved in this slot so far
    submissions: SubmissionPublic[];  // for the active attempt, newest first
  };
  scoreboard: ScoreRow[] | null;
  rev: number;                     // increments on each server push for this seat
}

export interface LogEntry { t: number; level: 'info' | 'warn' | 'error'; msg: string }

export interface CfAccountPublic {
  handle: string;
  enabled: boolean;
  status: 'idle' | 'logging-in' | 'ready' | 'busy' | 'error';
  lastError: string | null;
  submissions: number;
  lastUsedAt: number | null;
}

export interface CfBridgeStatus {
  mode: 'cdp' | 'launch';
  cdpUrl: string | null;
  connected: boolean;
  queueLength: number;
  lastError: string | null;
}

export interface AdminState {
  config: GameConfig;
  clock: GameClock;
  lock: { locked: boolean; message: string };
  announcement: string | null;
  teams: Team[];
  attempts: Attempt[];              // all attempts
  submissions: SubmissionPublic[];  // newest first, capped (200)
  problems: Omit<Problem, 'statementHtml' | 'extraTests'>[]; // pool overview (fetch full via REST)
  languages: Language[];
  cfAccounts: CfAccountPublic[];
  cfBridge: CfBridgeStatus;
  scoreboard: ScoreRow[];
  log: LogEntry[];                  // newest last, capped (500)
}
