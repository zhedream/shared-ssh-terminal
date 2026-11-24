// Native Linux only. Uses real OpenSSH/Unix PTY on an isolated loopback SSH fixture.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ssh2 from 'ssh2';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

assert.equal(process.platform, 'linux', 'Run this fixture on native Linux');
const { spawn } = await import('node-pty');
const address = '127.0.0.1';
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'dist', 'cli.js');
const prefix = path.resolve(tmpdir(), 'sst-linux-e2e-');
const temporary = await mkdtemp(prefix);
const data = path.join(temporary, 'profile data %d ${UNSET_FOR_FIXTURE}');
const runtime = path.join(temporary, 'runtime files');
const env = { ...process.env, SHARED_SSH_DATA_DIR: data, SHARED_SSH_RUNTIME_DIR: runtime, SHARED_SSH_PORT: '43128', LC_ALL: 'C' };
for (const key of Object.keys(env)) if (key.startsWith('SHARED_SSH_LAN_') || key.startsWith('SSH_')) delete env[key];
// A preexisting ASKPASS setting must not intercept manual Linux login.
env.SSH_ASKPASS_REQUIRE = 'force';
env.SSH_ASKPASS = path.join(temporary, 'nonexistent-askpass');

const run = promisify(execFile);
const command = (args, overrides = {}) => run(process.execPath, [cli, ...args], {
  cwd: temporary, env: { ...env, ...overrides }, timeout: 18000,
});
const client = new Client({ name: 'linux-loopback-e2e', version: '1.0.0' });
const browsers = new Set();
const shells = new Set();
const peers = new Set();
let ssh, windowSize, transports = 0;

function rsa() {
  return generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
}
async function until(condition, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(30);
  }
}

async function openBrowser(origin, cookie) {
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/terminal`, { origin, headers: { cookie }, handshakeTimeout: 3000 });
  browsers.add(ws);
  const states = new Map(), received = new Map(), pending = new Map();
  let hello, synced = false, failure;
  const disconnect = error => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
  };
  ws.on('error', disconnect);
  ws.on('close', () => disconnect(new Error('Test browser socket closed')));
  ws.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'hello') hello = message;
    if (message.type === 'state') states.set(message.session.id, message.session);
    if (message.type === 'synced') {
      for (const session of message.sessions) states.set(session.id, session);
      synced = true;
    }
    if (message.type === 'output' || message.type === 'snapshot') {
      const previous = message.type === 'snapshot' ? '' : (received.get(message.sessionId) ?? '');
      received.set(message.sessionId, previous + message.data);
    }
    const request = pending.get(message.requestId);
    if (message.type === 'ack') request?.resolve(message.result);
    if (message.type === 'error') request?.reject(Object.assign(new Error(message.error), { code: message.code }));
  });
  await until(() => { if (failure) throw failure; return synced; }, 'browser synchronization');
  const send = async (type, args) => {
    assert.equal(ws.readyState, WebSocket.OPEN);
    const requestId = randomUUID();
    const request = Promise.withResolvers();
    pending.set(requestId, request);
    const timer = setTimeout(() => request.reject(new Error(`Timed out: ${type}`)), 10000);
    try { ws.send(JSON.stringify({ type, requestId, ...args })); return await request.promise; }
    finally { clearTimeout(timer); pending.delete(requestId); }
  };
  return { hello, send, state: id => states.get(id), text: id => received.get(id) ?? '',
    input: (id, data) => send('input', { sessionId: id, data, revision: states.get(id).revision }),
    close: () => ws.terminate() };
}

async function mcp(name, args = {}, expectError = false) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 16000 });
  if (expectError) { assert.equal(result.isError, true); return result; }
  assert(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

try {
  const hostKey = rsa();
  const identityFile = path.join(temporary, 'fixture private key');
  const identity = rsa();
  await writeFile(identityFile, identity, { mode: 0o600 });
  const publicKey = ssh2.utils.parseKey(identity);
  const savedDirectory = "saved SSH directory's fixture";
  const overrideDirectory = '-one-time SSH directory';
  const missingDirectory = 'missing SSH directory';
  await mkdir(path.join(temporary, savedDirectory));
  await mkdir(path.join(temporary, overrideDirectory));
  const loginShell = path.join(temporary, 'fixture login shell');
  await writeFile(loginShell, '#!/bin/sh\n[ "$1" = -l ] || exit 23\nexec /bin/sh -i\n', { mode: 0o700 });
  const password = `fixture-${randomUUID()}`;
  ssh = new ssh2.Server({ hostKeys: [hostKey] }, peer => {
    transports++;
    peers.add(peer);
    peer.on('error', () => {});
    peer.on('close', () => peers.delete(peer));
    peer.on('authentication', ctx => {
      if (ctx.username === 'fixture' && ctx.method === 'password' && ctx.password === password) ctx.accept();
      else if (ctx.username === 'fixture' && ctx.method === 'publickey' && ctx.key.data.equals(publicKey.getPublicSSH()) &&
               (!ctx.signature || publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) ctx.accept();
      else ctx.reject(['publickey', 'password']);
    });
    peer.on('ready', () => peer.on('session', accept => {
      const session = accept();
      let cols = 100, rows = 30, child;
      session.on('pty', (acceptPty, _reject, info) => { ({ cols, rows } = info); acceptPty(); });
      session.on('window-change', (acceptResize, _reject, info) => {
        child?.resize(info.cols, info.rows);
        windowSize = `${info.rows} ${info.cols}`;
        acceptResize?.();
      });
      const serveShell = (stream, argv) => {
        child = spawn('/bin/sh', argv, { name: 'xterm-256color', cols, rows, cwd: temporary,
          env: { PATH: env.PATH, HOME: temporary, SHELL: loginShell, TERM: 'xterm-256color', ENV: '/dev/null', PS1: 'sst-linux> ' } });
        shells.add(child);
        const stopShell = () => { if (shells.has(child)) child.kill(); };
        stream.on('error', stopShell);
        stream.on('close', stopShell);
        peer.on('close', stopShell);
        child.onData(chunk => { if (!stream.destroyed) stream.write(chunk); });
        stream.on('data', bytes => child.write(String(bytes)));
        child.onExit(({ exitCode }) => { shells.delete(child); if (!stream.destroyed) { stream.exit(exitCode); stream.end(); } });
      };
      session.on('shell', acceptShell => serveShell(acceptShell(), ['-i']));
      session.on('exec', (acceptExec, _reject, info) => serveShell(acceptExec(), ['-c', info.command]));
    }));
  });
  await new Promise((resolve, reject) => {
    ssh.once('error', reject);
    ssh.listen(0, address, resolve);
  });
  const base = { name: 'Linux fixture', host: address, username: 'fixture', port: ssh.address().port, auth: 'password' };
  const legacy = { ...base, id: randomUUID(), savePassword: true };
  const profileFile = path.join(data, 'profiles.json');
  const encryptedPassword = 'fixture-opaque-windows-ciphertext';
  const seeded = JSON.stringify([{ profile: legacy, encryptedPassword }]);
  await mkdir(data, { mode: 0o700 });
  await writeFile(profileFile, seeded, { mode: 0o600 });

  await assert.rejects(command(['server'], { SHARED_SSH_LAN_BIND: '192.0.2.1' }), /本地服务启动失败/);
  assert.match(await readFile(path.join(runtime, 'service.stderr.log'), 'utf8'), /Linux 目前只支持本机回环/);
  assert.equal(JSON.parse((await command(['status'])).stdout).running, false);

  const [startA, startB] = await Promise.all([command(['server']), command(['server'])]);
  const state = JSON.parse(startA.stdout);
  assert.equal(state.running, true);
  assert.equal(state.address, address);
  assert.deepEqual(JSON.parse(startB.stdout), state);
  assert.deepEqual(JSON.parse((await command(['status'])).stdout), state);
  assert.equal((await readFile(path.join(runtime, 'service.stdout.log'), 'utf8')).match(/共享 SSH 终端已启动/g)?.length, 1);
  const issued = new URL((await command(['pair'])).stdout.trim());
  assert.equal(issued.origin, `http://${address}:${state.port}`);
  const paired = await fetch(`${issued.origin}/api/pair`, { method: 'POST', headers: { Origin: issued.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: issued.hash.slice('#pair='.length) }), signal: AbortSignal.timeout(4000) });
  assert.equal(paired.status, 204);
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const a = await openBrowser(issued.origin, cookie);
  const b = await openBrowser(issued.origin, cookie);
  assert.equal(a.hello.instanceId, b.hello.instanceId);
  const capabilities = { savePassword: false, localTerminal: false, localTerminalUnavailableReason: 'platform_not_supported' };
  assert.deepEqual(a.hello.capabilities, capabilities);
  assert.deepEqual(b.hello.capabilities, capabilities);
  const stateResponse = await fetch(`${issued.origin}/api/state`, { headers: { Cookie: cookie } });
  assert.equal(stateResponse.status, 200);
  assert.deepEqual((await stateResponse.json()).capabilities, capabilities);
  const runConfigResponse = await fetch(`${issued.origin}/api/run-configs`, { headers: { Cookie: cookie } });
  assert.equal(runConfigResponse.status, 501);
  assert.equal((await runConfigResponse.json()).code, 'local_terminal_unavailable');
  await assert.rejects(a.send('open-local-shell'), { code: 'local_terminal_unavailable' });

  const save = data => fetch(`${issued.origin}/api/profiles`, { method: 'POST', headers: { Origin: issued.origin, Cookie: cookie,
    'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(4000) });
  const edit = await save({ ...base, id: legacy.id, name: 'edit without credential fields' });
  assert.equal(edit.status, 400);
  assert.match((await edit.json()).error, /Windows 保存的密码.*另建/);
  await assert.rejects(a.send('create', { profileId: legacy.id }), /Windows 保存的密码.*另建/);
  const rejected = await save({ ...base, savePassword: true });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /当前平台不支持保存密码/);
  assert.equal(await readFile(profileFile, 'utf8'), seeded);
  const afterRejection = await openBrowser(issued.origin, cookie);
  assert.deepEqual(afterRejection.hello.profiles, a.hello.profiles);
  afterRejection.close();
  const manual = await save(base);
  const key = await save({ ...base, name: 'Linux key fixture', auth: 'key', identityFile });
  assert.equal(manual.status, 200);
  assert.equal(key.status, 200);
  const manualProfile = await manual.json(), keyProfile = await key.json();
  assert.equal(JSON.parse(await readFile(profileFile, 'utf8'))[0].encryptedPassword, encryptedPassword);

  const session = await a.send('create', { profileId: manualProfile.id });
  await until(() => /continue connecting/i.test(a.text(session.id)), 'first host-key confirmation');
  await a.input(session.id, 'yes\r');
  await until(() => /password:/i.test(a.text(session.id)), 'manual OpenSSH password prompt');
  await a.input(session.id, `${password}\r`);
  await until(() => a.text(session.id).includes('sst-linux> '), 'Unix shell after password login');
  assert(!a.text(session.id).includes(password));
  await a.send('resize', { sessionId: session.id, cols: 112, rows: 34 });
  await until(() => windowSize === '34 112', 'OpenSSH forwards the PTY resize');
  const marker = 'F3-unix-共享';
  await a.input(session.id, 'stty size; printf "F3-%s-%s\\n" unix 共享\r');
  await until(() => [a, b].every(browser => browser.text(session.id).includes('34 112') && browser.text(session.id).includes(marker)),
    'resized PTY and shared browser output');
  const reconnect = await openBrowser(issued.origin, cookie);
  assert.equal(reconnect.hello.instanceId, a.hello.instanceId);
  assert(reconnect.text(session.id).includes(marker));
  reconnect.close();

  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], cwd: temporary, env, stderr: 'ignore' });
  await client.connect(transport, { timeout: 12000 });
  assert.deepEqual(await mcp('get_capabilities'), capabilities);
  assert.equal((await mcp('open_local_shell', {}, true)).structuredContent.code, 'local_terminal_unavailable');
  const attached = await mcp('attach_session', { sessionId: session.id });
  const screen = await mcp('read_screen', { sessionId: session.id });
  assert(screen.lines.some(line => line.text.includes(marker)));
  await until(() => a.state(session.id)?.revision === attached.revision, 'browser sees Agent association');
  await a.input(session.id, 'exit\r');
  await until(() => a.state(session.id)?.status === 'closed' && b.state(session.id)?.status === 'closed', 'Unix process exit broadcasts');

  const knownHosts = path.join(data, 'known_hosts');
  const known = await readFile(knownHosts, 'utf8');
  const hostEntry = `[${address}]:${base.port}`;
  const actualPublic = ssh2.utils.parseKey(hostKey).getPublicSSH().toString('base64');
  assert(known.includes(`${hostEntry} ssh-rsa ${actualPublic}`));
  const wrongPublic = ssh2.utils.parseKey(rsa()).getPublicSSH().toString('base64');
  await writeFile(knownHosts, `${hostEntry} ssh-rsa ${wrongPublic}\n`);
  const refused = await mcp('create_session', { profileId: keyProfile.id });
  await until(() => a.state(refused.id)?.status === 'closed', 'changed host key closes the SSH client');
  await until(() => /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(a.text(refused.id)), 'changed host key refusal');
  await writeFile(knownHosts, known);

  const configured = await save({ ...base, name: 'SSH startup directory fixture', auth: 'key', identityFile, startupDir: savedDirectory });
  assert.equal(configured.status, 200);
  const configuredProfile = await configured.json();
  const checkDirectory = async (target, expected, input) => {
    await until(() => a.text(target.id).includes('sst-linux> '), 'new SSH directory shell');
    await input('printf "LT1/%s\\n" "$PWD"\r');
    await until(() => a.text(target.id).includes(`LT1/${expected}`), 'actual remote startup directory');
    await input('exit\r');
    await until(() => a.state(target.id)?.status === 'closed', 'directory SSH session exits');
  };
  const saved = await a.send('create', { profileId: configuredProfile.id });
  assert.equal(saved.startupDir, savedDirectory);
  await checkDirectory(saved, path.join(temporary, savedDirectory), data => a.input(saved.id, data));

  const overridden = await mcp('create_session', { profileId: configuredProfile.id, startupDir: overrideDirectory });
  assert.equal(overridden.startupDir, overrideDirectory);
  const directoryLease = (await mcp('take_control', { sessionId: overridden.id })).lease;
  await checkDirectory(overridden, path.join(temporary, overrideDirectory), data =>
    mcp('send_input', { sessionId: overridden.id, lease: directoryLease, data }));

  const missing = await b.send('create', { profileId: configuredProfile.id, startupDir: missingDirectory });
  assert.equal(missing.startupDir, missingDirectory);
  await checkDirectory(missing, temporary, data => b.input(missing.id, data));
  assert.match(a.text(missing.id), /启动目录不可用.*登录目录/);

  const beforeRestart = await mcp('create_session', { profileId: keyProfile.id });
  await until(() => a.text(beforeRestart.id).includes('sst-linux> '), 'key login using the accepted fixture fingerprint');
  const seen = transports;
  assert.equal(JSON.parse((await command(['stop'])).stdout).stopped, true);
  await until(() => peers.size === 0 && shells.size === 0, 'authenticated stop closes test SSH and PTYs');
  assert.equal(JSON.parse((await command(['status'])).stdout).running, false);

  const emptyPath = path.join(temporary, 'no ssh here');
  await mkdir(emptyPath);
  await command(['server'], { PATH: emptyPath });
  const changed = await mcp('create_session', { profileId: keyProfile.id }, true);
  assert.equal(changed.structuredContent.code, 'service_instance_changed');
  assert.notEqual(changed.structuredContent.instanceId, a.hello.instanceId);
  assert.deepEqual(await mcp('list_sessions', { scope: 'all' }), []);
  const noSsh = await mcp('create_session', { profileId: keyProfile.id }, true);
  assert.match(noSsh.content[0].text, /找不到可执行的 OpenSSH 客户端 ssh/);
  assert.equal(transports, seen);
  assert.equal(JSON.parse((await command(['stop'])).stdout).stopped, true);

  await command(['server']);
  const notReplayed = await mcp('create_session', { profileId: keyProfile.id }, true);
  assert.equal(notReplayed.structuredContent.code, 'service_instance_changed');
  assert.deepEqual(await mcp('list_sessions', { scope: 'all' }), []);
  assert.match((await mcp('read_screen', { sessionId: beforeRestart.id }, true)).content[0].text, /会话不存在/);
  assert.equal(transports, seen);
  const fresh = await mcp('create_session', { profileId: keyProfile.id });
  assert.notEqual(fresh.id, beforeRestart.id);
  await until(async () => (await mcp('read_screen', { sessionId: fresh.id })).lines.some(line => line.text.includes('sst-linux> ')), 'explicit post-restart key login');
  assert.equal(transports, seen + 1);
  console.log(`PASS Linux ${process.arch} ${process.version}: CLI, pairing, native SSH/PTY, startup directories, platform capabilities, and restart without replay.`);
} finally {
  await client.close().catch(() => {});
  for (const ws of browsers) ws.terminate();
  try {
    await command(['stop']);
    assert.equal(JSON.parse((await command(['status'])).stdout).running, false);
  } finally {
    for (const child of shells) { try { child.kill(); } catch {} }
    for (const peer of peers) peer.end();
    ssh?.close();
  }
  await until(() => shells.size === 0 && peers.size === 0, 'fixture SSH processes and transports closed', 4000);
  const resolved = path.resolve(temporary);
  assert(resolved.startsWith(prefix) && path.dirname(resolved) === path.dirname(prefix));
  await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}
