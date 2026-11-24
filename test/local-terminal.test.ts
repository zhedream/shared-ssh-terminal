import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { spawn } from 'node-pty';
import { spawnLocalTerminal } from '../src/local-terminal.js';
import { LocalSession } from '../src/sessions.js';

async function eventually<T>(check: () => Promise<T | undefined>) {
  const deadline = Date.now() + 10000;
  do {
    const value = await check();
    if (value !== undefined) return value;
    await delay(60);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for isolated PowerShell fixture');
}

function isRunning(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('Windows local ConPTY preserves cwd and output across a natural exit', {
  skip: process.platform !== 'win32', timeout: 35000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sst local shell '));
  const session = new LocalSession({ kind: 'local', name: 'fixture', cwd: directory,
    command: 'Write-Output (Get-Location).Path; exit 7' }, undefined, '', 'browser');
  try {
    const exited = once(session, 'exit', { signal: AbortSignal.timeout(20000) });
    await session.start((bind, signal) => spawnLocalTerminal(spawn, directory, session.launch, session.cols, session.rows, bind, signal));
    assert.equal((await exited)[0], 7);
    const summary = session.summary();
    assert.equal(summary.kind, 'local');
    assert.equal(summary.processState, 'exited');
    assert.equal(summary.generation, 1);
    assert((await session.screen(false)).text.includes(path.basename(directory)));
  } finally {
    session.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('Windows local Job tracks descendants after the root exits and restarts the same session', {
  skip: process.platform !== 'win32', timeout: 50000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sst local job '));
  const sentinel = spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  const shell = "Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') " +
    "-ArgumentList '-NoProfile -Command Start-Sleep -Seconds 60' -PassThru | " +
    "ForEach-Object { Set-Content -LiteralPath 'child.pid' -Value $_.Id }; exit 0";
  const session = new LocalSession({ kind: 'local', name: 'job', cwd: directory, command: shell }, undefined, '', 'browser');
  const launch: Parameters<LocalSession['start']>[0] = (bind, signal) => spawnLocalTerminal(spawn, directory, session.launch, session.cols, session.rows, bind, signal);
  const childFile = path.join(directory, 'child.pid');
  const readPid = () => eventually(async () => {
    const pid = Number(await readFile(childFile, 'utf8').catch(() => ''));
    return pid > 0 ? pid : undefined;
  });
  try {
    await once(sentinel, 'spawn');
    await session.start(launch);
    const first = await readPid();
    assert(isRunning(first));
    await delay(500);
    assert.equal(session.summary().processState, 'running');
    const stoppingAt = Date.now();
    const stop = session.stop('graceful');
    assert.equal(stop, session.stop('graceful'));
    assert.throws(() => session.restart(launch), /正在执行另一项操作/);
    await stop;
    assert(Date.now() - stoppingAt >= 7900);
    assert.equal(session.summary().processState, 'stopped');
    assert.equal(session.summary().forced, true);
    assert(!isRunning(first));
    const history = await session.observe('browser', 'history', {}, false);
    assert(history.lines.some(line => line.text.includes('已强制终止')));
    assert.equal(sentinel.exitCode, null);
    const id = session.id;
    await rm(childFile, { force: true });
    await session.restart(launch);
    assert.equal(session.id, id);
    assert.equal(session.summary().generation, 2);
    const second = await readPid();
    assert.notEqual(second, first);
    await session.stop('force');
    assert(!isRunning(second));
    assert.equal(sentinel.exitCode, null);
  } finally {
    session.close();
    const done = sentinel.exitCode === null ? once(sentinel, 'exit') : Promise.resolve();
    sentinel.kill();
    await done;
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('Windows Job clears its PowerShell process when the isolated broker exits without shutdown', {
  skip: process.platform !== 'win32', timeout: 35000,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sst broker crash '));
  const fixture = [
    `import { spawn } from ${JSON.stringify(import.meta.resolve('node-pty'))};`,
    `import { spawnLocalTerminal } from ${JSON.stringify(new URL('../src/local-terminal.ts', import.meta.url).href)};`,
    "const cwd = process.argv[2];",
    "const launch = { kind: 'local', name: 'broker crash fixture', cwd,",
    "  command: \"Set-Content -LiteralPath 'worker.pid' -Value $PID; Start-Sleep -Seconds 60\" };",
    "await spawnLocalTerminal(spawn, cwd, launch, 100, 30,",
    "  pty => { pty.onData(data => process.stderr.write(data)); pty.onExit(() => {}); }, new AbortController().signal);",
    "setInterval(() => {}, 1000);",
  ].join('\n');
  const entry = path.join(directory, 'broker.mjs');
  await writeFile(entry, fixture);
  const broker = spawnProcess(process.execPath, ['--import', import.meta.resolve('tsx'), entry, directory],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  broker.stderr?.setEncoding('utf8').on('data', chunk => { diagnostic += chunk; });
  const ended = once(broker, 'exit');
  try {
    const pid = await eventually(async () => {
      assert.equal(broker.exitCode, null, diagnostic);
      const value = Number(await readFile(path.join(directory, 'worker.pid'), 'utf8').catch(() => ''));
      return value > 0 ? value : undefined;
    }).catch(error => { throw new Error(diagnostic || String(error)); });
    assert(isRunning(pid));
    assert(broker.kill());
    await ended;
    await eventually(async () => isRunning(pid) ? undefined : true);
  } finally {
    if (broker.exitCode === null && broker.signalCode === null) broker.kill();
    await ended;
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
