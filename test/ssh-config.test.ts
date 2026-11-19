import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseConfig, words } from '../src/ssh-config.js';

const fixture = 'Host prod alias\n HostName 192.168.1.10\n User user\n Port 2222\n IdentityFile "~/.ssh/key file"\n IdentityFile second-key\nHost *\n User fallback\n';
for (const [style, home, key] of [
  ['Windows', 'C:\\Users\\tester', 'C:\\Users\\tester\\.ssh\\key file'],
  ['POSIX', '/home/tester', '/home/tester/.ssh/key file'],
]) {
  test(`config expands a ${style} home and imports only the first identity`, () => {
    const result = parseConfig(fixture, home);
    assert.equal(result.length, 2); assert.equal(result[0].profile.host, '192.168.1.10');
    assert.equal(result[0].profile.username, 'user'); assert.equal(result[0].profile.port, 2222);
    assert.equal(result[0].profile.identityFile, key);
    assert.equal(result[0].valid, path.isAbsolute(key));
    assert(result[0].notes.some(n => n.includes('第一个')));
    if (style === 'Windows') {
      assert.deepEqual(words('IdentityFile "C:\\Users\\name\\key" #comment'), ['IdentityFile', 'C:\\Users\\name\\key']);
    }
  });
}
test('wildcards and negations apply defaults but do not become connection records', () => {
  const result = parseConfig('Host web-* !web-test\n User deploy\nHost web-prod web-test\n HostName 10.1.1.1\nHost *\n User fallback');
  assert.equal(result.length, 2); assert.equal(result[0].profile.username, 'deploy'); assert.equal(result[1].profile.username, 'fallback');
});
test('Match exec is never run or evaluated; unsupported proxy settings are noted', () => {
  const result = parseConfig('Host prod\n HostName 10.0.0.2\n User app\n ProxyCommand do-not-execute\nMatch exec "do-not-execute"\n User root\n');
  assert.equal(result[0].profile.username, 'app'); assert(result[0].notes.some(n => n.includes('Match'))); assert(result[0].notes.some(n => n.includes('跳板')));
});
