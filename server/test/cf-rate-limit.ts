import assert from 'node:assert/strict';
import { userStatus } from '../src/cf/api.js';
import { CodeforcesSubmissionPoller } from '../src/judge/codeforces-poller.js';

const originalFetch = globalThis.fetch;
const calls: Array<{ handle: string; count: string | null; at: number }> = [];
let retryCount = 0;

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const handle = url.searchParams.get('handle') ?? '';
  calls.push({ handle, count: url.searchParams.get('count'), at: Date.now() });
  if (handle === 'retry' && retryCount++ === 0) {
    return new Response(JSON.stringify({ status: 'FAILED', comment: 'Call limit exceeded' }), { status: 400 });
  }
  const result = handle === 'shared'
    ? [{ id: 501, verdict: 'OK', passedTestCount: 3 }, { id: 502, verdict: 'WRONG_ANSWER', passedTestCount: 1 }]
    : [];
  return new Response(JSON.stringify({ status: 'OK', result }), { status: 200 });
};

try {
  await Promise.all([userStatus('limiter-one'), userStatus('limiter-two')]);
  const first = calls.filter((call) => call.handle.startsWith('limiter-'));
  assert.equal(first.length, 2);
  assert.ok(first[1]!.at - first[0]!.at >= 2100, 'API calls must be spaced by at least 2100ms');

  const retryStart = calls.length;
  await userStatus('retry');
  const retryCalls = calls.slice(retryStart);
  assert.equal(retryCalls.length, 2);
  assert.ok(retryCalls[1]!.at - retryCalls[0]!.at >= 5000, 'Call limit errors must back off for 5 seconds');

  const poller = new CodeforcesSubmissionPoller();
  const sharedStart = calls.length;
  const [accepted, rejected] = await Promise.all([
    poller.waitFor('shared', 501),
    poller.waitFor('shared', 502),
  ]);
  assert.equal(accepted.verdict, 'OK');
  assert.equal(rejected.verdict, 'WRONG_ANSWER');
  const sharedCalls = calls.slice(sharedStart).filter((call) => call.handle === 'shared');
  assert.equal(sharedCalls.length, 1);
  assert.equal(sharedCalls[0]!.count, '50');

  console.log('CF API PASS: 2100ms serialized spacing, 5s call-limit retry, shared per-handle status poll');
} finally {
  globalThis.fetch = originalFetch;
}
