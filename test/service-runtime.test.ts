import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installRoot, servicePaths } from '../src/paths.js';
import { findService } from '../src/service-runtime.js';

const run = promisify(execFile);
const nodeArgs = ['--import', 'tsx', 'src/cli.ts'];

async function fixture(t: TestContext, stop = true) {
  const prefix = path.resolve(tmpdir(), 'sst-service-test-');
  const directory = await mkdtemp(prefix);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SHARED_SSH_DATA_DIR: path.join(directory, 'data'), SHARED_SSH_RUNTIME_DIR: path.join(directory, 'runtime'),
    SHARED_SSH_PORT: '43128',
  };
  for (const key of Object.keys(env)) if (key.startsWith('SHARED_SSH_LAN_')) delete env[key];
  const paths = servicePaths(env);
  const cli = (command: string) => run(process.execPath, [...nodeArgs, command], {
    cwd: installRoot, env, windowsHide: true, timeout: 16000,
  });
  t.after(async () => {
    if (stop) await cli('stop');
    const resolved = path.resolve(directory);
    assert(resolved.startsWith(prefix) && path.dirname(resolved) === path.dirname(prefix));
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  });
  await mkdir(paths.runtime);
  return { directory, env, paths, cli };
}

async function connectMcp(t: TestContext, env: Record<string, string | undefined>) {
  const client = new Client({ name: 'service-runtime-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [...nodeArgs, 'mcp'], cwd: installRoot,
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(() => client.close());
  await client.connect(transport, { timeout: 10000 });
  return { client, stderr: () => stderr };
}

async function whoami(client: Client) {
  const result = await client.callTool({ name: 'whoami', arguments: {} }, undefined, { timeout: 15000 });
  assert.equal(result.isError, undefined, 'MCP whoami must succeed');
  assert(Array.isArray(result.content) && result.content[0]?.type === 'text');
  return JSON.parse(result.content[0].text).id;
}

async function expectInstanceChange(client: Client, name = 'whoami', args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.code, 'service_instance_changed');
  assert.match(String(result.structuredContent?.error), /list_sessions.*create_session/);
  assert(Array.isArray(result.content) && result.content[0]?.type === 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent.instanceId;
}

test('default directories share one home root and explicit overrides resolve from the caller', () => {
  const home = path.resolve('fictional-home');
  const defaults = servicePaths({}, home);
  assert.equal(defaults.data, path.join(home, '.shared-terminal', 'data'));
  assert.equal(defaults.runtime, path.join(home, '.shared-terminal', 'runtime'));
  assert.equal(defaults.stdout, path.join(defaults.runtime, 'service.stdout.log'));
  const overrides = servicePaths({ SHARED_SSH_DATA_DIR: 'custom-data', SHARED_SSH_RUNTIME_DIR: 'custom-runtime' }, home);
  assert.equal(overrides.data, path.resolve('custom-data'));
  assert.equal(overrides.runtime, path.resolve('custom-runtime'));
});

test('simultaneous CLI and MCP first calls converge, and the same adapters reconnect after stop', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const [a, b, c] = await Promise.all([connectMcp(t, f.env), connectMcp(t, f.env), connectMcp(t, f.env)]);
  assert.deepEqual(JSON.parse((await f.cli('status')).stdout), { running: false, address: null, port: null });
  const started = await Promise.all([f.cli('server'), f.cli('server'), whoami(a.client), whoami(b.client), whoami(c.client)]);
  const first = JSON.parse(started[0].stdout);
  assert.deepEqual(JSON.parse(started[1].stdout), first);
  assert.equal(new Set(started.slice(2)).size, 3);
  assert.deepEqual(JSON.parse((await f.cli('status')).stdout), first);

  const connection = JSON.parse(await readFile(f.paths.connection, 'utf8'));
  const ui = JSON.parse(await readFile(f.paths.ui, 'utf8'));
  assert.equal(connection.pid, first.pid);
  assert.equal(connection.port, first.port);
  const logged = [(await readFile(f.paths.stdout, 'utf8')), (await readFile(f.paths.stderr, 'utf8')), started[0].stdout, a.stderr()].join('\n');
  assert.equal(logged.match(/共享 SSH 终端已启动/g)?.length, 1);
  assert(!logged.includes(connection.agentToken) && !logged.includes(ui.adminToken));

  const stopped = await f.cli('stop');
  assert.equal(JSON.parse(stopped.stdout).stopped, true);
  assert.match(stopped.stderr, /关闭其所有 SSH 会话/);
  await delay(2300); // at least one background watcher retry interval
  assert.equal(JSON.parse((await f.cli('status')).stdout).running, false);
  const changed = await expectInstanceChange(a.client);
  const second = JSON.parse(await readFile(f.paths.connection, 'utf8'));
  assert.equal(changed, second.instanceId);
  assert.notEqual(second.instanceId, connection.instanceId);
  assert(second.agentToken !== connection.agentToken, 'A new instance uses fresh credentials');
  assert.equal(await whoami(a.client), started[2]);
  assert.equal(await expectInstanceChange(b.client), second.instanceId);
  assert.equal(await whoami(b.client), started[3]);
});

test('a force-terminated service leaves a stale record and the next process gets a new instance ID', { timeout: 30000 }, async t => {
  const f = await fixture(t, false);
  const { client } = await connectMcp(t, f.env);
  const start = () => {
    const processUnderTest = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: installRoot, env: f.env, windowsHide: true, stdio: 'ignore',
    });
    const closed = once(processUnderTest, 'close');
    return {
      pid: processUnderTest.pid,
      async terminate() {
        if (processUnderTest.exitCode === null && processUnderTest.signalCode === null) processUnderTest.kill('SIGKILL');
        await closed;
      },
    };
  };
  async function discover(pid: number | undefined) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const connection = await findService(f.paths);
      if (connection?.pid === pid && connection?.instanceId) return connection;
      await delay(50);
    }
    throw new Error('Test service did not publish its instance ID');
  }
  const original = start();
  let replacement: ReturnType<typeof start> | undefined;
  try {
    const first = await discover(original.pid);
    const taskId = await whoami(client);
    await original.terminate();
    assert.equal(JSON.parse(await readFile(f.paths.connection, 'utf8')).instanceId, first.instanceId);
    assert.equal(await findService(f.paths), undefined);
    replacement = start();
    const next = await discover(replacement.pid);
    assert.notEqual(next.instanceId, first.instanceId);
    assert.equal(await expectInstanceChange(client), next.instanceId);
    assert.equal(await whoami(client), taskId);
  } finally {
    await original.terminate();
    await replacement?.terminate();
  }
});

test('an incomplete discovery is replaced and a startup failure can be repaired and retried', { timeout: 35000 }, async t => {
  const f = await fixture(t);
  const shortLived = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await once(shortLived, 'exit');
  await writeFile(f.paths.owner, JSON.stringify({ pid: shortLived.pid }));
  await writeFile(f.paths.connection, '{');
  await mkdir(f.paths.data);
  const profiles = path.join(f.paths.data, 'profiles.json');
  const privateMarker = randomBytes(24).toString('hex');
  await writeFile(profiles, `invalid profile containing ${privateMarker}`);
  await assert.rejects(f.cli('server'), error => {
    const { stderr } = error as { stderr?: string };
    return Boolean(stderr?.includes('本地服务启动失败') && !stderr.includes(privateMarker));
  });
  const startupLog = await readFile(f.paths.stderr, 'utf8');
  assert(startupLog.includes('无法加载本机服务器配置') && !startupLog.includes(privateMarker));
  assert.equal(JSON.parse((await f.cli('status')).stdout).running, false);
  await writeFile(profiles, '[]');
  assert.equal(JSON.parse((await f.cli('server')).stdout).running, true);
  assert.equal(JSON.parse((await readFile(f.paths.connection, 'utf8'))).address, '127.0.0.1');
});

test('stop rejects records copied from a different runtime and conservatively handles an unknown owner', { timeout: 35000 }, async t => {
  const active = await fixture(t);
  const other = await fixture(t, false);
  await active.cli('server');
  await copyFile(active.paths.connection, other.paths.connection);
  await copyFile(active.paths.ui, other.paths.ui);
  assert.equal(JSON.parse((await other.cli('status')).stdout).running, false);
  assert.equal(JSON.parse((await other.cli('stop')).stdout).stopped, false);
  assert.equal(JSON.parse((await active.cli('status')).stdout).running, true);
  await writeFile(other.paths.owner, '');
  await assert.rejects(other.cli('stop'), error => Boolean((error as { stderr?: string }).stderr?.includes('owner.json 不完整')));
  await assert.rejects(other.cli('server'), error => Boolean((error as { stderr?: string }).stderr?.includes('本地服务启动失败')));
  assert.equal(await readFile(other.paths.owner, 'utf8'), '');
  assert.equal(JSON.parse((await active.cli('status')).stdout).running, true);
});

test('a watcher switches generations without consuming the first active call warning', { timeout: 25000 }, async t => {
  const f = await fixture(t, false);
  const canonical = await realpath(f.paths.runtime);
  const runtime = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  const first = randomUUID(), second = randomUUID();
  const agentToken = randomBytes(32).toString('hex');
  const offline = Promise.withResolvers<void>();
  const originalWatch = Promise.withResolvers<void>();
  const replacementWatch = Promise.withResolvers<number>();
  const releaseReplacementWatch = Promise.withResolvers<void>();
  const activeProbe = Promise.withResolvers<void>();
  const releaseActiveProbe = Promise.withResolvers<void>();
  let available = true;
  let holdActiveProbe = false;
  let instanceId: string | undefined = first;
  let port: number;
  const writes: string[] = [];
  const registrations = new Map<string | undefined, number>();
  const broker = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${agentToken}`) { res.writeHead(401).end(); return; }
    if (req.url === '/agent/instance') {
      if (!available) { res.writeHead(503).end(); offline.resolve(); return; }
      if (holdActiveProbe) { activeProbe.resolve(); await releaseActiveProbe.promise; }
      res.end(JSON.stringify({ service: 'shared-ssh-terminal', runtime, pid: process.pid, port, address: '127.0.0.1', instanceId }));
      return;
    }
    const generation = instanceId;
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const { action, after, data } = JSON.parse(Buffer.concat(body).toString());
    if (action === 'register_agent') registrations.set(generation, (registrations.get(generation) ?? 0) + 1);
    if (action === 'watch_messages') {
      if (generation === first && after === 42) originalWatch.resolve();
      if (generation === second) {
        replacementWatch.resolve(after);
        await releaseReplacementWatch.promise;
      }
      await delay(50);
      res.end(JSON.stringify({ revision: 42, messages: [] }));
    } else if (action === 'whoami') res.end(JSON.stringify({ id: req.headers['x-agent-id'] }));
    else {
      if (action === 'send_input') writes.push(data);
      res.end('{}');
    }
  });
  t.after(() => new Promise<void>(resolve => {
    releaseReplacementWatch.resolve();
    releaseActiveProbe.resolve();
    broker.close(() => resolve());
    broker.closeAllConnections();
  }));
  broker.listen(0, '127.0.0.1');
  await once(broker, 'listening');
  const address = broker.address();
  assert(address && typeof address !== 'string');
  port = address.port;
  const publish = (id?: string) => writeFile(f.paths.connection, JSON.stringify({
    agentToken, port, url: `http://127.0.0.1:${port}`, address: '127.0.0.1', pid: process.pid, instanceId: id,
  }));
  // Keep the same bearer, PID and endpoint throughout. Only the authenticated ID identifies a switch.
  await publish(second);
  assert.equal(await findService(f.paths), undefined);
  await publish();
  assert.equal(await findService(f.paths), undefined);
  instanceId = undefined;
  assert(await findService(f.paths), 'Records from the previous version remain discoverable');
  instanceId = first;
  await publish(first);

  const { client } = await connectMcp(t, f.env);
  const taskId = await whoami(client);
  await originalWatch.promise;
  available = false;
  await offline.promise;
  assert.equal(await findService(f.paths), undefined);
  available = true;
  assert.equal(await whoami(client), taskId);
  assert.equal(registrations.get(first), 1);

  instanceId = undefined;
  await publish();
  assert.equal(await whoami(client), taskId, 'Unknown legacy instance ID does not signal a switch');

  instanceId = second;
  await publish(second);
  assert.equal(await replacementWatch.promise, 0, 'The first poll for the new instance must omit the old cursor');
  const input = { sessionId: randomUUID(), lease: randomUUID(), data: 'do not submit' };
  holdActiveProbe = true;
  const warnings = Promise.all([expectInstanceChange(client, 'send_input', input), expectInstanceChange(client, 'send_input', input)]);
  await activeProbe.promise;
  await client.ping(); // Both tool requests have arrived on stdio while discovery remains unresolved.
  releaseActiveProbe.resolve();
  assert.deepEqual(await warnings, [second, second]);
  assert.deepEqual(writes, []);
  assert.equal(await whoami(client), taskId);
  assert.equal(registrations.get(second), 1);
  const next = await client.callTool({ name: 'send_input', arguments: { ...input, data: 'explicit next input' } });
  assert.equal(next.isError, undefined);
  assert.deepEqual(writes, ['explicit next input']);
  releaseReplacementWatch.resolve();
});

test('a submitted send_input with a lost reply is reported once without replaying it', { timeout: 20000 }, async t => {
  const f = await fixture(t, false);
  const canonical = await realpath(f.paths.runtime);
  const runtime = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  const agentToken = randomBytes(32).toString('hex');
  let writes = 0;
  let port: number;
  const broker = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${agentToken}`) { res.writeHead(401).end(); return; }
    if (req.url === '/agent/instance') {
      res.end(JSON.stringify({ service: 'shared-ssh-terminal', runtime, pid: process.pid, port, address: '127.0.0.1' }));
      return;
    }
    const body = [];
    for await (const chunk of req) body.push(chunk);
    const { action } = JSON.parse(Buffer.concat(body).toString());
    if (action === 'send_input') { writes++; res.destroy(); return; }
    if (action === 'watch_messages') { res.end(JSON.stringify({ revision: 0, messages: [] })); return; }
    res.end('{}');
  });
  t.after(() => new Promise<void>(resolve => broker.close(() => resolve())));
  broker.listen(0, '127.0.0.1');
  await once(broker, 'listening');
  const address = broker.address();
  assert(address && typeof address !== 'string');
  port = address.port;
  await writeFile(f.paths.connection, JSON.stringify({ agentToken, port, url: `http://127.0.0.1:${port}`, address: '127.0.0.1', pid: process.pid }));
  const { client } = await connectMcp(t, f.env);
  const response = await client.callTool({ name: 'send_input', arguments: {
    sessionId: randomUUID(), lease: randomUUID(), data: 'fixture input',
  } }, undefined, { timeout: 5000 });
  assert.equal(response.isError, true);
  assert.equal(writes, 1);
  assert.equal(JSON.parse((await f.cli('status')).stdout).pid, process.pid);
  assert.equal(writes, 1);
});
