import type { Language, Problem, Submission } from '../../../shared/types.js';
import { sameTokens, type Runner } from '../isolate.js';
import type { Store } from '../store.js';
import { loadProblemTests, testsRoot } from '../testdata.js';

export { sameTokens };

export interface JudgeResult {
  verdict: string;
  passedTests: number;
  failedTest: number | null;
  timeMs: number | null;
  memoryKb: number | null;
  message: string | null;
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
    let diskData: Awaited<ReturnType<typeof loadProblemTests>>;
    try {
      diskData = await loadProblemTests(testsRoot(this.store), problem.id);
    } catch (error) {
      return {
        verdict: 'JUDGE_ERROR', passedTests: 0, failedTest: null, timeMs: null, memoryKb: null,
        message: (error as Error).message,
      };
    }
    const tests = problem.testCount > 0
      ? [...diskData.tests, ...problem.extraTests]
      : [...problem.samples, ...problem.extraTests];
    if (!tests.length) return {
      verdict: 'JUDGE_ERROR', passedTests: 0, failedTest: null, timeMs: null, memoryKb: null,
      message: 'Problem has no test data',
    };
    let passedTests = 0;
    let maxTimeMs = 0;
    let maxMemoryKb = 0;
    const results = await this.runner.runTests(
      language,
      submission.code,
      tests,
      {
        timeMs: timeLimitMs(problem.timeLimit, this.store.state.config.runTimeLimitMs),
        memoryMb: memoryLimitMb(problem.memoryLimit, this.store.state.config.runMemoryMb),
      },
    );
    if (!results.length) return {
      verdict: 'JUDGE_ERROR', passedTests: 0, failedTest: null, timeMs: null, memoryKb: null,
      message: 'Runner returned no test results',
    };
    for (let i = 0; i < results.length; i += 1) {
      const testResult = results[i]!;
      const result = testResult.run;
      maxTimeMs = Math.max(maxTimeMs, result.timeMs);
      maxMemoryKb = Math.max(maxMemoryKb, result.memoryKb ?? 0);
      if (testResult.verdict === 'judge_error') return {
        verdict: 'JUDGE_ERROR', passedTests, failedTest: i + 1, timeMs: result.timeMs,
        memoryKb: result.memoryKb, message: result.stderr || 'Sandbox unavailable',
      };
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
      if (testResult.verdict === 'wrong_answer') return {
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
