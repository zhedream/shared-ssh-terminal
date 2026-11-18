import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { Pairing } from '../src/pairing.js';
import { installRoot, servicePaths } from '../src/paths.js';

const run = promisify(execFile);

test('pairing codes and signed cookies expire at their deadlines', () => {
  let now = 1_800_000_000_000;
  const time = () => now;
  const key = randomBytes(32);
  const pairing = new Pairing(key, 'a'.repeat(64), time);
  const expired = pairing.issue();
  now += 300_000;
  assert.equal(pairing.redeem(expired, 'localhost'), undefined);
  const browserCookie = pairing.redeem(pairing.issue(), 'localhost')!.split(';')[0];
  const expiry = now + 7 * 86400_000;
  assert.equal(pairing.expiresAt(browserCookie, 'localhost'), expiry);
  assert.equal(pairing.expiresAt(browserCookie, '127.0.0.1'), undefined);
  assert.equal(new Pairing(randomBytes(32), 'a'.repeat(64), time).expiresAt(browserCookie, 'localhost'), undefined);
  assert.equal(new Pairing(key, 'b'.repeat(64), time).expiresAt(browserCookie, 'localhost'), undefined);
  assert.equal(pairing.expiresAt(`${browserCookie}; ${browserCookie}`, 'localhost'), undefined);
  now = expiry;
  assert.equal(pairing.expiresAt(browserCookie, 'localhost'), undefined);
  for (let i = 0; i < 60; i++) assert(pairing.allowAttempt());
  assert.equal(pairing.allowAttempt(), false);
  now += 60_000;
  assert(pairing.allowAttempt());
});

async function fixture(t: TestContext) {
  const prefix = path.resolve(tmpdir(), 'sst-pairing-');
  const directory = await mkdtemp(prefix);
  const env = {
    ...process.env, SHARED_SSH_PORT: '43128',
    SHARED_SSH_DATA_DIR: path.join(directory, 'data'),
    SHARED_SSH_RUNTIME_DIR: path.join(directory, 'runtime'),
  };
  const paths = servicePaths(env);
  const cli = (command: string) => run(process.execPath, ['--import', 'tsx', 'src/cli.ts', command], {
    cwd: installRoot, env, windowsHide: true, timeout: 16000,
  });
  t.after(async () => {
    await cli('stop');
    const resolved = path.resolve(directory);
    assert(resolved.startsWith(prefix) && path.dirname(resolved) === path.dirname(prefix));
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  });
  return { paths, cli };
}

function redeem(origin: string, body: string, expectedOrigin = origin) {
  return fetch(origin + '/api/pair', {
    method: 'POST', headers: { Origin: expectedOrigin, 'Content-Type': 'application/json' }, body,
    signal: AbortSignal.timeout(4000),
  });
}

test('CLI pairing, concurrent redemption, management isolation and cookie reuse after restart', { timeout: 40000 }, async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  const link = new URL((await a.cli('pair')).stdout.trim());
  assert.equal(link.hostname, '127.0.0.1');
  assert(/^#pair=[A-Za-z0-9_-]{43}$/.test(link.hash));
  const origin = link.origin;
  const code = link.hash.slice('#pair='.length);
  const requestBody = JSON.stringify({ code });
  const check = (url: string, cookie?: string) => fetch(url + '/api/auth', { headers: cookie ? { cookie } : {} });
  assert.equal((await check(origin)).status, 401);
  assert.equal((await redeem(origin, requestBody, 'http://localhost:' + link.port)).status, 403);
  const malformed = await redeem(origin, '{secret-looking');
  assert.equal(malformed.status, 400);
  const error = await malformed.json();
  assert.match(error.error, /shared-ssh-terminal pair/);
  assert.equal((await (await redeem(origin, '{}')).json()).error, error.error);
  assert.equal((await (await redeem(origin, JSON.stringify({ code: 'invalid' }))).json()).error, error.error);
  assert.equal((await (await redeem(origin, JSON.stringify({ code: 'x'.repeat(2048) }))).json()).error, error.error);

  const responses = await Promise.all([redeem(origin, requestBody), redeem(origin, requestBody)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [204, 400]);
  const header = responses.find(response => response.status === 204)!.headers.get('set-cookie')!;
  assert(header.includes('; HttpOnly; SameSite=Strict; Path=/; Max-Age='));
  assert(!/;\s*(?:Domain=|Secure\b)/i.test(header));
  const cookie = header.split(';')[0];
  assert.equal((await check(origin, cookie)).status, 204);
  assert.equal((await check(origin, cookie.slice(0, -1) + (cookie.endsWith('0') ? '1' : '0'))).status, 401);
  assert.equal((await fetch(origin + '/api/profiles', { method: 'POST', headers: { cookie }, body: '{}' })).status, 403);
  for (const route of ['/api/shutdown', '/api/pair-code', '/agent']) {
    assert.equal((await fetch(origin + route, { method: 'POST', headers: { cookie } })).status, 401);
  }
  const { adminToken } = JSON.parse(await readFile(a.paths.ui, 'utf8'));
  assert.equal((await fetch(origin + '/api/pair-code', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${adminToken}` } })).status, 401);
  const log = (await readFile(a.paths.stdout, 'utf8')) + (await readFile(a.paths.stderr, 'utf8'));
  assert(!log.includes(code) && !log.includes(cookie) && !log.includes(adminToken));

  const other = new URL((await b.cli('pair')).stdout.trim());
  assert.notEqual(other.port, link.port);
  assert.equal((await check(other.origin, cookie)).status, 401);
  const second = await redeem(other.origin, JSON.stringify({ code: other.hash.slice('#pair='.length) }));
  assert.equal(second.status, 204);
  const secondCookie = second.headers.get('set-cookie')!.split(';')[0];
  assert(secondCookie.split('=')[0] !== cookie.split('=')[0]);
  assert.equal((await check(other.origin, cookie + '; ' + secondCookie)).status, 204);

  await a.cli('stop');
  const reserved = createServer();
  reserved.listen(Number(link.port), link.hostname);
  await once(reserved, 'listening');
  let restarted;
  try { restarted = JSON.parse((await a.cli('server')).stdout); }
  finally { await new Promise<void>(resolve => reserved.close(() => resolve())); }
  assert.notEqual(String(restarted.port), link.port);
  const restartedOrigin = `http://${restarted.address}:${restarted.port}`;
  assert.equal((await check(restartedOrigin, cookie)).status, 204);
  const invalid = await Promise.all(Array.from({ length: 60 }, () => redeem(restartedOrigin, '{}')));
  assert(invalid.every(response => response.status === 400));
  const limited = await redeem(restartedOrigin, '{}');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});
