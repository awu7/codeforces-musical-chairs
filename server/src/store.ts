import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Attempt,
  CfBridgeStatus,
  CfAccountPublic,
  GameConfig,
  Language,
  LogEntry,
  Problem,
  Submission,
  Team,
} from '../../shared/types.js';
import { DEFAULT_CONFIG, DEFAULT_LANGUAGES } from './defaults.js';

export interface CfAccount extends CfAccountPublic {
  password: string;
}

export interface PersistedState {
  config: GameConfig;
  phase: 'setup' | 'running' | 'paused' | 'transition' | 'finished';
  round: number;
  roundEndsAt: number | null;
  transitionEndsAt: number | null;
  pausedRemainingMs: number | null;
  lock: { locked: boolean; message: string };
  announcement: string | null;
  teams: Team[];
  attempts: Attempt[];
  submissions: Submission[];
  problems: Problem[];
  languages: Language[];
  cfAccounts: CfAccount[];
  cfBridge: CfBridgeStatus;
  adminTokens: string[];
  log: LogEntry[];
  rev: number;
  frozenScoreboard: import('../../shared/types.js').ScoreRow[] | null;
  lastSubmissionAt: Record<string, number>;
}

function freshState(): PersistedState {
  return {
    config: structuredClone(DEFAULT_CONFIG),
    phase: 'setup',
    round: 0,
    roundEndsAt: null,
    transitionEndsAt: null,
    pausedRemainingMs: null,
    lock: { locked: false, message: '' },
    announcement: null,
    teams: [],
    attempts: [],
    submissions: [],
    problems: [],
    languages: structuredClone(DEFAULT_LANGUAGES),
    cfAccounts: [],
    cfBridge: { mode: 'cdp', cdpUrl: 'http://localhost:29229', connected: false, queueLength: 0, lastError: null },
    adminTokens: [],
    log: [],
    rev: 0,
    frozenScoreboard: null,
    lastSubmissionAt: {},
  };
}

export class Store extends EventEmitter {
  readonly dir: string;
  readonly file: string;
  state: PersistedState = freshState();
  private saveTimer: NodeJS.Timeout | null = null;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(dir = process.env.DATA_DIR ?? path.resolve('data')) {
    super();
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'state.json');
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<PersistedState>;
      const base = freshState();
      const savedConfig: Record<string, unknown> = { ...parsed.config };
      const languages = parsed.languages?.map((language) => {
        const defaultLanguage = base.languages.find((item) => item.id === language.id);
        const savedLanguage = language as Language;
        return {
          ...defaultLanguage,
          ...savedLanguage,
          compile: savedLanguage.compile ?? defaultLanguage?.compile,
          run: savedLanguage.run ?? defaultLanguage?.run ?? [],
          processes: savedLanguage.processes ?? defaultLanguage?.processes,
        };
      });
      const teams = parsed.teams?.map((team) => ({
        ...team,
        cfHandle: team.cfHandle || undefined,
        selfSubmitStatus: team.selfSubmitStatus ?? { lastPollAt: null, lastError: null },
        processedCfSubmissionIds: (team.processedCfSubmissionIds ?? []).slice(-500),
      }));
      this.state = {
        ...base,
        ...parsed,
        teams: teams ?? base.teams,
        submissions: (parsed.submissions ?? base.submissions).map((submission) => ({
          ...submission,
          source: submission.source ?? 'server',
        })),
        config: {
          ...base.config,
          ...savedConfig,
          difficulty: { ...base.config.difficulty, ...parsed.config?.difficulty },
        },
        cfBridge: { ...base.cfBridge, ...parsed.cfBridge },
        languages: languages ?? base.languages,
      } as PersistedState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Could not load ${this.file}: ${(error as Error).message}`);
      }
    }
  }

  changed(): void {
    this.state.rev += 1;
    this.emit('change');
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 1000);
    this.saveTimer.unref();
  }

  async save(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const snapshot = JSON.stringify(this.state);
    const write = async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    };
    const pending = this.saveQueue.then(write, write);
    this.saveQueue = pending;
    await pending;
  }

  log(level: LogEntry['level'], msg: string): void {
    this.state.log.push({ t: Date.now(), level, msg });
    this.state.log = this.state.log.slice(-500);
  }

  async close(): Promise<void> {
    await this.save();
  }
}

export function mergeConfig(current: GameConfig, patch: Partial<GameConfig>): GameConfig {
  return {
    ...current,
    ...patch,
    difficulty: { ...current.difficulty, ...patch.difficulty },
  };
}
