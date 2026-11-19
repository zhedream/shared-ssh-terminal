import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Profiles, sshArgs } from '../src/profiles.js';
import { WindowsSecrets } from '../src/secrets.js';
import { hostKeyOptions, resolveLinuxSsh, sshPlatform } from '../src/ssh-platform.js';

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
    const { savePassword: _savePassword, ...withoutCredentialFields } = saved;
    const retained = await reloaded.save({ ...withoutCredentialFields, name: 'credential fields omitted' });
    assert.equal(retained.savePassword, true);
    assert.equal(await reloaded.password(saved.id), 'test-password-秘密');
    await assert.rejects(reloaded.save({ ...withoutCredentialFields, auth: 'agent' }), /请明确关闭保存密码/);
    assert.deepEqual(reloaded.get(saved.id), retained);
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

test('a platform without saved passwords rejects edits that omit credential fields and preserves existing ciphertext', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sst-profiles-'));
  const file = path.join(directory, 'profiles.json');
  const { savePassword, ...manual } = config;
  const legacy = { ...manual, id: randomUUID(), savePassword };
  const encryptedPassword = 'fixture-ciphertext';
  const serialized = JSON.stringify([{ profile: legacy, encryptedPassword }]);
  try {
    await writeFile(file, serialized);
    const profiles = new Profiles(directory, null);
    await profiles.load();
    const before = profiles.list();
    const edit = { ...manual, id: legacy.id, name: 'edited without credential fields' };
    await assert.rejects(profiles.save(edit), /Windows 保存的密码.*另建/);
    await assert.rejects(profiles.save({ ...edit, savePassword: false }), /Windows 保存的密码.*另建/);
    assert.throws(() => profiles.password(legacy.id), /Windows 保存的密码.*另建/);
    await assert.rejects(profiles.save({ ...manual, savePassword: true }), /当前平台不支持保存密码/);
    await assert.rejects(profiles.save({ ...manual, password: 'fictional-password' }), /当前平台不支持保存密码/);
    assert.deepEqual(profiles.list(), before);
    assert.equal(await readFile(file, 'utf8'), serialized);
    const fresh = await profiles.save(manual);
    assert.equal(fresh.savePassword, false);
    const updated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(updated[0].encryptedPassword, encryptedPassword);
    assert.equal(updated[1].encryptedPassword, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('platform SSH uses explicit argv and a private Linux known_hosts in its working directory', async () => {
  const profile = { ...config, auth: 'password' as const, savePassword: false, id: randomUUID(), note: '' };
  const windows = sshPlatform('win32');
  const linux = sshPlatform('linux');
  assert.equal(windows.executable, 'ssh.exe');
  assert.equal(linux.executable, 'ssh');
  assert.deepEqual(sshArgs(profile, windows.configFile, hostKeyOptions('win32', 'C:\\data with spaces')).slice(-4),
    ['-o', 'UserKnownHostsFile="C:/data with spaces/known_hosts"', '--', profile.host]);
  const linuxArgs = sshArgs(profile, linux.configFile, hostKeyOptions('linux', '/absolute/data with spaces %d'));
  assert.deepEqual(linuxArgs.slice(0, 3), ['-F', '/dev/null', '-tt']);
  assert.deepEqual(linuxArgs.slice(-6), ['-o', 'UserKnownHostsFile=./known_hosts', '-o', 'GlobalKnownHostsFile=/dev/null', '--', profile.host]);
  assert(linuxArgs.includes('StrictHostKeyChecking=ask'));
  assert.throws(() => sshPlatform('darwin'), /目前支持 Windows 和 Linux/);
  await assert.rejects(resolveLinuxSsh(':.:local-bin'), /找不到可执行的 OpenSSH/);
});
