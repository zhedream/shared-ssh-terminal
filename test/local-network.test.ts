import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { request, type OutgoingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import { listenLocal } from '../src/local-network.js';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const ipv4 = '127.0.0.1';

async function reservePort(port: number) {
  const server = createServer();
  const listening = once(server, 'listening');
  server.listen(port, ipv4);
  await listening;
  const bound = server.address();
  assert(bound && typeof bound !== 'string');
  return { port: bound.port, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }) };
}

async function startService(t: TestContext, preferredPort?: number, blockDiscovery = false) {
  const prefix = path.resolve(tmpdir(), 'sst-local-network-');
  const directory = await mkdtemp(prefix);
  let stop: (() => Promise<void>) | undefined;
  t.after(async () => {
    await stop?.();
    const resolved = path.resolve(directory);
    assert(resolved.startsWith(prefix) && path.dirname(resolved) === path.dirname(prefix));
    await rm(resolved, { recursive: true, force: true });
  });
  const runtime = path.join(directory, 'runtime');
  const data = path.join(directory, 'data');
  if (blockDiscovery) await mkdir(path.join(runtime, 'connection.json'), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, SHARED_SSH_DATA_DIR: data, SHARED_SSH_RUNTIME_DIR: runtime };
  for (const key of Object.keys(env)) if (key.startsWith('SHARED_SSH_LAN_')) delete env[key];
  if (preferredPort === undefined) delete env.SHARED_SSH_PORT;
  else env.SHARED_SSH_PORT = String(preferredPort);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  // Stop only the child spawned for this test, before removing its fixture.
  stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  };

  async function discover() {
    for (let i = 0; i < 240; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Test service exited: ${stderr.trim()}`);
      let raw: string;
      try { raw = await readFile(path.join(runtime, 'connection.json'), 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await delay(50);
        continue;
      }
      const connection = JSON.parse(raw);
      assert.equal(connection.pid, child.pid);
      assert.equal(connection.address, ipv4);
      assert(Number.isInteger(connection.port) && connection.port >= 1024 && connection.port <= 65535);
      assert.equal(connection.url, `http://${ipv4}:${connection.port}`);
      assert(/^[a-f0-9]{64}$/.test(connection.agentToken), 'Legacy agentToken is available');
      const { adminToken } = JSON.parse(await readFile(path.join(runtime, 'ui.json'), 'utf8'));
      assert(/^[a-f0-9]{64}$/.test(adminToken) && adminToken !== connection.agentToken, 'Management uses a distinct token');
      return { port: connection.port as number, url: connection.url as string, adminToken,
        agentToken: connection.agentToken as string, instanceId: connection.instanceId as string };
    }
    throw new Error('Timed out waiting for test service discovery');
  }

  return { discover, data, runtime, closed, stderr: () => stderr };
}

async function wsSynced(authority: string, cookie: string) {
  const ws = new WebSocket(`ws://${authority}/terminal`, { origin: `http://${authority}`, headers: { cookie }, handshakeTimeout: 3000 });
  try {
    const synced = new Promise<string | undefined>((resolve, reject) => {
      let instanceId: string | undefined;
      ws.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'hello') instanceId = message.instanceId;
        if (message.type === 'synced') resolve(instanceId);
      });
      ws.once('error', reject);
      ws.once('close', code => reject(new Error(`WebSocket closed before sync: ${code}`)));
    });
    return await synced;
  } finally { ws.terminate(); }
}

test('isolated service uses the default port when available', { timeout: 20000 }, async t => {
  const defaultPort = 43127;
  let available = true;
  try { await (await reservePort(defaultPort)).close(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    available = false;
    t.diagnostic('Default port was already occupied; verifying fallback without contacting its listener');
  }
  const service = await startService(t);
  const { port } = await service.discover();
  if (available) assert.equal(port, defaultPort);
  else assert.notEqual(port, defaultPort);
});

test('isolated service keeps an available explicit port', { timeout: 20000 }, async t => {
  const preferred = await reservePort(0);
  await preferred.close();
  const service = await startService(t, preferred.port);
  assert.equal((await service.discover()).port, preferred.port);
});

test('port collision publishes a usable address for UI, WS and the original MCP adapter', { timeout: 30000 }, async t => {
  const preferred = await reservePort(0);
  t.after(preferred.close);
  const service = await startService(t, preferred.port);
  const { port, url, adminToken, agentToken, instanceId } = await service.discover();
  assert.notEqual(port, preferred.port);
  assert.match(instanceId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal((await fetch(`${url}/agent/instance`)).status, 401);
  assert.equal((await fetch(`${url}/agent/instance`, { headers: { authorization: `Bearer ${adminToken}` } })).status, 401);
  const instance = await fetch(`${url}/agent/instance`, { headers: { authorization: `Bearer ${agentToken}` } });
  assert.equal(instance.status, 200);
  assert.equal((await instance.json()).instanceId, instanceId);
  const authorization = `Bearer ${adminToken}`;
  const status = (target: string, headers: OutgoingHttpHeaders | string[] = {}, method = 'GET') => new Promise<number | undefined>((resolve, reject) => {
    const req = request(target, { headers, method, signal: AbortSignal.timeout(3000) }, response => {
      response.on('error', reject);
      response.on('end', () => resolve(response.statusCode));
      response.resume();
    });
    req.on('error', reject);
    req.end();
  });
  for (const host of [ipv4, 'localhost']) {
    const authority = `${host}:${port}`;
    const origin = `http://${authority}`;
    assert.equal(await status(`${origin}/`), 200);
    const issued = await fetch(url + '/api/pair-code', { method: 'POST', headers: { authorization } });
    assert.equal(issued.status, 200);
    const { code } = await issued.json();
    const redeemed = await fetch(origin + '/api/pair', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(redeemed.status, 204);
    const cookie = redeemed.headers.get('set-cookie')!.split(';')[0];
    assert.equal(await status(`${origin}/api/state`, { cookie }), 200);
    assert.equal(await wsSynced(authority, cookie), instanceId);
    assert.equal(await wsSynced(authority, cookie), instanceId);
  }
  assert.equal(await status(`${url}/api/state`, { authorization }), 401);
  assert.equal(await status(`${url}/api/state`), 401);
  assert.equal(await status(`${url}/agent`, { authorization }, 'POST'), 401);
  const rejectedHeaders = [
    { host: `example.invalid:${port}`, origin: `http://example.invalid:${port}` },
    { host: ipv4, origin: `http://${ipv4}:${port}` },
    { host: `${ipv4}:${preferred.port}`, origin: `http://${ipv4}:${preferred.port}` },
    { host: `${ipv4}:${port}`, origin: `http://localhost:${port}` },
    { host: `localhost:${port}`, origin: `http://${ipv4}:${port}` },
    { host: `${ipv4}:${port}`, origin: `https://${ipv4}:${port}` },
    { host: `${ipv4}:${port}`, origin: `http://${ipv4}:${preferred.port}` },
    { host: `${ipv4}:${port}`, origin: 'null' },
  ];
  for (const headers of rejectedHeaders) {
    assert.equal(await status(`${url}/api/state`, { authorization, ...headers }), 403, `${headers.host} with ${headers.origin}`);
    const ws = new WebSocket(`ws://${ipv4}:${port}/terminal`, { headers, handshakeTimeout: 3000 });
    try { await assert.rejects(once(ws, 'open'), /socket hang up/); }
    finally { ws.terminate(); }
  }
  assert.equal(await status(`${url}/api/state`, ['Authorization', authorization, 'Host', `${ipv4}:${port}`, 'Host', 'example.invalid']), 403);
  assert.equal(await status(`${url}/api/state`, ['Authorization', authorization, 'Host', `${ipv4}:${port}`, 'Origin', '', 'Origin', url]), 403);
  const noOrigin = new WebSocket(`ws://${ipv4}:${port}/terminal`, { handshakeTimeout: 3000 });
  try { await assert.rejects(once(noOrigin, 'open'), /socket hang up/); }
  finally { noOrigin.terminate(); }
  await assert.rejects(wsSynced(`${ipv4}:${port}`, ''), /Unexpected server response: 401/);

  const client = new Client({ name: 'local-network-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', 'src/mcp.ts'], cwd,
    env: { SHARED_SSH_DATA_DIR: service.data, SHARED_SSH_RUNTIME_DIR: service.runtime }, stderr: 'ignore',
  });
  try {
    await client.connect(transport, { timeout: 5000 });
    const whoami = await client.callTool({ name: 'whoami', arguments: {} }, undefined, { timeout: 5000 });
    assert.equal(whoami.isError, undefined);
    assert(Array.isArray(whoami.content));
    const result = whoami.content[0];
    assert(result.type === 'text' && typeof JSON.parse(result.text).id === 'string');
  } finally { await transport.close(); }

  assert.equal(await status(`${url}/api/shutdown`, { authorization }, 'POST'), 200);
  assert.deepEqual(await service.closed, [0, null]);
  assert.deepEqual(await readdir(service.runtime), ['pairing-key.json']);
});

test('a non-conflict bind error is propagated without a second bind', async t => {
  const server = createServer();
  const denied = Object.assign(new Error('bind denied'), { code: 'EACCES' });
  const attempt = t.mock.method(server, 'listen', () => {
    queueMicrotask(() => server.emit('error', denied));
    return server;
  });
  await assert.rejects(listenLocal(server, 43127), error => error === denied);
  assert.deepEqual(attempt.mock.calls.map(call => call.arguments), [[43127, ipv4]]);
  assert.equal(server.listenerCount('listening'), 0);
  assert.equal(server.listenerCount('error'), 0);
});

test('invalid port exits without publishing discovery', { timeout: 20000 }, async t => {
  const service = await startService(t, 0);
  assert.deepEqual(await service.closed, [1, null]);
  assert.match(service.stderr(), /1024 到 65535/);
  await assert.rejects(readdir(service.runtime), { code: 'ENOENT' });
});

test('failed discovery publication cleans up its temporary files and UI address', { timeout: 20000 }, async t => {
  const preferred = await reservePort(0);
  await preferred.close();
  const service = await startService(t, preferred.port, true);
  assert.deepEqual(await service.closed, [1, null]);
  assert.match(service.stderr(), /rename/);
  assert.deepEqual(await readdir(service.runtime), ['connection.json', 'pairing-key.json']);
  assert.deepEqual(await readdir(path.join(service.runtime, 'connection.json')), []);
});
