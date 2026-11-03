// Local raw-terminal smoke test. No Shell initialization or completion protocol.
import assert from 'node:assert/strict';
import path from 'node:path';
import * as pty from 'node-pty';
import { Session } from '../dist/sessions.js';
const root = process.cwd(), actor = { id: 'local-test', name: 'local-test', application: 'test' };
async function wait(predicate, label) {
  const start = Date.now(); while (!predicate()) {
    if (Date.now() - start > 12000) throw new Error(`Timeout: ${label}`);
    await new Promise(r => setTimeout(r, 30));
  }
}
for (const shell of ['bash', ...(process.env.SST_TEST_ZSH ? ['zsh'] : [])]) {
  let raw = '';
  const child = pty.spawn('C:\\Program Files\\Git\\bin\\bash.exe', shell === 'bash' ? ['--noprofile', '--norc', '-i'] : ['--noprofile', '--norc', '-c', 'exec "$SST_TEST_ZSH" -f -i'], {
    name: 'xterm-256color', cols: 180, rows: 30, cwd: root,
    env: { ...process.env, SST_TEST_ZSH: process.env.SST_TEST_ZSH?.replaceAll('\\', '/'), HOME: path.join(root, '.runtime/zsh-test'), HISTFILE: '/dev/null', TERM: 'xterm-256color', PATH: 'C:\\Program Files\\Git\\usr\\bin;' + process.env.PATH },
  });
  child.onData(data => raw += data);
  const s = new Session({ id: 'local', name: shell, host: 'localhost', port: 22, username: 'local', auth: 'password', note: '' }, child, 'browser', actor);
  try {
    await wait(() => raw.length > 0, 'initial output');
    const control = s.acceptControl(actor);
    s.agentInput('printf "RAW-TERMINAL-OK\\n"\r', control.lease, actor);
    await wait(() => /RAW-TERMINAL-OK[\r\n]/.test(raw), `${shell} raw command`);
    assert.equal(s.lock?.kind, 'agent');
    s.releaseAgent(control.lease, actor);
    s.userInput('browser', 'abc\x7f\x7f\x7f', s.revision);
    await new Promise(r => setTimeout(r, 150)); assert.equal(s.lock?.owner, 'browser');
    s.userInput('browser', 'printf "USER-TERMINAL-OK\\n"\r', s.revision);
    await wait(() => /USER-TERMINAL-OK[\r\n]/.test(raw), `${shell} user command`);
    assert.equal(s.lock?.owner, 'browser'); s.releaseUser('browser');
    const exit = s.acceptControl(actor); s.agentInput('exit\r', exit.lease, actor);
    await wait(() => s.status === 'closed', 'Shell exited');
    console.log(`PASS ${shell}: raw command, user input, no automatic release, explicit release, normal exit`);
  } catch (e) { console.error(raw.slice(-2000)); throw e; }
  finally { s.close(); }
}

setTimeout(() => process.exit(0), 100).unref();
