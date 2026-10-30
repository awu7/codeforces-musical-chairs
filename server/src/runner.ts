import { spawn, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Language, RunResult } from '../../shared/types.js';

const OUTPUT_LIMIT = 64 * 1024;

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeMs: number;
  truncated: boolean;
}

function substitute(args: string[], src: string, dir: string, memoryMb: number): string[] {
  return args.map((arg) => arg.replaceAll('{src}', src).replaceAll('{dir}', dir).replaceAll('{mem}', String(memoryMb)));
}

function processWithLimit(
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    timeoutMs: number;
    memoryMb: number;
    applyLimits: boolean;
    applyMemoryLimit?: boolean;
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const usePrlimit = options.applyLimits && process.platform === 'linux';
    const actualCommand = usePrlimit ? 'prlimit' : command;
    const actualArgs = usePrlimit
      ? [
        `--cpu=${Math.max(1, Math.ceil(options.timeoutMs / 1000))}`,
        ...(options.applyMemoryLimit === false ? [] : [`--as=${options.memoryMb * 1024 * 1024}`]),
        '--', command, ...args,
      ]
      : args;
    let child: ChildProcess;
    try {
      child = spawn(actualCommand, actualArgs, {
        cwd: options.cwd,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: options.cwd, TMPDIR: options.cwd },
      });
    } catch (error) {
      resolve({
        stdout: '', stderr: (error as Error).message, exitCode: null, signal: null,
        timedOut: false, timeMs: Date.now() - start, truncated: false,
      });
      return;
    }
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let truncated = false;
    const capture = (current: Buffer, chunk: Buffer): Buffer => {
      const available = Math.max(0, OUTPUT_LIMIT - current.length);
      if (chunk.length > available) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, available)]);
    };
    child.stdout?.on('data', (chunk: Buffer) => { stdout = capture(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = capture(stderr, chunk); });
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
    }, options.timeoutMs);
    timer.unref();
    child.on('error', (error) => {
      clearTimeout(timer);
      stderr = capture(stderr, Buffer.from(error.message));
      resolve({
        stdout: stdout.toString(), stderr: stderr.toString(), exitCode: null, signal: null,
        timedOut, timeMs: Date.now() - start, truncated,
      });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.toString(), stderr: stderr.toString(), exitCode, signal,
        timedOut, timeMs: Date.now() - start, truncated,
      });
    });
  });
}

export class Runner {
  private active = 0;
  private waiting: Array<() => void> = [];
  private readonly capacity = Math.max(1, cpus().length);

  async run(language: Language, code: string, input: string, timeLimitMs: number, memoryMb: number): Promise<RunResult> {
    await this.acquire();
    let dir: string | null = null;
    try {
      dir = await mkdtemp(path.join(tmpdir(), 'musical-chairs-'));
      const src = path.join(dir, language.srcFile);
      await writeFile(src, code, { mode: 0o600 });
      if (language.compile) {
        const compile = substitute(language.compile, src, dir, memoryMb);
        const compiled = await processWithLimit(compile[0], compile.slice(1), {
          cwd: dir, timeoutMs: 15_000, memoryMb: Math.max(memoryMb, 512), applyLimits: false,
        });
        if (compiled.exitCode !== 0) {
          return {
            status: 'compile_error', stdout: '', stderr: '', compileOutput: compiled.stderr || compiled.stdout,
            timeMs: compiled.timeMs, exitCode: compiled.exitCode, truncated: compiled.truncated,
          };
        }
      }
      const runArgs = substitute(language.run, src, dir, memoryMb);
      const command = runArgs.shift();
      if (!command) return {
        status: 'error', stdout: '', stderr: 'Language run command is empty', compileOutput: '',
        timeMs: 0, exitCode: null, truncated: false,
      };
      const result = await processWithLimit(command, runArgs, {
        cwd: dir, input, timeoutMs: Math.max(1, timeLimitMs * 2), memoryMb,
        applyLimits: true,
        applyMemoryLimit: language.id !== 'java21',
      });
      let status: RunResult['status'] = 'ok';
      if (result.timedOut) status = 'timeout';
      else if (result.exitCode !== 0) status = result.signal === 'SIGKILL' ? 'memory' : 'runtime_error';
      return {
        status, stdout: result.stdout, stderr: result.stderr, compileOutput: '',
        timeMs: result.timeMs, exitCode: result.exitCode, truncated: result.truncated,
      };
    } catch (error) {
      return {
        status: 'error', stdout: '', stderr: (error as Error).message, compileOutput: '',
        timeMs: 0, exitCode: null, truncated: false,
      };
    } finally {
      try {
        if (dir) await rm(dir, { recursive: true, force: true });
      } finally {
        this.release();
      }
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

export function sameTokens(actual: string, expected: string): boolean {
  return actual.trim().split(/\s+/).filter(Boolean).join('\0') === expected.trim().split(/\s+/).filter(Boolean).join('\0');
}
