import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Profiles } from '../src/profiles.js';
import { WindowsSecrets } from '../src/secrets.js';

const config = { name: 'saved-login', host: '127.0.0.1', port: 2222, username: 'test-user', auth: 'password', savePassword: true };
test('saved passwords are encrypted, never returned, retained on edit, and removed when disabled or deleted', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sst-profiles-'));
  const secrets = { protect: async (v: string) => 'protected:' + Buffer.from(v).toString('base64'), unprotect: async (v: string) => Buffer.from(v.slice(10), 'base64').toString() };
  try {
    const profiles = new Profiles(directory, secrets);
    await assert.rejects(profiles.save(config), /请填写/);
    const saved = await profiles.save({ ...config, password: 'test-password-秘密' });
    assert.equal(saved.savePassword, true);
    assert(!JSON.stringify(saved).includes('test-password'));
    assert(!JSON.stringify(profiles.list()).includes('protected:'));
    assert.equal(await profiles.password(saved.id), 'test-password-秘密');
    assert(!(await readFile(path.join(directory, 'profiles.json'), 'utf8')).includes('test-password'));
    const reloaded = new Profiles(directory, secrets); await reloaded.load();
    assert.equal(await reloaded.password(saved.id), 'test-password-秘密');
    await reloaded.save({ ...saved, name: 'renamed', password: '' });
    assert.equal(await reloaded.password(saved.id), 'test-password-秘密');
    await assert.rejects(reloaded.save({ ...saved, host: 'another-host' }), /重新填写/);
    assert.equal(reloaded.get(saved.id).host, config.host);
    await reloaded.save({ ...saved, password: 'replacement' });
    assert.equal(await reloaded.password(saved.id), 'replacement');
    await reloaded.save({ ...saved, savePassword: false });
    assert.equal(reloaded.get(saved.id).savePassword, false);
    assert(!(await readFile(path.join(directory, 'profiles.json'), 'utf8')).includes('protected:'));
    assert.throws(() => reloaded.password(saved.id), /未保存/);
    await reloaded.save({ ...saved, password: 'new' });
    await reloaded.remove(saved.id);
    assert.deepEqual(reloaded.list(), []);
    assert(!(await readFile(path.join(directory, 'profiles.json'), 'utf8')).includes('protected:'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy profiles load without credentials; key authentication discards saved passwords', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sst-profiles-'));
  const secrets = { protect: async () => 'cipher', unprotect: async () => 'secret' };
  try {
    await writeFile(path.join(directory, 'profiles.json'), JSON.stringify([{ name: 'legacy', host: 'localhost', username: 'u', auth: 'password' }]));
    const profiles = new Profiles(directory, secrets); await profiles.load();
    assert.equal(profiles.list()[0].savePassword, false);
    const saved = await profiles.save({ ...config, password: 'secret' });
    await profiles.save({ ...saved, auth: 'agent' });
    assert.equal(profiles.get(saved.id).savePassword, false);
    assert(!(await readFile(path.join(directory, 'profiles.json'), 'utf8')).includes('cipher'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Windows DPAPI encrypts and restores Unicode passwords without plaintext in protected output', { skip: process.platform !== 'win32' }, async () => {
  const protector = new WindowsSecrets();
  const password = '本机测试-"$`&秘密123';
  const cipher = await protector.protect(password);
  assert(!cipher.includes(password));
  assert.equal(await protector.unprotect(cipher), password);
  await assert.rejects(protector.unprotect('not-valid-data'), /无法加密或解密/);
});
