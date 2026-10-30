import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LANGUAGES } from '../src/defaults.js';
import { IsolateRunner } from '../src/isolate.js';
import { Store } from '../src/store.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'musical-chairs-isolate-test-'));
const store = new Store(dataDir);
await store.load();
store.state.config.isolateBoxBase = 500;
store.state.config.maxConcurrentRuns = 4;
store.state.config.outputLimitKb = 64;
store.state.config.maxOutputMb = 64;
const runner = new IsolateRunner(store);
const isolate = process.env.ISOLATE_BIN ?? 'isolate';
const cpp = store.state.languages.find((language) => language.id === 'cpp20') ?? DEFAULT_LANGUAGES[0]!;
const python = store.state.languages.find((language) => language.id === 'py3')!;

async function check(name: string, result: Awaited<ReturnType<IsolateRunner['run']>>): Promise<void> {
  assert.notEqual(result.status, 'error', `${name}: ${result.stderr}`);
  console.log(`PASS ${name}: status=${result.status} exit=${result.exitCode} timeMs=${result.timeMs}`);
}

try {
  try {
    execFileSync(isolate, ['--cg', '-b', '500', '--cleanup'], { stdio: 'ignore' });
  } catch {}
  execFileSync(isolate, ['--cg', '-b', '500', '--init'], { stdio: 'ignore' });

  const cppOk = await runner.run(cpp, '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}\n', '3 4\n');
  await check('C++20 stdout', cppOk);
  assert.equal(cppOk.stdout.trim(), '7');

  const pyOk = await runner.run(python, 'import sys\nprint(sum(map(int, sys.stdin.read().split())))\n', '5 6\n');
  await check('Python 3 stdout', pyOk);
  assert.equal(pyOk.stdout.trim(), '11');

  const outputLines = 200_000;
  const largeOutput = await runner.run(python, `for _ in range(${outputLines}): print("hello")\n`, '');
  assert.equal(largeOutput.status, 'ok', largeOutput.stderr);
  assert.equal(largeOutput.stdout.length, outputLines * 'hello\n'.length);
  assert.equal(largeOutput.truncated, false);
  console.log(`PASS 1.2 MB stdout: ${largeOutput.stdout.length} chars`);

  store.state.config.maxOutputMb = 1;
  const outputLimit = await runner.run(python, 'import sys\nsys.stdout.write("x" * (2 * 1024 * 1024))\n', '');
  assert.equal(outputLimit.status, 'runtime_error');
  assert.match(outputLimit.stderr, /output limit exceeded/i);
  assert.equal(outputLimit.truncated, true);
  console.log(`PASS maxOutputMb enforcement: status=${outputLimit.status} truncated=${outputLimit.truncated}`);
  store.state.config.maxOutputMb = 64;

  const compileError = await runner.run(cpp, 'int main( { return 0; }\n', '');
  assert.equal(compileError.status, 'compile_error');
  assert.ok(compileError.compileOutput.length > 0);
  console.log(`PASS compile error: compileOutput=${compileError.compileOutput.length} chars`);

  const runtimeError = await runner.run(cpp, 'int main(){return 7;}\n', '');
  assert.equal(runtimeError.status, 'runtime_error');
  assert.equal(runtimeError.exitCode, 7);
  console.log(`PASS runtime error: exit=${runtimeError.exitCode}`);

  const timeout = await runner.run(cpp, 'int main(){for(;;){}}\n', '', { timeMs: 300, memoryMb: 256 });
  assert.equal(timeout.status, 'timeout', timeout.stderr);
  console.log(`PASS infinite loop timeout: ${timeout.timeMs}ms`);

  const memory = await runner.run(
    cpp,
    '#include <sys/mman.h>\n#include <cstddef>\nint main(){auto n=1024ULL*1024*1024; volatile char* p=(char*)mmap(nullptr,n,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);for(size_t i=0;i<n;i+=4096)p[i]=1;}\n',
    '',
    { timeMs: 3000, memoryMb: 256 },
  );
  assert.equal(memory.status, 'memory', `${memory.status}: ${memory.stderr}`);
  console.log(`PASS 1GB allocation under 256MB: status=${memory.status} memoryKb=${memory.memoryKb}`);

  const forkBomb = await runner.run(
    { ...cpp, processes: 32 },
    '#include <unistd.h>\nint main(){for(;;)fork();}\n',
    '',
    { timeMs: 500, memoryMb: 256 },
  );
  assert.ok(['timeout', 'memory'].includes(forkBomb.status), `${forkBomb.status}: ${forkBomb.stderr}`);
  console.log(`PASS fork bomb contained: status=${forkBomb.status}`);

  const network = await runner.run(
    python,
    'import socket\ntry:\n socket.create_connection(("1.1.1.1",80),timeout=1)\n print("unexpected")\nexcept OSError:\n print("blocked")\n',
    '',
  );
  assert.equal(network.status, 'ok', network.stderr);
  assert.equal(network.stdout.trim(), 'blocked');
  console.log('PASS network access blocked');

  const filesystem = await runner.run(
    python,
    'try:\n open("/home/ubuntu/repos/musical-chairs/README.md").read()\n print("unexpected")\nexcept OSError:\n print("blocked")\n',
    '',
  );
  assert.equal(filesystem.status, 'ok', filesystem.stderr);
  assert.equal(filesystem.stdout.trim(), 'blocked');
  console.log('PASS host filesystem access blocked');

  store.state.config.maxOutputMb = 1;
  const fileSize = await runner.run(
    python,
    'try:\n f=open("large.bin","wb")\n for _ in range(100): f.write(b"x"*1024*1024)\n f.close()\n print("unexpected")\nexcept OSError:\n print("blocked")\n',
    '',
  );
  assert.equal(fileSize.status, 'ok', fileSize.stderr);
  assert.equal(fileSize.stdout.trim(), 'blocked');
  console.log('PASS 100MB file creation blocked by fsize');
  store.state.config.maxOutputMb = 64;

  const parallel = await Promise.all(Array.from({ length: 4 }, () =>
    runner.run(python, 'print("parallel")\n', ''),
  ));
  assert.ok(parallel.every((result) => result.status === 'ok' && result.stdout.trim() === 'parallel'));
  console.log('PASS four concurrent isolate runs');
} finally {
  try {
    execFileSync(isolate, ['--cg', '-b', '500', '--cleanup'], { stdio: 'ignore' });
  } catch {}
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
}
