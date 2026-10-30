import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Language, RunResult } from '../../shared/types.js';
import { Store } from './store.js';

export interface Runner {
  run(language: Language, code: string, input: string, limits?: { timeMs: number; memoryMb: number }): Promise<RunResult>;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
}

interface IsolateOptions {
  binary?: string;
}

function execute(binary: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(binary, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : error ? null : 0;
      resolve({ exitCode: code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error });
    });
  });
}

function errorResult(stderr: string): RunResult {
  return { status: 'error', stdout: '', stderr, compileOutput: '', timeMs: 0, memoryKb: null, exitCode: null, truncated: false };
}

function isMissingBinary(error: Error | null): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function parseMeta(text: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return meta;
}

function readTime(meta: Record<string, string>): number {
  const seconds = Number(meta.time ?? meta['time-wall'] ?? 0);
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0;
}

function substituteArgs(args: string[], src: string, exe: string): string[] {
  return args.map((arg) => arg.replaceAll('{src}', src).replaceAll('{exe}', exe));
}

function resolveExecutable(args: string[]): string[] {
  const [command, ...rest] = args;
  return command && !command.includes('/') ? ['/usr/bin/env', command, ...rest] : args;
}

function isOutputLimitExceeded(meta: Record<string, string>, stderr: string): boolean {
  return Number(meta.exitsig ?? meta.signal) === 25 || /File too large|File size limit exceeded|SIGXFSZ/i.test(stderr);
}

async function readCapped(file: string, limitBytes: number): Promise<{ text: string; truncated: boolean }> {
  try {
    const buffer = await readFile(file);
    return { text: buffer.subarray(0, limitBytes).toString('utf8'), truncated: buffer.byteLength >= limitBytes };
  } catch {
    return { text: '', truncated: false };
  }
}

function languageSource(language: Language): string {
  const src = language.srcFile;
  if (!src || src === '.' || src === '..' || path.basename(src) !== src) throw new Error('Language source filename must be a basename');
  return src;
}

class BoxPool {
  private readonly active = new Set<number>();
  private readonly waiters = new Set<() => void>();

  constructor(store: Store) {
    store.on('change', () => this.wake());
  }

  async acquire(store: Store): Promise<{ id: number; release: () => void }> {
    while (true) {
      const base = Math.max(0, Math.floor(store.state.config.isolateBoxBase));
      const count = Math.max(1, Math.floor(store.state.config.maxConcurrentRuns));
      for (let offset = 0; offset < count; offset += 1) {
        const id = base + offset;
        if (!this.active.has(id)) {
          this.active.add(id);
          return {
            id,
            release: () => {
              this.active.delete(id);
              this.wake();
            },
          };
        }
      }
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  private wake(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}

export class IsolateRunner implements Runner {
  private readonly binary: string;
  private readonly pool: BoxPool;

  constructor(private readonly store: Store, options: IsolateOptions = {}) {
    this.binary = options.binary ?? process.env.ISOLATE_BIN ?? 'isolate';
    this.pool = new BoxPool(store);
  }

  async run(
    language: Language,
    code: string,
    input: string,
    limits?: { timeMs: number; memoryMb: number },
  ): Promise<RunResult> {
    const lease = await this.pool.acquire(this.store);
    const { id, release } = lease;
    let boxDir = '';
    let initialized = false;
    let result = errorResult('Sandbox (isolate) unavailable');
    let metaDir = '';

    try {
      const config = this.store.state.config;
      const timeMs = Math.max(1, Math.floor(limits?.timeMs ?? config.runTimeLimitMs));
      const memoryMb = Math.max(1, Math.floor(limits?.memoryMb ?? config.runMemoryMb));
      const maxOutputMb = Math.max(1, Math.floor(config.maxOutputMb));
      const maxOutputBytes = maxOutputMb * 1024 * 1024;
      const source = languageSource(language);
      const executable = 'program';
      await execute(this.binary, ['--cg', '-b', String(id), '--cleanup'], 10_000);
      const init = await execute(this.binary, ['--cg', '-b', String(id), '--init'], 10_000);
      boxDir = init.stdout.trim().split(/\r?\n/).at(-1) ?? '';
      if (init.error || init.exitCode !== 0 || !boxDir) return errorResult('Sandbox (isolate) unavailable');
      initialized = true;
      metaDir = await mkdtemp(path.join(os.tmpdir(), 'musical-chairs-isolate-'));
      await writeFile(path.join(boxDir, 'box', source), code, { encoding: 'utf8' });
      await writeFile(path.join(boxDir, 'box', 'input.txt'), input, { encoding: 'utf8' });

      if (language.compile?.length) {
        if (!Array.isArray(language.compile)) return errorResult('Language compile command is invalid');
        const compileMeta = path.join(metaDir, 'compile.meta');
        const compileTimeSec = Math.max(0.001, config.compileTimeLimitMs / 1000);
        const compileArgs = [
          '--cg', '-b', String(id),
          `--time=${compileTimeSec}`,
          `--wall-time=${compileTimeSec}`,
          '--cg-mem=1048576',
          '--processes=64',
          '--fsize=262144',
          '-E', 'PATH=/usr/bin:/bin',
          '--chdir=/box',
          '--stdout=/box/compile.stdout',
          '--stderr=/box/compile.stderr',
          `--meta=${compileMeta}`,
          '--run', '--',
          ...resolveExecutable(substituteArgs(language.compile, source, executable)),
        ];
        const compiled = await execute(this.binary, compileArgs, config.compileTimeLimitMs + 10_000);
        if (isMissingBinary(compiled.error)) return errorResult('Sandbox (isolate) unavailable');
        const meta = parseMeta(await readFile(compileMeta, 'utf8').catch(() => ''));
        const stdout = await readCapped(path.join(boxDir, 'box', 'compile.stdout'), maxOutputBytes);
        const stderr = await readCapped(path.join(boxDir, 'box', 'compile.stderr'), maxOutputBytes);
        const compileOutput = `${stdout.text}${stderr.text}`;
        if (meta.status === 'XX' || (!Object.keys(meta).length && compiled.exitCode !== 0)) {
          return errorResult(compiled.stderr || 'Sandbox (isolate) failed while compiling');
        }
        if (meta['cg-oom-killed'] === '1' || meta.status || Number(meta.exitcode ?? 0) !== 0 || compiled.exitCode !== 0) {
          return {
            status: 'compile_error',
            stdout: '',
            stderr: stderr.text,
            compileOutput,
            timeMs: readTime(meta),
            memoryKb: Number.isFinite(Number(meta['cg-mem'])) ? Number(meta['cg-mem']) : null,
            exitCode: Number.isFinite(Number(meta.exitcode)) ? Number(meta.exitcode) : null,
            truncated: stdout.truncated || stderr.truncated,
          };
        }
      }

      if (!Array.isArray(language.run) || !language.run.length) return errorResult('Language run command is not configured');
      const metaPath = path.join(metaDir, 'run.meta');
      const runTimeSec = timeMs / 1000;
      const wallTimeSec = (timeMs * 2 + 1000) / 1000;
      const runArgs = [
        '--cg', '-b', String(id),
        `--cg-mem=${memoryMb * 1024}`,
        `--time=${runTimeSec}`,
        `--wall-time=${wallTimeSec}`,
        `--processes=${Math.max(1, Math.floor(language.processes ?? 1))}`,
        `--fsize=${maxOutputMb * 1024}`,
        '-E', 'PATH=/usr/bin:/bin',
        '--chdir=/box',
        '--stdin=/box/input.txt',
        '--stdout=/box/stdout.txt',
        '--stderr=/box/stderr.txt',
        `--meta=${metaPath}`,
        '--run', '--',
        ...resolveExecutable(substituteArgs(language.run, source, executable)),
      ];
      const ran = await execute(this.binary, runArgs, Math.ceil(wallTimeSec * 1000) + 10_000);
      if (isMissingBinary(ran.error)) return errorResult('Sandbox (isolate) unavailable');
      const meta = parseMeta(await readFile(metaPath, 'utf8').catch(() => ''));
      const stdout = await readCapped(path.join(boxDir, 'box', 'stdout.txt'), maxOutputBytes);
      const stderr = await readCapped(path.join(boxDir, 'box', 'stderr.txt'), maxOutputBytes);
      const exitValue = Number(meta.exitcode);
      const exitCode = Number.isFinite(exitValue) ? exitValue : null;
      const outputLimitExceeded = isOutputLimitExceeded(meta, stderr.text);
      let status: RunResult['status'] = 'ok';
      if (meta['cg-oom-killed'] === '1') status = 'memory';
      else if (outputLimitExceeded) status = 'runtime_error';
      else if (meta.status === 'TO' || meta.killed === '1') status = 'timeout';
      else if (meta.status === 'XX' || !Object.keys(meta).length || (meta.status === undefined && exitCode === null)) status = 'error';
      else if (meta.status === 'RE' || meta.status === 'SG' || (exitCode !== null && exitCode !== 0)) status = 'runtime_error';
      const stderrText = [stderr.text, outputLimitExceeded ? 'output limit exceeded' : ''].filter(Boolean).join('\n');
      result = {
        status,
        stdout: stdout.text,
        stderr: stderrText || (status === 'error' ? ran.stderr : ''),
        compileOutput: '',
        timeMs: readTime(meta),
        memoryKb: Number.isFinite(Number(meta['cg-mem'])) ? Number(meta['cg-mem']) : null,
        exitCode,
        truncated: stdout.truncated || stderr.truncated,
      };
    } catch (caught) {
      result = errorResult((caught as Error).message);
    } finally {
      const cleaned = await execute(this.binary, ['--cg', '-b', String(id), '--cleanup'], 10_000);
      if (initialized && (cleaned.error || cleaned.exitCode !== 0) && result.status !== 'error') {
        result = errorResult('Sandbox (isolate) cleanup failed');
      }
      if (metaDir) await rm(metaDir, { recursive: true, force: true }).catch(() => undefined);
      release();
    }
    return result;
  }
}
