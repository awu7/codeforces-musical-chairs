import type { Language, Problem, Submission } from '../../../shared/types.js';
import type { Runner } from '../isolate.js';
import type { Store } from '../store.js';

export interface JudgeResult {
  verdict: string;
  passedTests: number;
  failedTest: number | null;
  timeMs: number | null;
  memoryKb: number | null;
  message: string | null;
}

export function sameTokens(actual: string, expected: string): boolean {
  const left = actual.trim().split(/\s+/).filter(Boolean);
  const right = expected.trim().split(/\s+/).filter(Boolean);
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function timeLimitMs(value: string | null, fallback: number): number {
  const text = value ?? '';
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return fallback;
  const amount = Number(match[1]);
  if (/millisecond|\bms\b/i.test(text)) return Math.max(1, Math.round(amount));
  if (/minute/i.test(text)) return Math.max(1, Math.round(amount * 60_000));
  return Math.max(1, Math.round(amount * 1000));
}

function memoryLimitMb(value: string | null, fallback: number): number {
  const text = value ?? '';
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return fallback;
  const amount = Number(match[1]);
  if (/kilo|\bkb\b/i.test(text)) return Math.max(1, Math.round(amount / 1024));
  if (/giga|\bgb\b/i.test(text)) return Math.max(1, Math.round(amount * 1024));
  return Math.max(1, Math.round(amount));
}

export class LocalJudge {
  constructor(private readonly runner: Runner, private readonly store: Store) {}

  async judge(submission: Submission, language: Language, problem: Problem): Promise<JudgeResult> {
    const tests = [...problem.samples, ...problem.extraTests];
    if (!tests.length) return {
      verdict: 'JUDGE_ERROR', passedTests: 0, failedTest: null, timeMs: null, memoryKb: null,
      message: 'Problem has no samples or extra tests',
    };
    let passedTests = 0;
    let maxTimeMs = 0;
    let maxMemoryKb = 0;
    for (let i = 0; i < tests.length; i += 1) {
      const test = tests[i]!;
      const result = await this.runner.run(language, submission.code, test.input, {
        timeMs: timeLimitMs(problem.timeLimit, this.store.state.config.runTimeLimitMs),
        memoryMb: memoryLimitMb(problem.memoryLimit, this.store.state.config.runMemoryMb),
      });
      maxTimeMs = Math.max(maxTimeMs, result.timeMs);
      maxMemoryKb = Math.max(maxMemoryKb, result.memoryKb ?? 0);
      if (result.status === 'compile_error') return {
        verdict: 'COMPILATION_ERROR', passedTests, failedTest: i + 1, timeMs: result.timeMs,
        memoryKb: result.memoryKb, message: result.compileOutput,
      };
      if (result.status === 'timeout') return {
        verdict: 'TIME_LIMIT_EXCEEDED', passedTests, failedTest: i + 1, timeMs: result.timeMs,
        memoryKb: result.memoryKb, message: result.stderr || null,
      };
      if (result.status === 'memory') return {
        verdict: 'MEMORY_LIMIT_EXCEEDED', passedTests, failedTest: i + 1, timeMs: result.timeMs,
        memoryKb: result.memoryKb, message: result.stderr || null,
      };
      if (result.status === 'error') return {
        verdict: 'JUDGE_ERROR', passedTests, failedTest: i + 1, timeMs: result.timeMs,
        memoryKb: result.memoryKb, message: result.stderr || 'Sandbox unavailable',
      };
      if (result.status !== 'ok') return {
        verdict: 'RUNTIME_ERROR', passedTests, failedTest: i + 1, timeMs: result.timeMs,
        memoryKb: result.memoryKb, message: result.stderr || `Process exited with ${result.exitCode}`,
      };
      if (!sameTokens(result.stdout, test.output)) return {
        verdict: 'WRONG_ANSWER', passedTests, failedTest: i + 1, timeMs: result.timeMs,
        memoryKb: result.memoryKb, message: null,
      };
      passedTests += 1;
    }
    return {
      verdict: 'OK', passedTests, failedTest: null, timeMs: maxTimeMs, memoryKb: maxMemoryKb || null, message: null,
    };
  }
}
