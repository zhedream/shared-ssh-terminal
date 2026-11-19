import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HandedToUserError, Session, type Pty } from '../src/sessions.js';
import { sshArgs, profileSchema, type Profile } from '../src/profiles.js';
import type { AgentIdentity } from '../src/agents.js';

class FakePty extends EventEmitter implements Pty {
  writes: string[] = [];
  write(s: string) { this.writes.push(s); }
  resize() {}
  kill() { this.emit('exit', { exitCode: 0 }); }
  onData(fn: (s: string) => void) { this.on('data', fn); }
  onExit(fn: (s: { exitCode: number }) => void) { this.on('exit', fn); }
}
const profile: Profile = { id: '9af7f0fa-470b-4cb3-9eeb-3960cbf83426', name: 'test', host: '127.0.0.1', port: 22, username: 'user', auth: 'password', note: '' };
const agentA: AgentIdentity = { id: 'e75da59d-2615-42c5-83f8-cda380154348', name: 'Codex A', application: 'Codex', project: 'project-a' };
const agentB: AgentIdentity = { ...agentA, id: '53a40cb1-303b-4222-b773-20677723d750', name: 'Cursor B' };
function fixture(creator?: AgentIdentity) {
  const pty = new FakePty(), s = new Session(profile, pty, 'browser', creator);
  return { s, pty };
}

test('creation injects nothing; user session starts owned and Agent session starts free', () => {
  const a = fixture(), b = fixture(agentA);
  assert.deepEqual(a.pty.writes, []); assert.deepEqual(b.pty.writes, []);
  assert.equal(a.s.privateMode, false); assert.equal(b.s.privateMode, false);
  assert.equal(a.s.assignedTo, null); assert.equal(a.s.lock?.owner, 'browser');
  assert.equal(b.s.assignedTo?.id, agentA.id); assert.equal(b.s.lock, null);
  for (const field of ['integration', 'integrationStatus', 'atPrompt', 'shell', 'handoffReady']) assert(!(field in b.s.summary()));
  a.s.close(); b.s.close();
});

test('Agent sends exact input with no Shell initialization, command wrapping or Shell restriction', () => {
  const { s, pty } = fixture(agentA); const control = s.acceptControl(agentA);
  s.agentInput('vim /tmp/demo.txt\r', control.lease, agentA);
  s.agentInput('ihello\x1b:wq\r', control.lease, agentA);
  assert.deepEqual(pty.writes, ['vim /tmp/demo.txt\r', 'ihello\x1b:wq\r']); s.close();
});

test('prompt text, backspace to empty, old OSC markers and silence never release input', async () => {
  const { s, pty } = fixture(); s.attach(agentA);
  s.userInput('browser', 'abc\x7f\x7f\x7f', s.revision);
  pty.emit('data', 'root@test:~# \x1b]777;sst;old;ready;0;root;/\x07');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(s.lock?.owner, 'browser');
  s.releaseUser('browser'); const control = s.acceptControl(agentA);
  s.agentInput('true\r', control.lease, agentA); pty.emit('data', 'root@test:~# ');
  await s.screen(); assert.equal(s.lock?.kind, 'agent');
  s.releaseAgent(control.lease, agentA); assert.equal(s.lock, null); s.close();
});

test('only the actual holder can release; user takeover revokes stale Agent leases', () => {
  const { s } = fixture(agentA); const first = s.acceptControl(agentA);
  assert.throws(() => s.acceptControl(agentA), /占用/);
  assert.throws(() => s.releaseUser('browser'), /未持有/);
  assert.throws(() => s.userInput('browser', 'x', s.revision), /另一方/);
  s.takeover('browser'); assert.throws(() => s.agentInput('x', first.lease, agentA), /失效/);
  assert.throws(() => s.releaseAgent(first.lease, agentA), /失效/);
  assert.throws(() => s.releaseUser('second-page'), /未持有/);
  s.releaseUser('browser'); const next = s.acceptControl(agentA);
  assert.notEqual(next.lease, first.lease); s.releaseAgent(next.lease, agentA); s.close();
});

test('running full-screen program survives user and Agent handoffs with no injected input', async () => {
  const { s, pty } = fixture(agentA); const first = s.acceptControl(agentA);
  s.agentInput('top\r', first.lease, agentA); pty.emit('data', '\x1b[?1049hRUNNING'); await s.screen();
  const writes = pty.writes.length;
  s.takeover('browser'); s.attach(agentB); s.releaseUser('browser');
  const next = s.acceptControl(agentB); assert.equal(pty.writes.length, writes);
  assert.equal((await s.screen()).buffer, 'alternate');
  assert.throws(() => s.agentInput('q', first.lease, agentA), /未交接/);
  s.agentInput('q', next.lease, agentB); pty.emit('data', '\x1b[?1049l');
  assert.equal(s.lock?.owner, agentB.id); s.releaseAgent(next.lease, agentB); s.close();
});

test('privacy is independent of input and history; users may release while private', async () => {
  const { s, pty } = fixture(); s.attach(agentA); pty.emit('data', 'VISIBLE'); const lock = s.lock;
  s.setPrivacy(true); assert.equal(s.lock, lock);
  await assert.rejects(s.read(), /私密/); await assert.rejects(s.screen(), /私密/);
  assert((await s.snapshot()).data.includes('VISIBLE'));
  s.releaseUser('browser'); assert.throws(() => s.acceptControl(agentA), /私密/);
  s.setPrivacy(false); assert((await s.read()).chunks[0].data.includes('VISIBLE'));
  const control = s.acceptControl(agentA); s.setPrivacy(true);
  assert.throws(() => s.agentInput('x', control.lease, agentA), /私密/);
  s.releaseAgent(control.lease, agentA); s.close();
});

test('Agent association is separate from input ownership and creation source', () => {
  const { s } = fixture(); s.attach(agentA); assert.equal(s.lock?.owner, 'browser');
  s.attach(agentB); assert.equal(s.createdBy.kind, 'user'); assert.equal(s.assignedTo?.id, agentB.id);
  assert.throws(() => s.requireAssignee(agentA), /未交接/);
  s.releaseUser('browser'); const control = s.acceptControl(agentB);
  assert(!JSON.stringify(s.summary()).includes(control.lease));
  assert.throws(() => s.attach(agentA), /另一 Agent/);
  s.returnToUser('browser'); assert.equal(s.assignedTo, null); assert.equal(s.lock?.owner, 'browser'); s.close();
});

test('user partial input is observed from the same terminal while another page cannot write', async () => {
  const { s, pty } = fixture(); s.attach(agentA);
  s.userInput('browser', 'pending', s.revision); pty.emit('data', 'pending');
  assert((await s.screen()).text.startsWith('pending'));
  assert.throws(() => s.userInput('second-page', 'x', s.revision), /另一方/);
  const revision = s.revision;
  const next = s.acceptControl(agentA);
  assert.throws(() => s.userInput('browser', 'old page', revision), /状态已变化/);
  assert.throws(() => s.userInput('browser', 'current page', s.revision), /另一方/);
  assert.deepEqual(pty.writes, ['pending']);
  s.releaseAgent(next.lease, agentA); s.close();
});

test('resize completion publishes the new screen and revision before immediate browser input', async t => {
  const { s, pty } = fixture();
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const write = s.terminal.write.bind(s.terminal);
  t.mock.method(s.terminal, 'write', (...args: Parameters<typeof write>) => {
    started.resolve();
    void resume.promise.then(() => write(...args));
  });
  const events: string[] = [];
  let publishedRevision: number | undefined;
  s.on('output', () => events.push('output'));
  s.on('resize', ({ cols, rows, uiSeq }) => {
    assert.deepEqual([s.terminal.cols, s.terminal.rows, cols, rows, uiSeq], [112, 34, 112, 34, 2]);
    events.push('resize');
  });
  s.once('state', state => { publishedRevision = state.revision; events.push('state'); });
  pty.emit('data', 'earlier output');
  await started.promise;
  const previousRevision = s.revision;
  const nextInput = Promise.resolve(s.resize(112, 34)).then(() => {
    assert.deepEqual(events, ['output', 'resize', 'state']);
    assert.equal(publishedRevision, previousRevision + 1);
    assert.throws(() => s.userInput('browser', 'stale', previousRevision), /状态已变化/);
    assert.throws(() => s.userInput('other-page', 'bad owner', publishedRevision!), /另一方/);
    s.userInput('browser', 'immediate', publishedRevision!);
  });
  resume.resolve();
  await nextInput;
  assert.deepEqual(pty.writes, ['immediate']);
  assert.equal((await s.snapshot()).sequence, 2);
  s.close();
});

test('manual handoff protects an idle or user-owned terminal until explicit return', () => {
  const { s, pty } = fixture(agentA);
  const first = s.acceptControl(agentA);
  assert.throws(() => s.requestControlReturn(agentA, 'no handoff'), /未处于/);
  assert.throws(() => s.handoffToUser(first.lease, agentB), /未交接/);
  assert.throws(() => s.handoffToUser('wrong', agentA), /已失效/);
  s.handoffToUser(first.lease, agentA);
  assert.equal(s.lock, null);
  assert.throws(() => s.handoffToUser(first.lease, agentA), /失效/);
  assert.throws(() => s.agentInput('stale', first.lease, agentA), /失效/);
  assert.throws(() => s.acceptControl(agentA), HandedToUserError);
  s.requestControlReturn(agentA, 'first');
  s.requestControlReturn(agentA, 'latest');
  assert.deepEqual(s.summary().handoff, { message: 'latest' });
  assert.deepEqual(s.summary(agentB.id).handoff, { message: null });
  assert.deepEqual(pty.writes, []);
  const oldRevision = s.revision;
  s.userInput('browser', 'manual', oldRevision);
  assert.throws(() => s.returnToAgent('browser', oldRevision), /状态已变化/);
  assert.throws(() => s.returnToAgent('other-page', s.revision), /持有输入权/);
  assert.throws(() => s.releaseUser('other-page'), /未持有/);
  s.takeover('browser');
  assert.throws(() => s.acceptControl(agentA), HandedToUserError);
  s.returnToAgent('browser', s.revision);
  assert.equal(s.summary().handoff, null);
  assert.equal(s.lock, null);
  assert.throws(() => s.returnToAgent('browser', s.revision), /没有可交回/);
  const second = s.acceptControl(agentA);
  assert.notEqual(second.lease, first.lease);
  assert.equal(s.status, 'open');
});

test('handoff survives privacy and association changes and clears on release or exit', () => {
  const { s } = fixture(agentA);
  s.handoffToUser(s.acceptControl(agentA).lease, agentA);
  s.requestControlReturn(agentA, 'for A');
  s.attach(agentA);
  assert.deepEqual(s.summary().handoff, { message: 'for A' });
  s.setPrivacy(true);
  assert.throws(() => s.acceptControl(agentA), /私密/);
  assert.throws(() => s.requestControlReturn(agentA, 'hidden'), /私密/);
  assert.deepEqual(s.summary(agentA.id).handoff, { message: null });
  s.returnToAgent('browser', s.revision);
  assert.throws(() => s.acceptControl(agentA), /私密/);
  s.setPrivacy(false);
  s.handoffToUser(s.acceptControl(agentA).lease, agentA);
  s.requestControlReturn(agentA, 'for A');
  s.attach(agentB);
  assert.deepEqual(s.summary().handoff, { message: null });
  assert.throws(() => s.acceptControl(agentB), HandedToUserError);
  assert.throws(() => s.requestControlReturn(agentA, 'wrong'), /未交接/);
  s.requestControlReturn(agentB, 'for B');
  s.returnToUser('browser');
  assert.deepEqual(s.summary().handoff, { message: null });
  assert.throws(() => s.returnToAgent('browser', s.revision), /没有可交回/);
  s.setPrivacy(true);
  s.releaseUser('browser');
  assert.equal(s.summary().handoff, null);
  assert.equal(s.privateMode, true);
  s.setPrivacy(false);
  s.attach(agentB);
  s.handoffToUser(s.acceptControl(agentB).lease, agentB);
  s.userInput('browser', 'continue', s.revision);
  s.close();
  assert.equal(s.summary().handoff, null);
  assert.equal(s.lock, null);
  assert.throws(() => s.requestControlReturn(agentB, 'closed'), /已关闭/);
});

test('retained view tracks overwrites and never exposes a hidden raw output log', async () => {
  const { s, pty } = fixture(); pty.emit('data', 'OLD\rNEW');
  const view = await s.read(); assert(view.chunks[0].data.includes('NEW')); assert(!view.chunks[0].data.includes('OLD'));
  assert.equal(view.mode, 'terminal_snapshot'); assert.deepEqual((await s.read(view.sequence)).chunks, []); s.close();
});

test('clear all erases normal and alternate history without changing input lock or writing to the server', async () => {
  const { s, pty } = fixture(); pty.emit('data', 'NORMAL-SECRET\r\n\x1b[?1049hALT-SECRET');
  const before = await s.read(), lock = s.lock; await s.clearHistory();
  assert.equal(s.lock, lock); assert.deepEqual(pty.writes, []);
  assert(!(await s.snapshot()).data.includes('SECRET'));
  assert(!JSON.stringify(await s.read(before.sequence)).includes('SECRET'));
  assert.equal((await s.screen()).buffer, 'alternate');
  pty.emit('data', '\x1b[?1049l'); assert(!JSON.stringify(await s.read()).includes('NORMAL-SECRET')); s.close();
});

test('pending reads cannot return old content after a concurrent global clear', async () => {
  const { s, pty } = fixture(); pty.emit('data', 'SECRET'); const read = s.read();
  await s.clearHistory(); assert(!JSON.stringify(await read).includes('SECRET')); s.close();
});

test('native scrollback erase and scrollback eviction apply equally to Agent reads', async () => {
  const { s, pty } = fixture(); pty.emit('data', 'SECRET\r\n'); await s.read();
  pty.emit('data', '\x1b[2J\x1b[3J\x1b[HSAFE'); assert(!JSON.stringify(await s.read()).includes('SECRET'));
  pty.emit('data', '\r\nEVICT-ME\r\n' + Array.from({ length: 2100 }, (_, i) => `line-${i}\r\n`).join(''));
  assert(!JSON.stringify(await s.read()).includes('EVICT-ME')); s.close();
});

test('closed retained history permits explicit read-only association, still enforces privacy and forbids input', async () => {
  const { s, pty } = fixture(); pty.emit('data', 'RETAINED'); s.close(); s.attach(agentA);
  assert((await s.read()).chunks[0].data.includes('RETAINED'));
  assert((await s.snapshot()).data.includes('RETAINED'));
  assert.throws(() => s.acceptControl(agentA), /已关闭/);
  assert.throws(() => s.agentInput('x', 'stale', agentA), /已关闭/);
  assert.throws(() => s.userInput('browser', 'x', s.revision), /已关闭/);
  s.setPrivacy(true); await assert.rejects(s.read(), /私密/); assert.throws(() => s.attach(agentB), /私密/);
  await s.clearHistory(); s.setPrivacy(false); assert(!JSON.stringify(await s.read()).includes('RETAINED'));
});

test('same-host sessions are independent and SSH exit releases only that session lock', () => {
  const a = fixture(agentA), b = fixture(agentA); a.s.acceptControl(agentA); b.s.acceptControl(agentA);
  assert.notEqual(a.s.id, b.s.id); a.s.close(); assert.equal(a.s.lock, null); assert.equal(b.s.lock?.kind, 'agent'); b.s.close();
});

test('SSH arguments exclude passwords and reject injected options', () => {
  const args = sshArgs(profile); assert.equal(args.at(-1), '127.0.0.1'); assert.equal(args.at(-2), '--');
  assert(!profileSchema.safeParse({ ...profile, host: '-oProxyCommand=evil' }).success);
  assert(!profileSchema.safeParse({ ...profile, password: 'not-stored' }).success);
  assert(!profileSchema.safeParse({ ...profile, auth: 'key', identityFile: 'relative-key' }).success);
});
