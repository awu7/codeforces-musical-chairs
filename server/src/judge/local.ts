import type { Language, Problem, Submission } from '../../../shared/types.js';
import type { Runner } from '../cf/runner.js';

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

export class LocalJudge {
  constructor(private readonly runner: Runner) {}

  async judge(submission: Submission, language: Language, problem: Problem): Promise<JudgeResult> {
    const tests = [...problem.samples, ...problem.extraTests];
    if (!tests.length) return {
      verdict: 'JUDGE_ERROR', passedTests: 0, failedTest: null, timeMs: null, memoryKb: null,
      message: 'Problem has no samples or extra tests',
    };
    let passedTests = 0;
    let maxTimeMs = 0;
    for (let i = 0; i < tests.length; i += 1) {
      const test = tests[i]!;
      const result = await this.runner.run(language, submission.code, test.input);
      maxTimeMs = Math.max(maxTimeMs, result.timeMs);
      if (result.status === 'compile_error') return {
        verdict: 'COMPILATION_ERROR', passedTests, failedTest: i + 1, timeMs: result.timeMs,
        memoryKb: null, message: result.compileOutput,
      };
      if (result.status === 'timeout') return {
        verdict: 'TIME_LIMIT_EXCEEDED', passedTests, failedTest: i + 1, timeMs: result.timeMs,
        memoryKb: null, message: result.stderr || null,
      };
      if (result.status === 'memory') return {
        verdict: 'MEMORY_LIMIT_EXCEEDED', passedTests, failedTest: i + 1, timeMs: result.timeMs,
        memoryKb: null, message: result.stderr || null,
      };
      if (result.status !== 'ok') return {
        verdict: 'RUNTIME_ERROR', passedTests, failedTest: i + 1, timeMs: result.timeMs,
        memoryKb: null, message: result.stderr || `Process exited with ${result.exitCode}`,
      };
      if (!sameTokens(result.stdout, test.output)) return {
        verdict: 'WRONG_ANSWER', passedTests, failedTest: i + 1, timeMs: result.timeMs,
        memoryKb: null, message: null,
      };
      passedTests += 1;
    }
    return {
      verdict: 'OK', passedTests, failedTest: null, timeMs: maxTimeMs, memoryKb: null, message: null,
    };
  }
}
