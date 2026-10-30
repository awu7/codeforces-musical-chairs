import assert from 'node:assert/strict';
import { parseCustomTestResponse } from '../src/cf/bridge.js';

const accepted = parseCustomTestResponse({
  status: 'OK',
  verdict: 'OK',
  output: '42\n',
  timeMs: 15,
  exitCode: 0,
});
assert.equal(accepted.kind, 'result');
if (accepted.kind === 'result') {
  assert.equal(accepted.result.status, 'ok');
  assert.equal(accepted.result.stdout, '42\n');
  assert.equal(accepted.result.timeMs, 15);
  assert.equal(accepted.result.exitCode, 0);
}

const compilationError = parseCustomTestResponse({
  status: 'OK',
  verdict: 'COMPILATION_ERROR',
  compilerOutput: 'main.cpp: error: expected expression',
  output: '',
});
assert.equal(compilationError.kind, 'result');
if (compilationError.kind === 'result') {
  assert.equal(compilationError.result.status, 'compile_error');
  assert.match(compilationError.result.compileOutput, /expected expression/);
}

const failedCompilation = parseCustomTestResponse({
  status: 'ERROR',
  error: 'Compilation error',
  compilerOutput: 'main.cpp: expected expression',
});
assert.equal(failedCompilation.kind, 'result');
if (failedCompilation.kind === 'result') {
  assert.equal(failedCompilation.result.status, 'compile_error');
  assert.match(failedCompilation.result.compileOutput, /expected expression/);
}

assert.deepEqual(parseCustomTestResponse({ status: 'OK', verdict: 'TESTING' }), { kind: 'pending' });
assert.deepEqual(parseCustomTestResponse({ status: 'OK', customTestSubmitId: 123 }), {
  kind: 'submitted',
  submitId: '123',
});

console.log('Custom test response parser PASS: accepted, compilation errors, pending, submitted');
