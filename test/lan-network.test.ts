import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import ssh2 from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadLanConfiguration, type LanDiscovery } from '../src/lan-network.js';
import { installRoot, servicePaths } from '../src/paths.js';

const run = promisify(execFile);
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const names = ['BIND', 'PORT', 'HOST', 'CERT', 'KEY'].map(key => 'SHARED_SSH_LAN_' + key);

async function reservePort(t: TestContext, address: string) {
  const server = createServer();
  server.listen(0, address);
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const bound = server.address();
  assert(bound && typeof bound !== 'string');
  return bound.port;
}

async function fixture(t: TestContext) {
  const localPort = await reservePort(t, '127.0.0.1');
  const prefix = path.resolve(tmpdir(), 'sst-lan-');
  const directory = await mkdtemp(prefix);
  const env: NodeJS.ProcessEnv = { ...process.env, SHARED_SSH_PORT: String(localPort),
    SHARED_SSH_DATA_DIR: path.join(directory, 'data'), SHARED_SSH_RUNTIME_DIR: path.join(directory, 'runtime') };
  for (const key of Object.keys(env)) if (key.startsWith('SHARED_SSH_LAN_')) delete env[key];
  const paths = servicePaths(env);
  const invoke = (env: NodeJS.ProcessEnv, ...args: string[]) => run(process.execPath,
    ['--import', tsx, path.join(installRoot, 'src/cli.ts'), ...args], { cwd: directory, env, windowsHide: true, timeout: 16000 });
  const cli = (...args: string[]) => invoke(env, ...args);
  t.after(async () => {
    await cli('stop');
    const resolved = path.resolve(directory);
    assert(resolved.startsWith(prefix) && path.dirname(resolved) === path.dirname(prefix));
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  });
  return { directory, env, paths, cli, invoke, localPort };
}

test('LAN is opt-in and rejects incomplete, ambiguous and wildcard configuration', async () => {
  assert.equal(await loadLanConfiguration({}), undefined);
  await assert.rejects(loadLanConfiguration({ SHARED_SSH_LAN_BIND: '192.168.0.1' }), /完整设置/);
  const env = { SHARED_SSH_LAN_BIND: '0.0.0.0', SHARED_SSH_LAN_PORT: '443', SHARED_SSH_LAN_HOST: 'terminal.test',
    SHARED_SSH_LAN_CERT: 'cert.pem', SHARED_SSH_LAN_KEY: 'key.pem' };
  await assert.rejects(loadLanConfiguration(env), /私有或链路本地/);
  env.SHARED_SSH_LAN_BIND = '192.168.0.1';
  await assert.rejects(loadLanConfiguration({ ...env, SHARED_SSH_LAN_HOST: 'terminal.test:443' }), /不含端口/);
  await assert.rejects(loadLanConfiguration({ ...env, SHARED_SSH_LAN_PORT: '0' }), /1 到 65535/);
});

test('Linux refuses LAN configuration before publishing a ready instance', {
  skip: process.platform !== 'linux', timeout: 25000,
}, async t => {
  const { env, paths, cli, localPort } = await fixture(t);
  Object.assign(env, { SHARED_SSH_LAN_BIND: '192.0.2.1', SHARED_SSH_LAN_PORT: String(localPort),
    SHARED_SSH_LAN_HOST: 'terminal.test', SHARED_SSH_LAN_CERT: 'missing-cert.pem', SHARED_SSH_LAN_KEY: 'missing-key.pem' });
  await assert.rejects(cli('server'), /本地服务启动失败/);
  assert.match(await readFile(paths.stderr, 'utf8'), /Linux 目前只支持本机回环/);
  assert.equal(JSON.parse((await cli('status')).stdout).running, false);
  for (const file of [paths.connection, paths.ui, paths.owner]) await assert.rejects(access(file), { code: 'ENOENT' });
});

test('Windows listeners share SSH while excluding all local terminal data from paired LAN', {
  skip: process.platform !== 'win32', timeout: 85000,
}, async t => {
  const interfaces = Object.values(networkInterfaces()).flatMap(value => value ?? []);
  const address = interfaces.find(item => item.family === 'IPv4' && !item.internal &&
    /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(item.address))?.address;
  if (!address) { t.skip('No private IPv4 interface for the isolated TLS test'); return; }
  const { directory, env, paths, cli, invoke, localPort } = await fixture(t);
  const blockedLanPort = await reservePort(t, address);
  Object.assign(env, { SHARED_SSH_LAN_BIND: address, SHARED_SSH_LAN_HOST: address,
    SHARED_SSH_LAN_PORT: String(blockedLanPort), SHARED_SSH_LAN_CERT: 'cert.pem', SHARED_SSH_LAN_KEY: 'key.pem' });
  const gitOpenSsl = path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe');
  const openssl = process.platform === 'win32' && await access(gitOpenSsl).then(() => true, () => false) ? gitOpenSsl : 'openssl';
  try {
    await run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=terminal.test',
      '-addext', `subjectAltName=IP:${address},DNS:terminal.test`, '-keyout', 'key.pem', '-out', 'cert.pem'], { cwd: directory, windowsHide: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { t.skip('OpenSSL is unavailable'); return; }
    throw error;
  }
  await assert.rejects(invoke({ ...env, SHARED_SSH_LAN_HOST: 'wrong.test' }, 'server'));
  assert((await readFile(paths.stderr, 'utf8')).includes('证书的 SAN'));
  await assert.rejects(invoke({ ...env, SHARED_SSH_LAN_KEY: 'cert.pem' }, 'server'));
  assert((await readFile(paths.stderr, 'utf8')).includes('证书或私钥无效'));
  const unassigned = ['192.168.250.254', '192.168.251.254'].find(ip => !interfaces.some(item => item.address === ip))!;
  await assert.rejects(invoke({ ...env, SHARED_SSH_LAN_BIND: unassigned }, 'server'));
  assert((await readFile(paths.stderr, 'utf8')).includes('无法监听局域网 HTTPS'));
  await assert.rejects(access(paths.connection), { code: 'ENOENT' });
  await assert.rejects(access(paths.ui), { code: 'ENOENT' });

  const first = JSON.parse((await cli('server')).stdout) as { address: string; port: number; lan: LanDiscovery };
  assert.equal(first.address, '127.0.0.1');
  assert.notEqual(first.port, localPort);
  assert.equal(first.lan.address === address, true);
  assert.notEqual(first.lan.port, blockedLanPort);
  assert.deepEqual(JSON.parse((await cli('status')).stdout).lan, first.lan);
  const local = `http://127.0.0.1:${first.port}`;
  const ca = await readFile(path.join(directory, 'cert.pem'));
  const tlsHttp = (route: string, options: { method?: string; headers?: Record<string, string>; body?: string; trusted?: boolean; servername?: string } = {}, origin = first.lan.origin) =>
    new Promise<{ status: number; cookie?: string; body: string }>((resolve, reject) => {
      const req = request(origin + route, { method: options.method, headers: options.headers,
        ca: options.trusted === false ? undefined : ca, servername: options.servername ?? '', agent: false, signal: AbortSignal.timeout(3000) }, res => {
        let body = '';
        res.setEncoding('utf8').on('data', part => body += part);
        res.once('error', reject);
        res.once('end', () => resolve({ status: res.statusCode ?? 0, cookie: res.headers['set-cookie']?.[0], body }));
      });
      req.once('error', reject);
      req.end(options.body);
    });

  await assert.rejects(tlsHttp('/', { trusted: false }));
  await assert.rejects(tlsHttp('/', { servername: 'wrong.test' }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  assert.equal((await tlsHttp('/')).status, 200);
  assert.equal((await tlsHttp('/api/auth')).status, 401);
  assert.equal((await tlsHttp('/api/auth', { headers: { Host: 'wrong.test', 'X-Forwarded-Host': new URL(first.lan.origin).host } })).status, 403);
  assert.equal((await tlsHttp('/api/auth', { headers: { Origin: local, 'X-Forwarded-Proto': 'https' } })).status, 403);
  const ws = (headers: Record<string, string> = {}) => new WebSocket(first.lan.origin.replace('https:', 'wss:') + '/terminal', { ca, headers, handshakeTimeout: 3000 });
  const anonymous = ws({ Origin: first.lan.origin });
  try { await assert.rejects(once(anonymous, 'open'), /401/); } finally { anonymous.terminate(); }

  const code = async (...args: string[]) => {
    const link = new URL((await cli('pair', ...args)).stdout.trim());
    assert.equal(link.origin === (args.length ? first.lan.origin : local), true);
    return JSON.stringify({ code: link.hash.slice('#pair='.length) });
  };
  const localCode = await code();
  const lanCode = await code('--lan');
  const localRedeem = (body: string) => fetch(local + '/api/pair', { method: 'POST', headers: { Origin: local, 'Content-Type': 'application/json' }, body });
  const lanRedeem = (body: string) => tlsHttp('/api/pair', { method: 'POST', headers: { Origin: first.lan.origin, 'Content-Type': 'application/json' }, body });
  assert.equal((await localRedeem(lanCode)).status, 400);
  assert.equal((await lanRedeem(localCode)).status, 400);
  const localResult = await localRedeem(localCode);
  const lanResult = await lanRedeem(lanCode);
  assert.equal(localResult.status, 204);
  assert.equal(lanResult.status, 204);
  assert.equal((await lanRedeem(lanCode)).status, 400);
  assert(Boolean(lanResult.cookie?.startsWith('__Host-') && /; Secure$/.test(lanResult.cookie) && /; HttpOnly; SameSite=Strict; Path=\//.test(lanResult.cookie)));
  const localCookie = localResult.headers.get('set-cookie')!.split(';')[0];
  const lanCookie = lanResult.cookie!.split(';')[0];
  assert.equal((await fetch(local + '/api/auth', { headers: { Cookie: lanCookie } })).status, 401);
  assert.equal((await tlsHttp('/api/auth', { headers: { Cookie: localCookie } })).status, 401);
  assert.equal((await tlsHttp('/api/auth', { headers: { Cookie: lanCookie } })).status, 204);
  assert.equal((await tlsHttp('/api/profiles', { method: 'POST', headers: { Cookie: lanCookie }, body: '{}' })).status, 403);
  const hostKeys = [generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey];
  const connections = new Set<ssh2.Connection>();
  const remoteCommands: string[] = [];
  const ssh = new ssh2.Server({ hostKeys }, connection => {
    connections.add(connection);
    connection.on('error', () => {});
    connection.once('close', () => connections.delete(connection));
    connection.on('authentication', context => context.accept());
    connection.on('ready', () => connection.on('session', accept => {
      const session = accept();
      session.on('pty', accept => accept?.());
      session.on('shell', accept => { const stream = accept(); stream.write('LAN SSH FIXTURE\r\n'); stream.on('data', data => stream.write(data)); });
      session.on('exec', (accept, _reject, info) => {
        remoteCommands.push(info.command);
        const stream = accept(); stream.write('LAN SSH DIRECTORY FIXTURE\r\n'); stream.on('data', data => stream.write(data));
      });
    }));
  });
  ssh.listen(0, '127.0.0.1');
  await once(ssh, 'listening');
  t.after(async () => {
    for (const connection of connections) connection.end();
    await new Promise<void>(resolve => ssh.close(() => resolve()));
  });
  const sshAddress = ssh.address();
  assert(sshAddress && typeof sshAddress !== 'string');
  const created = await fetch(local + '/api/profiles', { method: 'POST', headers: { Cookie: localCookie, Origin: local, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Shared LAN fixture', host: '127.0.0.1', username: 'fixture', auth: 'password', port: sshAddress.port }) });
  assert.equal(created.status, 200);
  const profile = await created.json();
  const synced = ws({ Origin: first.lan.origin, Cookie: lanCookie });
  try {
    const hello = JSON.parse((await once(synced, 'message'))[0].toString());
    assert.equal(hello.type, 'hello');
    assert.equal(hello.profiles[0].name, 'Shared LAN fixture');
  } finally { synced.terminate(); }
  const crossOrigin = ws({ Origin: local, Cookie: lanCookie });
  try { await assert.rejects(once(crossOrigin, 'open'), /socket hang up/); } finally { crossOrigin.terminate(); }

  async function browser(socket: WebSocket) {
    const frames: any[] = [];
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
    socket.on('error', () => {});
    t.after(() => socket.terminate());
    const find = async (predicate: (packet: any) => boolean) => {
      const deadline = Date.now() + 18000;
      do {
        const packet = frames.find(predicate);
        if (packet) return packet;
        await delay(30);
      } while (Date.now() < deadline);
      throw new Error('Expected WS frame not received');
    };
    const rpc = (type: string, data: Record<string, unknown> = {}) => {
      const requestId = randomUUID();
      socket.send(JSON.stringify({ type, requestId, ...data }));
      return find(packet => packet.requestId === requestId);
    };
    await find(packet => packet.type === 'synced');
    return { frames, find, rpc };
  }
  const lanHeaders = { Origin: first.lan.origin, Cookie: lanCookie, 'X-Forwarded-For': '127.0.0.1' };
  const [lanBrowser, localBrowser] = await Promise.all([
    browser(ws(lanHeaders)),
    browser(new WebSocket(local.replace('http:', 'ws:') + '/terminal', { headers: { Origin: local, Cookie: localCookie } })),
  ]);
  assert.equal(lanBrowser.frames[0].capabilities.localTerminal, false);
  assert.equal(lanBrowser.frames[0].capabilities.localTerminalUnavailableReason, 'loopback_only');
  assert.equal(localBrowser.frames[0].capabilities.localTerminal, true);
  assert.equal((await lanBrowser.rpc('open-local-shell')).code, 'local_terminal_unavailable');
  assert.equal((await tlsHttp('/api/run-configs', { headers: lanHeaders })).status, 404);
  const invalid = await localBrowser.rpc('open-local-shell', { cwd: path.join(directory, 'absent fixture') });
  assert.equal(invalid.code, 'invalid_cwd');
  const main = await localBrowser.rpc('open-local-shell', { cwd: directory, startKey: 'local-fixture' });
  assert.equal(main.type, 'ack');
  const { sessionId } = main.result;
  const again = await localBrowser.rpc('open-local-shell', { cwd: directory, startKey: 'local-fixture' });
  assert.deepEqual(again.result, { sessionId, reused: true });
  assert.equal((await localBrowser.rpc('takeover', { sessionId })).type, 'ack');
  const state = localBrowser.frames.filter(frame => frame.type === 'state' && frame.session.id === sessionId).at(-1).session;
  assert.equal((await localBrowser.rpc('input', { sessionId, revision: state.revision, data: "Write-Output ('LOCAL_' + 'PROBE')\r" })).type, 'ack');
  await localBrowser.find(frame => frame.type === 'output' && frame.sessionId === sessionId && frame.data.includes('LOCAL_PROBE'));
  assert.equal((await localBrowser.rpc('read-history', { sessionId })).type, 'ack');
  for (const action of ['read-history', 'input', 'takeover', 'clear-history']) {
    const denied = await lanBrowser.rpc(action, { sessionId, data: 'fixture', revision: 0 });
    const absent = await lanBrowser.rpc(action, { sessionId: randomUUID(), data: 'fixture', revision: 0 });
    assert.deepEqual([denied.type, denied.error, denied.code], [absent.type, absent.error, absent.code]);
    assert.equal(denied.code, 'session_not_found');
  }
  for (const id of [sessionId, randomUUID()]) {
    assert.deepEqual((await lanBrowser.rpc('dismiss-tab', { sessionId: id })).result, { ok: true });
  }
  const save = await fetch(local + '/api/run-configs', { method: 'POST',
    headers: { Origin: local, Cookie: localCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'isolated command', cwd: directory, command: 'Start-Sleep -Seconds 60' }) });
  assert.equal(save.status, 200);
  const { id: configId } = await save.json();
  const runConfigs = await (await fetch(local + '/api/run-configs', { headers: { Cookie: localCookie } })).json();
  assert.equal(runConfigs[0].id, configId);
  await localBrowser.find(frame => frame.type === 'run-configs' && frame.runConfigs.some((row: any) => row.id === configId));
  const localNew = await browser(new WebSocket(local.replace('http:', 'ws:') + '/terminal', { headers: { Origin: local, Cookie: localCookie } }));
  const starts = await Promise.all([localBrowser.rpc('start-run', { configId }), localNew.rpc('start-run', { configId })]);
  assert.equal(starts[0].result.sessionId, starts[1].result.sessionId);
  assert.deepEqual(starts.map(frame => frame.result.reused).sort(), [false, true]);
  const lanState = await tlsHttp('/api/state', { headers: lanHeaders });
  assert(!lanState.body.includes(sessionId) && !lanState.body.includes(configId));
  const lateLan = await browser(ws(lanHeaders));
  assert(!JSON.stringify(lateLan.frames).includes(sessionId));
  assert(!JSON.stringify(lanBrowser.frames).includes(configId));
  assert(!lanBrowser.frames.some(frame => frame.sessionId === sessionId || frame.session?.id === sessionId || frame.type === 'run-configs'));

  const client = new Client({ name: 'isolated LAN boundary test', version: '0.0.1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', tsx, path.join(installRoot, 'src/cli.ts'), 'mcp'], cwd: directory,
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: 'pipe' });
  transport.stderr?.resume();
  t.after(() => client.close());
  await client.connect(transport);
  const invokeTool = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const call = async (name: string, args?: Record<string, unknown>) => {
    const result = await invokeTool(name, args);
    assert.equal(result.isError, undefined);
    assert(Array.isArray(result.content) && result.content[0]?.type === 'text');
    return JSON.parse(result.content[0].text);
  };
  assert.equal((await call('get_capabilities')).localTerminal, true);
  assert.equal((await call('list_run_configs'))[0].id, configId);
  assert.deepEqual(await call('start_run', { configId }), { sessionId: starts[0].result.sessionId, reused: true });
  const visible = (await call('list_sessions', { scope: 'all' })).find((row: any) => row.id === sessionId);
  assert.equal(visible.cwd, undefined);
  assert.equal(visible.isMine, false);
  assert.equal((await invokeTool('read_screen', { sessionId })).isError, true);
  await call('attach_session', { sessionId });
  const screen = await call('read_screen', { sessionId });
  assert(screen.lines.some((line: any) => line.text.includes('LOCAL_PROBE')));
  const lease = (await call('take_control', { sessionId })).lease;
  assert.equal((await invokeTool('stop_session', { sessionId, lease: randomUUID() })).isError, true);
  await call('handoff_to_user', { sessionId, lease });
  assert.equal((await invokeTool('stop_session', { sessionId, lease })).structuredContent?.code, 'handed_to_user');
  assert.equal((await localBrowser.rpc('privacy', { sessionId, privateMode: true })).type, 'ack');
  assert.equal((await invokeTool('read_screen', { sessionId })).isError, true);
  assert.equal((await invokeTool('restart_session', { sessionId, lease })).isError, true);
  await client.close();

  assert.equal((await localBrowser.rpc('stop-session', { sessionId, mode: 'force' })).result.processState, 'stopped');
  assert.equal((await localBrowser.rpc('delete-session', { sessionId })).type, 'ack');
  assert.equal((await localBrowser.rpc('stop-session', { sessionId: starts[0].result.sessionId, mode: 'force' })).type, 'ack');

  const lanSsh = await lanBrowser.rpc('create', { profileId: profile.id });
  assert.equal(lanSsh.type, 'ack');
  assert.equal(lanSsh.result.kind, 'ssh');
  const sshId = lanSsh.result.id;
  await lanBrowser.find(frame => frame.type === 'output' && frame.sessionId === sshId && frame.data.includes('fingerprint'));
  assert.equal((await lanBrowser.rpc('input', { sessionId: sshId, revision: lanSsh.result.revision, data: 'yes\r' })).type, 'ack');
  await lanBrowser.find(frame => frame.type === 'output' && frame.sessionId === sshId && frame.data.includes('LAN SSH FIXTURE'));
  assert.equal((await lanBrowser.rpc('read-history', { sessionId: sshId })).type, 'ack');
  assert.equal((await lanBrowser.rpc('takeover', { sessionId: sshId })).type, 'ack');
  assert.equal((await lanBrowser.rpc('close', { sessionId: sshId })).type, 'ack');
  await lanBrowser.find(frame => frame.type === 'exit' && frame.sessionId === sshId);
  const savedDirectory = "saved directory's literal";
  const edit = await fetch(local + '/api/profiles', { method: 'POST',
    headers: { Origin: local, Cookie: localCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...profile, startupDir: savedDirectory }) });
  assert.equal(edit.status, 200);
  for (const startupDir of [undefined, '-one-time directory']) {
    const opened = await lanBrowser.rpc('create', { profileId: profile.id, startupDir });
    const remoteId = opened.result.id;
    assert.equal(opened.result.startupDir, startupDir ?? savedDirectory);
    await lanBrowser.find(frame => frame.type === 'output' && frame.sessionId === remoteId && frame.data.includes('SSH DIRECTORY FIXTURE'));
    assert.equal((await lanBrowser.rpc('close', { sessionId: remoteId })).type, 'ack');
  }
  assert.match(remoteCommands[0], /saved directory.*literal/);
  assert(remoteCommands[1].includes('./-one-time directory'));

  const { adminToken } = JSON.parse(await readFile(paths.ui, 'utf8'));
  const { agentToken } = JSON.parse(await readFile(paths.connection, 'utf8'));
  for (const [route, token, method] of [
    ['/api/shutdown', adminToken, 'POST'], ['/api/pair-code?target=lan', adminToken, 'POST'],
    ['/agent', agentToken, 'POST'], ['/agent/instance', agentToken, 'GET'],
  ]) assert.equal((await tlsHttp(route, { method, headers: {
    Authorization: `Bearer ${token}`, Cookie: lanCookie, 'X-Forwarded-For': '127.0.0.1',
  } })).status, 404);
  assert.equal(JSON.parse((await cli('status')).stdout).running, true);
  await cli('stop');
  const restarted = JSON.parse((await cli('server')).stdout);
  assert.equal((await tlsHttp('/api/auth', { headers: { Cookie: lanCookie } }, restarted.lan.origin)).status, 204);
  await cli('stop');
  const localOnly = { ...env };
  for (const name of names) delete (localOnly as NodeJS.ProcessEnv)[name];
  assert.equal(JSON.parse((await invoke(localOnly, 'server')).stdout).lan, undefined);
  await assert.rejects(invoke(localOnly, 'pair', '--lan'));
});
