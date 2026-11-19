// Real OpenSSH + PTY shared terminal test. Explicit input ownership; no Shell integration. Localhost only.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import headless from '@xterm/headless';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempPrefix = path.resolve(tmpdir(), 'sst-e2e-');
const temporary = await mkdtemp(tempPrefix);
const env = { ...process.env, SHARED_SSH_PORT: '43128', SHARED_SSH_DATA_DIR: path.join(temporary, 'profile data'), SHARED_SSH_RUNTIME_DIR: path.join(temporary, 'runtime files') };
const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
const identity = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
const identityFile = path.join(temporary, 'test-identity');
await writeFile(identityFile, identity.privateKey, { mode: 0o600 });
if (process.platform === 'win32') {
  const sid = execFileSync('powershell.exe', ['-NoProfile', '-Command', '([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value'], { encoding: 'utf8', windowsHide: true }).trim();
  execFileSync('icacls.exe', [identityFile, '/inheritance:r', '/grant:r', `*${sid}:R`], { windowsHide: true });
}
const parsedIdentity = ssh2.utils.parseKey(identity.privateKey);
const children = new Set(), connections = new Set();
const ssh = new ssh2.Server({ hostKeys: [key.privateKey] }, client => {
  connections.add(client); client.on('close', () => connections.delete(client)); client.on('error', () => {});
  client.on('authentication', ctx => {
    if (ctx.method === 'password' && ctx.username === 'test-user' && ctx.password === 'local-test-password') ctx.accept();
    else if (ctx.method === 'publickey' && ctx.username === 'test-user' && ctx.key.data.equals(parsedIdentity.getPublicSSH()) && (!ctx.signature || parsedIdentity.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) ctx.accept();
    else ctx.reject(['password', 'publickey']);
  });
  client.on('ready', () => client.on('session', accept => {
    const session = accept(); let dimensions = { cols: 100, rows: 30 }, child;
    session.on('pty', (accept, _reject, info) => { dimensions = { cols: info.cols, rows: info.rows }; accept(); });
    session.on('window-change', (accept, _reject, info) => { child?.resize(info.cols, info.rows); accept?.(); });
    session.on('shell', accept => {
      const stream = accept();
      child = pty.spawn('C:\\Program Files\\Git\\bin\\bash.exe', ['--noprofile', '--norc', '-i'], {
        ...dimensions, name: 'xterm-256color', cwd: root,
        env: { ...process.env, TERM: 'xterm-256color', HOME: temporary, HISTFILE: '/dev/null', PS1: 'test-shell> ', PATH: `C:\\Program Files\\Git\\usr\\bin;${process.env.PATH}` }
      });
      children.add(child); child.onData(data => stream.write(data));
      child.onExit(({ exitCode }) => { children.delete(child); stream.exit(exitCode); stream.end(); });
      stream.on('data', data => child.write(data.toString()));
      stream.on('close', () => {
        if (!children.has(child)) return;
        try { child.write('exit\r'); } catch {}
        setTimeout(() => { if (children.has(child)) { try { child.kill(); } catch {} } }, 1000).unref();
      });
    });
  }));
});
await new Promise(resolve => ssh.listen(0, '127.0.0.1', resolve));
const sshPort = ssh.address().port;
let service, ws, client, transport, clientB, transportB, browserTwo;
let stderr = '', output = '', ready = false, ui, agent, clientId;
const states = new Map(), pending = new Map(), perSessionOutput = new Map();
const notifications = [], messageViews = new Map();
async function until(predicate, label, timeout = 15000) {
  const start = Date.now();
  while (!await predicate()) { if (Date.now() - start > timeout) throw new Error(`Timeout: ${label}. ${stderr}\nTerminal: ${output.slice(-1800)}`); await new Promise(r => setTimeout(r, 50)); }
}
function request(type, args = {}) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('WS timeout ' + type)); }, 10000);
    pending.set(requestId, { resolve, reject, timer }); ws.send(JSON.stringify({ type, requestId, ...args }));
  });
}
async function input(id, data) { return request('input', { sessionId: id, data, revision: states.get(id).revision }); }
async function replica(sessionId, cookie) {
  const terminal = new headless.Terminal({ cols: 100, rows: 30, scrollback: 2000, allowProposedApi: true });
  const connection = new WebSocket(agent.url.replace('http:', 'ws:') + '/terminal', { headers: { Origin: agent.url, Cookie: cookie } });
  let queue = Promise.resolve(), synced = false;
  connection.on('message', raw => {
    const p = JSON.parse(raw.toString());
    if (p.type === 'synced') { queue.then(() => { synced = true; }); return; }
    if (p.sessionId !== sessionId) return;
    queue = queue.then(async () => {
      if (p.type === 'snapshot' || p.type === 'reset') {
        terminal.reset(); terminal.resize(p.cols, p.rows);
        await new Promise(resolve => terminal.write(p.data, resolve));
      } else if (p.type === 'resize') terminal.resize(p.cols, p.rows);
      else if (p.type === 'output') await new Promise(resolve => terminal.write(p.data, resolve));
    });
  });
  await until(() => synced, 'terminal replica replay');
  return {
    async text() {
      await queue; const buffer = terminal.buffer.active;
      return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n').trimEnd();
    },
    async close() { await new Promise(resolve => { connection.once('close', resolve); connection.close(); }); terminal.dispose(); },
  };
}
async function call(name, args = {}, expectError = false) {
  return callWith(client, name, args, expectError);
}
async function callWith(caller, name, args = {}, expectError = false) {
  const value = await caller.callTool({ name, arguments: args });
  if (expectError) { assert.equal(value.isError, true); return value; }
  assert(!value.isError, JSON.stringify(value)); return JSON.parse(value.content[0].text);
}
try {
  service = spawn(process.execPath, ['dist/cli.js', 'server'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let serviceOutput = ''; service.stdout.on('data', data => serviceOutput += data); service.stderr.on('data', data => stderr += data);
  await until(() => serviceOutput.includes('"running":true') || service.exitCode !== null, 'service startup');
  assert(serviceOutput.includes('"running":true'), 'isolated service must start through the CLI');
  ui = JSON.parse(await readFile(path.join(env.SHARED_SSH_RUNTIME_DIR, 'ui.json'), 'utf8'));
  agent = JSON.parse(await readFile(path.join(env.SHARED_SSH_RUNTIME_DIR, 'connection.json'), 'utf8'));
  assert.equal(agent.address, '127.0.0.1');
  assert.equal(agent.url, `http://${agent.address}:${agent.port}`);
  const issued = await fetch(agent.url + '/api/pair-code', { method: 'POST', headers: { Authorization: `Bearer ${ui.adminToken}` } });
  assert.equal(issued.status, 200);
  const { code } = await issued.json();
  const redeemed = await fetch(agent.url + '/api/pair', { method: 'POST', headers: { Origin: agent.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(redeemed.status, 204);
  const cookie = redeemed.headers.get('set-cookie').split(';')[0];
  const browserHeaders = { Origin: agent.url, Cookie: cookie };
  const profileHeaders = { ...browserHeaders, 'Content-Type': 'application/json' };
  const create = await fetch(agent.url + '/api/profiles', { method: 'POST', headers: profileHeaders, body: JSON.stringify({ name: '本机 SSH 测试', host: '127.0.0.1', port: sshPort, username: 'test-user', auth: 'password', note: '临时测试' }) });
  assert.equal(create.status, 200); const profile = await create.json();
  // Boundary checks: wrong bearer and unrelated Origin cannot reach either control surface.
  assert.equal((await fetch(agent.url + '/agent', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(agent.url + '/api/state', { headers: { Cookie: cookie, Origin: 'https://unrelated.invalid' } })).status, 403);
  ws = new WebSocket(agent.url.replace('http:', 'ws:') + '/terminal', { headers: browserHeaders });
  ws.on('message', raw => {
    const p = JSON.parse(raw.toString());
    if (p.type === 'hello') clientId = p.clientId;
    if (p.type === 'hello' || p.type === 'synced') for (const s of p.sessions) states.set(s.id, s);
    if (p.type === 'synced') ready = true;
    if (p.type === 'state') states.set(p.session.id, p.session);
    if (p.type === 'output') { output += p.data; perSessionOutput.set(p.sessionId, (perSessionOutput.get(p.sessionId) || '') + p.data); }
    if (p.type === 'messages') messageViews.set(p.sessionId, p.messages);
    if (p.type === 'ack' || p.type === 'error') {
      const item = pending.get(p.requestId); if (!item) return;
      clearTimeout(item.timer); pending.delete(p.requestId);
      p.type === 'ack' ? item.resolve(p.result) : item.reject(new Error(p.error));
    }
  });
  await until(() => ready, 'UI WebSocket ready');
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/mcp.js')], cwd: root, env });
  client = new Client({ name: 'shared-ssh-e2e', version: '1.0.0' }); await client.connect(transport);
  client.setNotificationHandler(LoggingMessageNotificationSchema, notice => { notifications.push(notice.params); });
  const tools = (await client.listTools()).tools.map(t => t.name);
  assert.equal(tools.length, 16); assert(tools.includes('read_history')); assert(tools.includes('read_messages')); assert(tools.includes('acknowledge_messages'));
  assert(tools.includes('handoff_to_user')); assert(tools.includes('request_control_return'));
  for (const obsolete of ['enable_integration', 'execute_command', 'command_status']) assert(!tools.includes(obsolete));
  const html = await (await fetch(agent.url + '/')).text();
  assert(!html.includes('id="share"')); assert(!html.includes('id="integration-status"'));
  const version = await (await fetch(agent.url + '/ui-version')).json();
  assert(html.includes(`content="${version.uiVersion}"`));
  const first = await request('create', { profileId: profile.id }), id = first.id;
  assert.equal(first.privateMode, false); assert.equal(first.lock.kind, 'user');
  assert.deepEqual(await call('list_sessions'), []);
  await call('read_screen', { sessionId: id }, true);
  await request('privacy', { sessionId: id, privateMode: true });
  await call('attach_session', { sessionId: id }, true);
  await until(() => /connecting|fingerprint|password/i.test(output), 'host key prompt');
  if (/continue connecting/i.test(output)) await input(id, 'yes\r');
  await until(() => /password:/i.test(output), 'password prompt'); await input(id, 'local-test-password\r');
  await until(() => output.includes('test-shell>'), 'password login');
  assert((await readFile(path.join(env.SHARED_SSH_DATA_DIR, 'known_hosts'), 'utf8')).includes('ssh-rsa'));
  // Saved credentials use OpenSSH askpass, never terminal typing. A different
  // hostname exercises first-use fingerprint confirmation on the same test SSH.
  const savedResponse = await fetch(agent.url + '/api/profiles', { method: 'POST', headers: profileHeaders, body: JSON.stringify({ name: '保存密码测试', host: 'localhost', port: sshPort, username: 'test-user', auth: 'password', savePassword: true, password: 'local-test-password' }) });
  assert.equal(savedResponse.status, 200); const savedProfile = await savedResponse.json();
  assert(savedProfile.savePassword); assert(!JSON.stringify(savedProfile).includes('local-test-password'));
  const diskProfiles = await readFile(path.join(env.SHARED_SSH_DATA_DIR, 'profiles.json'), 'utf8');
  assert(!diskProfiles.includes('local-test-password')); assert(diskProfiles.includes('encryptedPassword'));
  const visibleProfiles = await call('list_profiles');
  assert(!JSON.stringify(visibleProfiles).includes('encryptedPassword')); assert(!JSON.stringify(visibleProfiles).includes('local-test-password'));
  const savedFirst = await request('create', { profileId: savedProfile.id });
  await until(() => /continue connecting/i.test(perSessionOutput.get(savedFirst.id) || ''), 'saved login still requires first-use host confirmation');
  assert(!(perSessionOutput.get(savedFirst.id) || '').includes('test-shell>'));
  await input(savedFirst.id, 'yes\r');
  await until(() => (perSessionOutput.get(savedFirst.id) || '').includes('test-shell>'), 'saved-password first login');
  assert(!(perSessionOutput.get(savedFirst.id) || '').includes('local-test-password'));
  await request('close', { sessionId: savedFirst.id });
  const savedAgain = await call('create_session', { profileId: savedProfile.id });
  await until(() => (perSessionOutput.get(savedAgain.id) || '').includes('test-shell>'), 'saved-password unattended repeat login');
  assert.equal(states.get(savedAgain.id).lock, null);
  const savedScreen = await call('read_output', { sessionId: savedAgain.id });
  assert(!JSON.stringify(savedScreen).includes('local-test-password'));
  assert(!JSON.stringify(savedScreen).includes('password:'));
  await request('close', { sessionId: savedAgain.id });
  const wrongResponse = await fetch(agent.url + '/api/profiles', { method: 'POST', headers: profileHeaders, body: JSON.stringify({ ...savedProfile, password: 'deliberately-wrong-password' }) });
  assert.equal(wrongResponse.status, 200);
  const wrongSession = await request('create', { profileId: savedProfile.id });
  await until(() => (perSessionOutput.get(wrongSession.id) || '').includes('保存的密码未被接受'), 'wrong saved password asks user instead of typing into the terminal');
  assert(!(perSessionOutput.get(wrongSession.id) || '').includes('deliberately-wrong-password'));
  await input(wrongSession.id, 'local-test-password\r');
  await until(() => (perSessionOutput.get(wrongSession.id) || '').includes('test-shell>'), 'manual retry after saved password failure');
  assert(!(perSessionOutput.get(wrongSession.id) || '').includes('local-test-password'));
  await request('close', { sessionId: wrongSession.id });
  const privateView = await replica(id, cookie);
  assert((await privateView.text()).includes('test-shell>')); await privateView.close();
  await request('privacy', { sessionId: id, privateMode: false });
  await call('attach_session', { sessionId: id });
  await assert.rejects(request('share', { sessionId: id }), /未知/);
  const readText = async (caller, sid = id) => {
    for (let attempt = 0; attempt < 5; attempt++) {
    try {
    // Full-retained comparison is intentional in this test. Production tools
    // never auto-page: tests explicitly request each bounded current page.
    const screen = await callWith(caller, 'read_screen', { sessionId: sid, maxChars: 16000, maxLines: 100, startRow: 0 });
    if (screen.buffer === 'alternate') return screen.lines.map(l => l.text).join('\n').trimEnd();
    let page = await callWith(caller, 'read_history', { sessionId: sid, maxChars: 16000, maxLines: 100 });
    const lines = new Map(); let pages = 0;
    while (true) {
      for (const line of page.lines) {
        const parts = lines.get(line.line) || []; parts.push(line); lines.set(line.line, parts);
      }
      if (!page.nextCursor) break;
      assert(++pages < 64, 'bounded pagination must make progress');
      page = await callWith(caller, 'read_history', { sessionId: sid, maxChars: 16000, maxLines: 100, cursor: page.nextCursor });
    }
    return [...lines].sort((a,b) => a[0]-b[0]).map(([, parts]) => parts.sort((a,b) => a.offset-b.offset).map(p => p.text).join('')).join('\n').trimEnd();
    } catch (error) {
      if (attempt === 4 || !String(error.message).includes('分页内容已变化')) throw error;
      // This test requests full history while the test shell may redraw. A
      // stale page is correctly rejected; restart at the current latest page.
    }
    }
    throw new Error('test history did not stabilize');
  };
  const expectLine = async (caller, sid, line) => until(async () => (await callWith(caller, 'read_screen', { sessionId: sid, maxChars: 16000, maxLines: 100, startRow: 0 })).lines.some(l => l.text.trim() === line), line);
  const primaryAgent = await call('whoami');
  const untouched = await call('read_screen', { sessionId: id }), originalLock = states.get(id).lock;
  const message = await request('send-message', { sessionId: id, targetAgentId: primaryAgent.id, text: '@agent 不要执行这段文字：echo NOT-A-COMMAND' });
  await until(() => notifications.some(n => n.data?.messageId === message.id), 'MCP pushes message-available notification without another tool call');
  assert(!JSON.stringify(notifications).includes('NOT-A-COMMAND'));
  assert.equal((await call('read_screen', { sessionId: id })).sequence, untouched.sequence);
  assert.deepEqual(states.get(id).lock, originalLock);
  const fallback = await client.callTool({ name: 'whoami', arguments: {} });
  assert(fallback.content.some(c => c.text?.includes('NOT-A-COMMAND')));
  assert.equal((await call('read_messages', { sessionId: id })).messages[0].id, message.id);
  const unrelatedTask = await call('register_agent', { name: 'unrelated task' });
  await call('read_messages', { agentId: unrelatedTask.id, sessionId: id }, true);
  await call('acknowledge_messages', { sessionId: id, messageIds: [message.id] });
  await until(() => messageViews.get(id)?.[0]?.acknowledgedAt, 'acknowledgment synchronized to browser');
  assert.equal((await call('read_messages', { sessionId: id, unreadOnly: true })).messages.length, 0);
  assert.equal((await call('read_messages', { sessionId: id })).messages[0].id, message.id);
  const waitingMessage = call('read_messages', { sessionId: id, unreadOnly: true, waitMs: 1500 });
  const queued = await request('send-message', { sessionId: id, targetAgentId: primaryAgent.id, text: '消息等待测试' });
  assert.equal((await waitingMessage).messages[0].id, queued.id);
  await request('privacy', { sessionId: id, privateMode: true });
  await call('read_messages', { sessionId: id }, true);
  await assert.rejects(request('send-message', { sessionId: id, targetAgentId: primaryAgent.id, text: 'private blocked' }), /私密/);
  const privateFallback = await client.callTool({ name: 'whoami', arguments: {} });
  assert(!JSON.stringify(privateFallback).includes('消息等待测试'));
  await request('privacy', { sessionId: id, privateMode: false });
  assert.equal((await call('read_messages', { sessionId: id, unreadOnly: true })).messages[0].id, queued.id);
  await request('clear-messages', { sessionId: id });
  assert.equal((await call('read_messages', { sessionId: id })).messages.length, 0);
  const largeMessages = [];
  for (let n = 0; n < 5; n++) largeMessages.push(await request('send-message', { sessionId: id, targetAgentId: primaryAgent.id, text: 'x'.repeat(1500) + n }));
  const limitedFallback = await client.callTool({ name: 'whoami', arguments: {} });
  const attached = JSON.parse(limitedFallback.content[1].text);
  assert(attached.messages.length <= 2); assert(attached.messages.reduce((n,m) => n + m.text.length, 0) <= 2000); assert(attached.hasMore);
  let messagePage = await call('read_messages', { sessionId: id, unreadOnly: true }); const seenMessages = [];
  while (true) {
    assert(messagePage.returnedChars <= 4000); seenMessages.push(...messagePage.messages.map(m => m.id));
    if (!messagePage.nextCursor) break;
    messagePage = await call('read_messages', { sessionId: id, unreadOnly: true, before: messagePage.nextCursor });
  }
  assert.equal(new Set(seenMessages).size, 5);
  await call('acknowledge_messages', { sessionId: id, messageIds: seenMessages });
  await request('clear-messages', { sessionId: id });
  await input(id, 'printf "USER-READY\\n"\r'); await expectLine(client, id, 'USER-READY');
  assert.equal(states.get(id).lock.kind, 'user');
  await input(id, 'abc\x7f\x7f\x7f'); await new Promise(r => setTimeout(r, 100));
  assert.equal(states.get(id).lock.kind, 'user');
  await input(id, '\x03');
  await until(async () => { const text = await readText(client); return text.includes('^C') && text.trimEnd().endsWith('test-shell>'); }, 'Ctrl+C returned to the actual test Shell prompt');
  const firstControl = await call('take_control', { sessionId: id });
  await call('send_input', { sessionId: id, lease: firstControl.lease, data: 'SST_SHARED_VALUE=manual-shared; printf "AGENT-READY\\n"\r' });
  await expectLine(client, id, 'AGENT-READY');
  assert.equal(states.get(id).lock.kind, 'agent');
  await assert.rejects(input(id, 'x'), /另一方/);
  const handed = await call('handoff_to_user', { sessionId: id, lease: firstControl.lease });
  assert.deepEqual(handed.handoff, { message: null });
  assert.equal(handed.lock, null);
  await until(() => states.get(id).handoff, 'handoff state broadcast');
  assert.deepEqual(states.get(id).handoff, handed.handoff);
  const blocked = await call('take_control', { sessionId: id }, true);
  assert.equal(blocked.structuredContent.code, 'handed_to_user');
  assert.equal(JSON.parse(blocked.content[0].text).code, 'handed_to_user');
  await call('send_input', { sessionId: id, lease: firstControl.lease, data: 'stale' }, true);
  const returnMessage = '请完成当前操作后交回 Agent';
  await call('request_control_return', { sessionId: id, message: returnMessage });
  await until(() => states.get(id).handoff?.message === returnMessage, 'return request state broadcast');
  assert.deepEqual((await call('list_sessions')).find(s => s.id === id).handoff, { message: returnMessage });
  const handoffState = await (await fetch(agent.url + '/api/state', { headers: browserHeaders })).json();
  assert.deepEqual(handoffState.sessions.find(s => s.id === id).handoff, { message: returnMessage });
  const primaryHandler = ws.listeners('message')[0];
  await new Promise(resolve => { ws.once('close', resolve); ws.close(); });
  ready = false; states.delete(id);
  ws = new WebSocket(agent.url.replace('http:', 'ws:') + '/terminal', { headers: browserHeaders });
  ws.on('message', primaryHandler);
  await until(() => ready, 'browser reconnected during handoff');
  assert.deepEqual(states.get(id).handoff, { message: returnMessage });
  assert.equal((await call('take_control', { sessionId: id }, true)).structuredContent.code, 'handed_to_user');
  const beforeManualInput = states.get(id).revision;
  await input(id, 'printf "ENV:%s\\n" "$SST_SHARED_VALUE"\r'); await expectLine(client, id, 'ENV:manual-shared');
  assert.deepEqual(states.get(id).handoff, { message: returnMessage });
  await assert.rejects(request('return-to-agent', { sessionId: id, revision: beforeManualInput }), /状态已变化/);
  await request('return-to-agent', { sessionId: id, revision: states.get(id).revision });
  assert.equal(states.get(id).handoff, null);
  const again = await call('take_control', { sessionId: id });
  await call('handoff_to_user', { sessionId: id, lease: again.lease });
  await until(() => states.get(id).handoff, 'second handoff broadcast');
  await input(id, 'printf "MANUAL-RETURN\\n"\r');
  await expectLine(client, id, 'MANUAL-RETURN');
  await request('release', { sessionId: id });
  assert.equal(states.get(id).handoff, null);
  await input(id, 'for ((i=0;i<600;i++)); do printf "TOKEN-LIMIT-%03d\\n" "$i"; done\r');
  await until(async () => { const v = await call('read_screen', { sessionId: id }); const t = v.lines.map(l => l.text).join('\n'); return t.includes('TOKEN-LIMIT-599') && t.trimEnd().endsWith('test-shell>'); }, 'large output stabilized');
  const latest = await call('read_output', { sessionId: id, resync: true, maxLines: 4, maxChars: 256 });
  assert(latest.lines.map(l => l.text).join('\n').includes('TOKEN-LIMIT-599')); assert(!JSON.stringify(latest).includes('TOKEN-LIMIT-000'));
  assert(latest.returnedChars <= 256); assert(latest.lines.length <= 4);
  assert.equal((await call('read_output', { sessionId: id })).lines.length, 0);
  const readCursorA = (await call('read_history', { sessionId: id, maxLines: 2 })).nextCursor;
  assert(readCursorA);
  const lockBeforeHistory = states.get(id).lock;
  const userHistory = await request('read-history', { sessionId: id, maxChars: 256, maxLines: 4 });
  assert(userHistory.returnedChars <= 256); assert.deepEqual(states.get(id).lock, lockBeforeHistory);
  await request('release', { sessionId: id });
  // No browser is needed to keep the SSH connection, shell state or Agent alive.
  await new Promise(resolve => { ws.once('close', resolve); ws.close(); });
  const offline = await call('take_control', { sessionId: id });
  await call('send_input', { sessionId: id, lease: offline.lease, data: 'printf "OFFLINE:%s\\n" "$SST_SHARED_VALUE"\r' });
  await expectLine(client, id, 'OFFLINE:manual-shared');
  await call('release_control', { sessionId: id, lease: offline.lease });
  const a = await replica(id, cookie), b = await replica(id, cookie);
  try { await new Promise(r => setTimeout(r, 100)); const text = await readText(client); assert.equal(await a.text(), text); assert.equal(await b.text(), text); }
  finally { await a.close(); await b.close(); }
  ready = false; ws = new WebSocket(agent.url.replace('http:', 'ws:') + '/terminal', { headers: browserHeaders });
  ws.on('message', primaryHandler);
  await until(() => ready, 'browser reconnected');
  // Transfer an already-running key-driven application from user to Agent.
  await input(id, 'printf "\\033[?1049hUSER-PROGRAM\\r\\n"; IFS= read -r -s -n 1 KEY; printf "\\033[?1049l\\nUSER-KEY:%s\\n" "$KEY"\r');
  await until(async () => (await call('read_screen', { sessionId: id })).buffer === 'alternate', 'user full-screen program');
  const program = await call('take_control', { sessionId: id });
  await call('send_input', { sessionId: id, lease: program.lease, data: 'q' });
  await expectLine(client, id, 'USER-KEY:q'); assert.equal(states.get(id).lock.kind, 'agent');
  await call('release_control', { sessionId: id, lease: program.lease });
  // Transfer a live program between separate MCP apps using explicit release.
  const running = await call('take_control', { sessionId: id });
  await call('send_input', { sessionId: id, lease: running.lease, data: 'printf "\\033[?1049hAGENT-PROGRAM\\r\\n"; IFS= read -r -s -n 1 KEY; printf "\\033[?1049l\\nAGENT-KEY:%s\\n" "$KEY"\r' });
  await until(async () => (await call('read_screen', { sessionId: id })).buffer === 'alternate', 'Agent full-screen program');
  transportB = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/mcp.js')], cwd: root, env });
  clientB = new Client({ name: 'second-agent-app', version: '1.0.0' }); await clientB.connect(transportB);
  await callWith(clientB, 'attach_session', { sessionId: id }, true);
  await call('release_control', { sessionId: id, lease: running.lease });
  await callWith(clientB, 'attach_session', { sessionId: id });
  const newAgentView = await callWith(clientB, 'read_output', { sessionId: id, maxChars: 256, maxLines: 4 });
  assert(newAgentView.reset); assert.equal(newAgentView.buffer, 'alternate'); assert(!JSON.stringify(newAgentView).includes('TOKEN-LIMIT-000'));
  const normalHistoryWhileRunning = await request('read-history', { sessionId: id, maxChars: 256, maxLines: 4 });
  assert.equal(normalHistoryWhileRunning.buffer, 'normal'); assert.equal(normalHistoryWhileRunning.activeBuffer, 'alternate');
  await callWith(clientB, 'read_history', { sessionId: id, cursor: readCursorA }, true);
  assert.equal((await callWith(clientB, 'read_messages', { sessionId: id })).messages.length, 0);
  await assert.rejects(request('send-message', { sessionId: id, targetAgentId: primaryAgent.id, text: 'stale recipient' }), /关联 Agent 已变化/);
  await call('read_screen', { sessionId: id }, true);
  const bControl = await callWith(clientB, 'take_control', { sessionId: id });
  await callWith(clientB, 'send_input', { sessionId: id, lease: bControl.lease, data: 'q' });
  await expectLine(clientB, id, 'AGENT-KEY:q');
  await callWith(clientB, 'release_control', { sessionId: id, lease: bControl.lease });
  await call('attach_session', { sessionId: id });
  // Key login starts immediately usable, without Shell hooks or initialization.
  const keyResponse = await fetch(agent.url + '/api/profiles', { method: 'POST', headers: profileHeaders, body: JSON.stringify({ name: '本机密钥测试', host: '127.0.0.1', port: sshPort, username: 'test-user', auth: 'key', identityFile, note: '临时密钥' }) });
  const keyProfile = await keyResponse.json();
  const second = await call('create_session', { profileId: keyProfile.id });
  assert.equal(second.lock, null); assert.equal(second.privateMode, false);
  await until(async () => (await call('read_screen', { sessionId: second.id })).lines.some(l => l.text.includes('test-shell>')), 'key login');
  const vim = await call('take_control', { sessionId: second.id });
  await call('send_input', { sessionId: second.id, lease: vim.lease, data: 'VIMFILE=$(mktemp); vim -Nu NONE -n "$VIMFILE"\r' });
  await until(async () => (await call('read_screen', { sessionId: second.id })).buffer === 'alternate', 'real Vim opened without any integration');
  await call('send_input', { sessionId: second.id, lease: vim.lease, data: 'ialpha\rdelete me\rbeta\rneedle\x1bggjddccbeta edited\x1b/needle\r' });
  await until(async () => (await call('read_screen', { sessionId: second.id })).cursorY === 2, 'Vim search cursor');
  await call('send_input', { sessionId: second.id, lease: vim.lease, data: ':wq\r' });
  await until(async () => (await call('read_screen', { sessionId: second.id })).buffer === 'normal', 'Vim saved and exited');
  assert.equal(states.get(second.id).lock.kind, 'agent');
  await call('send_input', { sessionId: second.id, lease: vim.lease, data: 'cat "$VIMFILE"; printf "\\nVIM-DONE\\n"\r' });
  await expectLine(client, second.id, 'VIM-DONE');
  const saved = await readText(client, second.id); assert(saved.includes('alpha\nbeta edited\nneedle')); assert(!saved.includes('__sst'));
  await call('release_control', { sessionId: second.id, lease: vim.lease });
  // Privacy and clearing apply to the exact retained view, independent of lock.
  await request('privacy', { sessionId: id, privateMode: true });
  await call('read_output', { sessionId: id }, true); await call('take_control', { sessionId: id }, true);
  await request('privacy', { sessionId: id, privateMode: false });
  assert((await readText(client)).includes('AGENT-READY'));
  await request('clear-history', { sessionId: id }); assert(!(await readText(client)).includes('AGENT-READY'));
  const cleared = await replica(id, cookie); assert(!(await cleared.text()).includes('AGENT-READY')); await cleared.close();
  // Two task identities within one MCP process remain distinct.
  const taskOne = await call('register_agent', { name: 'task one', project: 'one' });
  const taskTwo = await call('register_agent', { name: 'task two', project: 'two' });
  const third = await call('create_session', { profileId: keyProfile.id, agentId: taskOne.id });
  assert.equal((await call('list_sessions', { agentId: taskOne.id }))[0].id, third.id);
  assert.deepEqual(await call('list_sessions', { agentId: taskTwo.id }), []);
  await request('close', { sessionId: third.id }); await request('close', { sessionId: second.id });
  await assert.rejects(request('dismiss-tab', { sessionId: id }), /先关闭/);
  browserTwo = new WebSocket(agent.url.replace('http:', 'ws:') + '/terminal', { headers: browserHeaders });
  let observerReady = false, observerClosed = false, observerDismissed = false;
  browserTwo.on('message', raw => { const p = JSON.parse(raw.toString());
    if (p.type === 'synced') observerReady = true;
    if (p.type === 'state' && p.session.id === id && p.session.status === 'closed') observerClosed = true;
    if (p.type === 'dismissed' && p.sessionId === id) observerDismissed = true;
  });
  await until(() => observerReady, 'close observer ready');
  await request('close', { sessionId: id }); await until(() => observerClosed, 'close pushed to another page');
  await callWith(clientB, 'attach_session', { sessionId: id });
  const closedView = await replica(id, cookie); assert.equal(await closedView.text(), await readText(clientB)); await closedView.close();
  await callWith(clientB, 'take_control', { sessionId: id }, true);
  await request('privacy', { sessionId: id, privateMode: true }); await callWith(clientB, 'read_screen', { sessionId: id }, true);
  await request('dismiss-tab', { sessionId: id }); await until(() => observerDismissed, 'dismiss pushed to another page');
  await request('dismiss-tab', { sessionId: id });
  assert(!(await call('list_sessions', { scope: 'all' })).some(s => s.id === id));
  console.log('PASS: encrypted saved-password auto-login, fingerprint confirmation, failed-password manual retry with no credential exposure; no Shell integration or injected wrappers; password/key SSH, raw input, explicit locks, real Vim, cross-page replay identical to MCP, privacy and closed-history synchronization.');

} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  await client?.close().catch(() => {}); await transport?.close().catch(() => {});
  await clientB?.close().catch(() => {}); await transportB?.close().catch(() => {});
  ws?.close(); browserTwo?.close();
  for (const child of children) { try { child.write('exit\r'); } catch {} }
  for (let n = 0; n < 20 && children.size; n++) await new Promise(r => setTimeout(r, 50));
  for (const child of children) { try { child.kill(); } catch {} }
  for (const c of connections) c.end(); ssh.close();
  if (service) {
    const cleanup = await new Promise(resolve => {
      execFile(process.execPath, ['dist/cli.js', 'stop'], { cwd: root, env, windowsHide: true, timeout: 10000 }, resolve);
    });
    if (cleanup) { process.exitCode = 1; console.error('Could not confirm the isolated service stopped.'); }
    else {
      const resolved = path.resolve(temporary);
      assert(resolved.startsWith(tempPrefix) && path.dirname(resolved) === path.dirname(tempPrefix));
      await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
}
