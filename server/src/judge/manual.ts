import type { Submission } from '../../../shared/types.js';
import type { JudgeResult } from './local.js';

export function autoAccept(): Promise<JudgeResult> {
  return new Promise((resolve) => setTimeout(() => resolve({
    verdict: 'OK',
    passedTests: 1,
    failedTest: null,
    timeMs: 0,
    memoryKb: null,
    message: null,
  }), 1000));
}

export function waitingForManualVerdict(_submission: Submission): JudgeResult {
  return {
    verdict: 'JUDGING',
    passedTests: 0,
    failedTest: null,
    timeMs: null,
    memoryKb: null,
    message: 'Waiting for an administrator verdict',
  };
}
