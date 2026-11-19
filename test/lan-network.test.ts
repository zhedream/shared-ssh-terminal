import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { loadLanConfiguration, type LanDiscovery } from '../src/lan-network.js';
import { installRoot, servicePaths } from '../src/paths.js';

const run = promisify(execFile);
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const names = ['BIND', 'PORT', 'HOST', 'CERT', 'KEY'].map(key => 'SHARED_SSH_LAN_' + key);

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

test('two listeners share browser state and keep LAN pairing, TLS and administration separate', { timeout: 50000 }, async t => {
  const interfaces = Object.values(networkInterfaces()).flatMap(value => value ?? []);
  const address = interfaces.find(item => item.family === 'IPv4' && !item.internal &&
    /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(item.address))?.address;
  if (!address) { t.skip('No private IPv4 interface for the isolated TLS test'); return; }
  const prefix = path.resolve(tmpdir(), 'sst-lan-');
  const directory = await mkdtemp(prefix);
  const env = { ...process.env, SHARED_SSH_DATA_DIR: path.join(directory, 'data'), SHARED_SSH_RUNTIME_DIR: path.join(directory, 'runtime'),
    SHARED_SSH_PORT: '43128', SHARED_SSH_LAN_BIND: address, SHARED_SSH_LAN_HOST: address,
    SHARED_SSH_LAN_PORT: '443', SHARED_SSH_LAN_CERT: 'cert.pem', SHARED_SSH_LAN_KEY: 'key.pem' };
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

  const reserved = createServer();
  reserved.listen(0, address);
  await once(reserved, 'listening');
  t.after(() => new Promise<void>(resolve => reserved.close(() => resolve())));
  const blocked = reserved.address();
  assert(blocked && typeof blocked !== 'string');
  env.SHARED_SSH_LAN_PORT = String(blocked.port);
  const first = JSON.parse((await cli('server')).stdout) as { address: string; port: number; lan: LanDiscovery };
  assert.equal(first.address, '127.0.0.1');
  assert.equal(first.lan.address === address, true);
  assert.notEqual(first.lan.port, blocked.port);
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
  const created = await fetch(local + '/api/profiles', { method: 'POST', headers: { Cookie: localCookie, Origin: local, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Shared LAN fixture', host: '127.0.0.1', username: 'fixture', auth: 'password', port: 22 }) });
  assert.equal(created.status, 200);
  const synced = ws({ Origin: first.lan.origin, Cookie: lanCookie });
  try {
    const hello = JSON.parse((await once(synced, 'message'))[0].toString());
    assert.equal(hello.type, 'hello');
    assert.equal(hello.profiles[0].name, 'Shared LAN fixture');
  } finally { synced.terminate(); }
  const crossOrigin = ws({ Origin: local, Cookie: lanCookie });
  try { await assert.rejects(once(crossOrigin, 'open'), /socket hang up/); } finally { crossOrigin.terminate(); }

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
