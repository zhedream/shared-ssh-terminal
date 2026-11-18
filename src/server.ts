import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { z } from 'zod';
import { Profiles, sshArgs } from './profiles.js';
import { Session } from './sessions.js';
import { readSshConfig } from './ssh-config.js';
import { Agents, type AgentIdentity } from './agents.js';
import { ensureAskpass, SavedPasswordPty } from './saved-password.js';
import { Messages, messagePage } from './messages.js';
import { LOCAL_ADDRESS, listenLocal, localRequestOrigin, writeRuntimeJson } from './local-network.js';
import { loadPairingKey, Pairing, pairingError } from './pairing.js';
import { installRoot as ROOT, servicePaths } from './paths.js';
import { acquireServiceLock, configuredPort, RuntimeError, runtimeErrorMessage, SERVICE_BUSY, SERVICE_NAME } from './service-runtime.js';

const uiVersion = createHash('sha256').update(Buffer.concat(await Promise.all(
  ['public/index.html', 'public/app.js', 'public/app.css'].map(file => readFile(path.join(ROOT, file)))
))).digest('hex').slice(0, 16);
const paths = servicePaths();
const { data: DATA, runtime: RUNTIME } = paths;
let serviceLock: Awaited<ReturnType<typeof acquireServiceLock>>;
let instance: { service: string; runtime: string; pid: number; address: string; port: number } | undefined;
class ServiceBusy extends Error {}
const token = () => randomBytes(32).toString('hex');
const adminToken = token(), agentToken = token();
let pairing: Pairing | undefined;
const profiles = new Profiles(DATA);
const agents = new Agents();
const sessions = new Map<string, Session>();
const messages = new Messages();
messages.setMaxListeners(100);
const sockets = new Set<WebSocket>();
const synchronizing = new Map<WebSocket, unknown[]>();
let shuttingDown = false;
let creating = 0;

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage, limit = 128 * 1024) {
  let value = '';
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    value += chunk.toString();
    if (value.length > limit) {
      req.resume();
      throw new Error('请求过大');
    }
  }
  return JSON.parse(value || '{}');
}
function auth(req: IncomingMessage, secret: string) {
  const authorization = req.headersDistinct.authorization;
  if (authorization?.length !== 1) return false;
  const provided = Buffer.from(authorization[0]);
  const expected = Buffer.from(`Bearer ${secret}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
function localManagement(req: IncomingMessage) {
  return req.socket.localAddress === LOCAL_ADDRESS && req.socket.remoteAddress === LOCAL_ADDRESS && req.headers.origin === undefined;
}
function empty(res: ServerResponse) {
  res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
}
function send(ws: WebSocket, value: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, '输出积压，请重新连接'); return; }
  ws.send(JSON.stringify(value));
}
function broadcast(value: unknown) {
  for (const ws of sockets) send(ws, value);
  for (const [ws, pending] of synchronizing) {
    if (pending.length > 10000) { ws.close(1013, '同步输出过多，请重新连接'); synchronizing.delete(ws); }
    else pending.push(value);
  }
}
function session(id: string) { const s = sessions.get(id); if (!s) throw new Error('会话不存在'); return s; }
async function createSession(profileId: string, owner: string, creator?: AgentIdentity) {
  if (shuttingDown) throw new Error('服务正在停止');
  if (creating + [...sessions.values()].filter(s => s.status === 'open').length >= 16) throw new Error('最多同时打开 16 个连接');
  creating++;
  let saved: SavedPasswordPty | undefined;
  try {
    const profile = profiles.get(profileId);
    const args = sshArgs(profile);
    // OpenSSH parses the value of -o as config text, even when argv is already
    // separated. Quote the path so a directory name can contain spaces.
    const knownHosts = path.join(DATA, 'known_hosts').split(path.sep).join('/').replaceAll('"', '\\"');
    args.splice(args.length - 2, 0, '-o', `UserKnownHostsFile="${knownHosts}"`);
    let askpassEnv = {};
    let workingDirectory = ROOT;
    if (profile.savePassword) {
      // Snapshot the credential before any await can let a profile edit change
      // the endpoint/credential pairing underneath this connection.
      const password = await profiles.password(profile.id);
      const helper = await ensureAskpass(ROOT, RUNTIME);
      saved = new SavedPasswordPty(profile, password);
      // Keep the helper path relative to the inherited working directory so its
      // argument stays ASCII. OpenSSH must not search PATH for a bare filename.
      workingDirectory = path.dirname(helper);
      askpassEnv = { ...await saved.listen(), SSH_ASKPASS: `.\\${path.basename(helper)}`, SSH_ASKPASS_REQUIRE: 'force' };
    }
    if (shuttingDown) throw new Error('服务正在停止');
    let child;
    try { child = pty.spawn('ssh.exe', args, {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: workingDirectory,
      env: { ...globalThis.process.env, TERM: 'xterm-256color', ...askpassEnv }
    }); } catch (error) { saved?.dispose(); throw error; }
    saved?.bind(child);
    const s = new Session(profile, saved ?? child, owner, creator);
    sessions.set(s.id, s);
    s.on('state', state => { messages.changed(); broadcast({ type: 'state', session: state }); });
    s.on('output', output => broadcast({ type: 'output', sessionId: s.id, ...output }));
    s.on('reset', reset => broadcast({ type: 'reset', sessionId: s.id, ...reset }));
    s.on('resize', size => broadcast({ type: 'resize', sessionId: s.id, ...size }));
    s.on('exit', exitCode => broadcast({ type: 'exit', sessionId: s.id, exitCode }));
    broadcast({ type: 'state', session: s.summary() });
    return s;
    } catch (error) { saved?.dispose(); throw error; }
  finally { creating--; }
}

async function waitChange(s: Session, waitMs: number, predicate: () => boolean) {
  if (!waitMs || s.privateMode || s.status === 'closed' || predicate()) return;
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); s.off('public-output', check); s.off('state', check); resolve(); };
    const check = () => { if (s.privateMode || s.status === 'closed' || predicate()) finish(); };
    const timer = setTimeout(finish, Math.min(waitMs, 15000));
    s.on('public-output', check); s.on('state', check);
    check();
  });
}

const readLimits = {
  maxChars: z.number().int().min(128).max(16000).optional(),
  maxLines: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
};
const agentRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list_profiles') }),
  z.object({ action: z.literal('whoami') }),
  z.object({ action: z.literal('list_sessions'), scope: z.enum(['mine', 'all']).default('mine') }),
  z.object({ action: z.literal('create_session'), profileId: z.string().uuid() }),
  z.object({ action: z.literal('attach_session'), sessionId: z.string().uuid() }),
  z.object({ action: z.literal('take_control'), sessionId: z.string().uuid() }),
  z.object({ action: z.literal('release_control'), sessionId: z.string().uuid(), lease: z.string().uuid() }),
  z.object({ action: z.literal('read_output'), sessionId: z.string().uuid(), ...readLimits, resync: z.boolean().optional(), after: z.number().int().min(0).optional(), waitMs: z.number().int().min(0).max(15000).default(0) }),
  z.object({ action: z.literal('read_screen'), sessionId: z.string().uuid(), ...readLimits, startRow: z.number().int().min(0).max(159).optional() }),
  z.object({ action: z.literal('read_history'), sessionId: z.string().uuid(), ...readLimits }),
  z.object({ action: z.literal('send_input'), sessionId: z.string().uuid(), lease: z.string().uuid(), data: z.string().max(16000) }),
  z.object({ action: z.literal('read_messages'), sessionId: z.string().uuid(), unreadOnly: z.boolean().default(false), waitMs: z.number().int().min(0).max(15000).default(0), maxMessages: z.number().int().min(1).max(20).default(5), maxChars: z.number().int().min(2000).max(16000).default(4000), before: z.string().uuid().optional() }),
  z.object({ action: z.literal('acknowledge_messages'), sessionId: z.string().uuid(), messageIds: z.array(z.string().uuid()).min(1).max(100) }),
  z.object({ action: z.literal('watch_messages'), after: z.number().int().min(0).default(0), waitMs: z.number().int().min(0).max(15000).default(0) }),
]);

function visibleMessages(actor: AgentIdentity, sessionId?: string, unreadOnly = false) {
  return messages.read(actor.id, id => { const s = sessions.get(id); return !!s && !s.privateMode && s.assignedTo?.id === actor.id; }, sessionId, unreadOnly);
}
function pendingMessages(actor: AgentIdentity, sessionId?: string) { return visibleMessages(actor, sessionId, true); }

async function agent(value: unknown, actor: AgentIdentity) {
  const p = agentRequest.parse(value);
  if (p.action === 'watch_messages') {
    await messages.wait(p.after, p.waitMs);
    return { revision: messages.revision, ...messagePage(pendingMessages(actor), 2, 2000) };
  }
  if (p.action === 'whoami') return actor;
  if (p.action === 'list_profiles') return profiles.list();
  if (p.action === 'list_sessions') return [...sessions.values()].filter(s => p.scope === 'all' || s.assignedTo?.id === actor.id).map(s => s.summary(actor.id));
  if (p.action === 'create_session') return (await createSession(p.profileId, 'pending-user', actor)).summary(actor.id);
  const s = session(p.sessionId);
  if (p.action === 'attach_session') { s.attach(actor); return s.summary(actor.id); }
  s.requireAssignee(actor);
  if (p.action === 'read_messages' || p.action === 'acknowledge_messages') {
    if (s.privateMode) throw new Error('私密模式已开启，Agent 无权读取或确认消息');
    if (p.action === 'acknowledge_messages') {
      messages.acknowledge(actor.id, s.id, p.messageIds);
      broadcast({ type: 'messages', sessionId: s.id, messages: messages.list(s.id) });
      return { acknowledged: p.messageIds };
    }
    const deadline = Date.now() + p.waitMs;
    while (!visibleMessages(actor, s.id, p.unreadOnly).length && Date.now() < deadline) {
      await messages.wait(messages.revision, deadline - Date.now());
      s.requireAssignee(actor);
      if (s.privateMode) throw new Error('私密模式已开启，Agent 无权读取消息');
    }
    return { ...messagePage(visibleMessages(actor, s.id), p.maxMessages, p.maxChars, p.before, p.unreadOnly), instruction: '从最新消息向前分页。阅读后调用 acknowledge_messages 确认收到；确认不等于执行完成。已确认消息保留到用户清空。' };
  }
  if (p.action === 'take_control') return s.acceptControl(actor);
  if (p.action === 'release_control') { s.releaseAgent(p.lease, actor); return s.summary(actor.id); }
  if (p.action === 'read_screen' || p.action === 'read_history' || p.action === 'read_output') {
    if (s.privateMode) throw new Error('私密模式已开启，Agent 无权观察或输入');
    const owner = 'agent:' + actor.id;
    if (p.action === 'read_output' && !p.cursor && !p.resync) {
      const after = p.after ?? s.lastReadSequence(owner);
      if (after !== undefined) await waitChange(s, p.waitMs, () => s.sequence > after);
    }
    const result = await s.observe(owner, p.action === 'read_output' ? 'changes' : p.action === 'read_screen' ? 'screen' : 'history', p);
    s.requireAssignee(actor); return { ...result, sessionId: s.id };
  }
  if (p.action === 'send_input') { s.agentInput(p.data, p.lease, actor); return { ok: true }; }

}

const require = createRequire(import.meta.url);
const assets: Record<string, [string, string]> = {
  '/': [path.join(ROOT, 'public/index.html'), 'text/html; charset=utf-8'],
  '/app.js': [path.join(ROOT, 'public/app.js'), 'text/javascript; charset=utf-8'],
  '/app.css': [path.join(ROOT, 'public/app.css'), 'text/css; charset=utf-8'],
  '/vendor/xterm.js': [require.resolve('@xterm/xterm'), 'text/javascript'],
  '/vendor/xterm.css': [require.resolve('@xterm/xterm/css/xterm.css'), 'text/css'],
  '/vendor/fit.js': [require.resolve('@xterm/addon-fit'), 'text/javascript']
};

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const origin = localRequestOrigin(req);
    if (!origin) return json(res, 403, { error: '来源不被允许' });
    const route = new URL(req.url ?? '/', origin).pathname;
    if (route === '/ui-version' && req.method === 'GET') return json(res, 200, { uiVersion });
    if (route === '/agent/instance' && req.method === 'GET') {
      if (!localManagement(req) || !auth(req, agentToken)) return json(res, 401, { error: 'MCP 认证失败' });
      return instance && !shuttingDown ? json(res, 200, instance) : json(res, 503, { error: '本机服务未就绪' });
    }
    if (route === '/agent' && req.method === 'POST') {
      if (!localManagement(req) || !auth(req, agentToken)) return json(res, 401, { error: 'MCP 认证失败' });
      const value = await body(req);
      if (value.action === 'register_agent') return json(res, 200, agents.register({ identity: value.identity, secret: value.secret }));
      const actor = agents.authenticate(String(req.headers['x-agent-id'] ?? ''), String(req.headers['x-agent-token'] ?? ''));
      const result = await agent(value, actor);
      res.setHeader('X-Shared-Ssh-Unread-Count', String(pendingMessages(actor).length));
      return json(res, 200, result);
    }
    if (route.startsWith('/api/')) {
      if (route === '/api/pair-code' || route === '/api/shutdown') {
        if (!localManagement(req) || !auth(req, adminToken)) return json(res, 401, { error: '本机管理认证失败' });
        if (req.method !== 'POST') return json(res, 405, { error: '请求方法不被允许' });
        if (shuttingDown) return json(res, 503, { error: '服务正在停止' });
        if (route === '/api/shutdown') {
          json(res, 200, { ok: true }); setTimeout(() => void shutdown(), 50); return;
        }
        const code = pairing?.issue();
        if (!code) return json(res, 429, { error: '未使用的配对码过多，请稍后再试。' });
        return json(res, 200, { code });
      }
      if (!['GET', 'HEAD'].includes(req.method ?? '') && !localRequestOrigin(req, true)) {
        return json(res, 403, { error: '来源不被允许' });
      }
      const hostname = new URL(origin).hostname;
      if (route === '/api/pair' && req.method === 'POST') {
        if (!pairing?.allowAttempt()) {
          res.setHeader('Retry-After', '60');
          return json(res, 429, { error: '配对请求过多，请稍后重试。' });
        }
        let code: unknown;
        try { code = (await body(req, 1024))?.code; }
        catch { return json(res, 400, { error: pairingError }); }
        const cookie = pairing.redeem(code, hostname);
        if (!cookie) return json(res, 400, { error: pairingError });
        res.setHeader('Set-Cookie', cookie);
        return empty(res);
      }
      if (!pairing?.expiresAt(req.headers.cookie, hostname)) return json(res, 401, { error: '请先配对浏览器。' });
      if (route === '/api/auth' && req.method === 'GET') return empty(res);
      if (route === '/api/state' && req.method === 'GET') return json(res, 200, { profiles: profiles.list(), sessions: [...sessions.values()].map(s => s.summary()) });
      if (route === '/api/ssh-config' && req.method === 'GET') return json(res, 200, await readSshConfig());
      if (route === '/api/profiles' && req.method === 'POST') {
        const profile = await profiles.save(await body(req));
        broadcast({ type: 'profiles', profiles: profiles.list() }); return json(res, 200, profile);
      }
      if (route.startsWith('/api/profiles/') && req.method === 'DELETE') {
        await profiles.remove(z.string().uuid().parse(route.split('/').at(-1)));
        broadcast({ type: 'profiles', profiles: profiles.list() }); return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: '接口不存在' });
    }
    if (req.method !== 'GET' || !assets[route]) return json(res, 404, { error: '页面不存在' });
    const [file, contentType] = assets[route];
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    const content = await readFile(file);
    res.end(route === '/' ? content.toString('utf8').replaceAll('__SST_UI_VERSION__', uiVersion) : content);
  } catch (e: any) { if (!res.headersSent) json(res, 400, { error: e.message ?? '操作失败' }); else res.end(); }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const origin = localRequestOrigin(req, true);
  if (!origin || req.url !== '/terminal') { socket.destroy(); return; }
  const expiry = pairing?.expiresAt(req.headers.cookie, new URL(origin).hostname);
  if (!expiry) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, ws => attachBrowser(ws, expiry));
});
function attachBrowser(ws: WebSocket, expiry: number) {
  const clientId = randomUUID();
  const timeout = setTimeout(() => ws.close(1008, '配对已过期'), Math.max(0, expiry - Date.now()));
  let queue = syncBrowser(ws, clientId).catch(() => { ws.close(1011, '同步失败'); });
  ws.on('message', raw => {
    queue = queue.then(async () => {
      let requestId: string | undefined;
      try {
        const p = JSON.parse(raw.toString());
        requestId = p.requestId;
        if (ws.readyState !== WebSocket.OPEN || Date.now() >= expiry) return;
        if (typeof requestId !== 'string') throw new Error('请求缺少标识');
        let result: unknown = { ok: true };
        if (p.type === 'create') result = (await createSession(z.string().uuid().parse(p.profileId), clientId)).summary();
        else if (p.type === 'dismiss-tab') {
          const id = z.string().uuid().parse(p.sessionId), s = sessions.get(id);
          if (s?.status === 'open') throw new Error('请先关闭 SSH 连接，再移除页签');
          sessions.delete(id); messages.clear(id);
          broadcast({ type: 'dismissed', sessionId: id });
        }
        else {
          const s = session(z.string().uuid().parse(p.sessionId));
          if (p.type === 'input') s.userInput(clientId, z.string().max(16000).parse(p.data), z.number().int().parse(p.revision));
          else if (p.type === 'terminal-reply') s.terminalReply(z.string().max(256).parse(p.data));
          else if (p.type === 'takeover') s.takeover(clientId);
          else if (p.type === 'return-to-user') s.returnToUser(clientId);
          else if (p.type === 'private') s.setPrivate(clientId);
          else if (p.type === 'privacy') s.setPrivacy(z.boolean().parse(p.privateMode));
          else if (p.type === 'release') s.releaseUser(clientId);
          else if (p.type === 'read-history') {
            const options = z.object(readLimits).parse({ maxChars: p.maxChars, maxLines: p.maxLines, cursor: p.cursor });
            result = await s.observe('user:' + clientId, 'history', options, false);
          }
          else if (p.type === 'send-message') {
            if (s.privateMode) throw new Error('请先关闭私密再向关联 Agent 发送消息');
            if (!s.assignedTo) throw new Error('当前会话尚未关联 Agent，请先提供 sessionId 让 Agent 认领');
            if (z.string().uuid().parse(p.targetAgentId) !== s.assignedTo.id) throw new Error('关联 Agent 已变化，请确认接收者后重新发送');
            result = messages.send(s.id, s.assignedTo, z.string().trim().min(1).max(2000).parse(p.text));
            broadcast({ type: 'messages', sessionId: s.id, messages: messages.list(s.id) });
          }
          else if (p.type === 'clear-messages') { messages.clear(s.id); broadcast({ type: 'messages', sessionId: s.id, messages: [] }); }
          else if (p.type === 'clear-history') { await s.clearHistory(); messages.clear(s.id); broadcast({ type: 'messages', sessionId: s.id, messages: [] }); }
          else if (p.type === 'resize') s.resize(z.number().int().min(20).max(400).parse(p.cols), z.number().int().min(5).max(160).parse(p.rows));
          else if (p.type === 'close') s.close();
          else throw new Error('未知终端操作');
        }
        send(ws, { type: 'ack', requestId, result });
      } catch (e: any) { send(ws, { type: 'error', requestId, error: e.message ?? '操作失败' }); }
    }).catch(() => ws.close(1011, '会话错误'));
  });
  ws.on('error', () => {});
  ws.on('close', () => { clearTimeout(timeout); sockets.delete(ws); synchronizing.delete(ws); });
}

async function syncBrowser(ws: WebSocket, clientId: string) {
  const pending: any[] = [];
  synchronizing.set(ws, pending);
  try {
    send(ws, { type: 'hello', uiVersion, clientId, profiles: profiles.list(), sessions: [...sessions.values()].map(s => s.summary()) });
    const boundaries = new Map<string, number>();
    for (const s of sessions.values()) {
      const snapshot = await s.snapshot();
      boundaries.set(s.id, snapshot.sequence);
      send(ws, { type: 'snapshot', sessionId: s.id, ...snapshot });
      send(ws, { type: 'messages', sessionId: s.id, messages: messages.list(s.id) });
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    for (const event of pending) {
      if (!['output', 'reset', 'resize'].includes(event.type) || event.uiSeq > (boundaries.get(event.sessionId) ?? -1)) send(ws, event);
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    sockets.add(ws);
    send(ws, { type: 'synced', sessions: [...sessions.values()].map(s => s.summary()) });
  } finally { synchronizing.delete(ws); }
}

async function main() {
  const requestedPort = configuredPort();
  serviceLock = await acquireServiceLock(paths);
  if (!serviceLock) throw new ServiceBusy();
  let uiPublished = false;
  try {
    await mkdir(DATA, { recursive: true, mode: 0o700 });
    try { await profiles.load(); }
    catch { throw new RuntimeError('无法加载本机服务器配置。请检查配置文件格式和目录权限，修复后重试。'); }
    try { pairing = new Pairing(await loadPairingKey(paths.pairingKey), serviceLock.id); }
    catch { throw new RuntimeError('无法加载配对签名密钥。请检查运行目录的 pairing-key.json。'); }
    const { address, port } = await listenLocal(server, requestedPort);
    const url = `http://${address}:${port}`;
    instance = { service: SERVICE_NAME, runtime: serviceLock.id, pid: process.pid, address, port };
    await writeRuntimeJson(paths.ui, { adminToken });
    uiPublished = true;
    await writeRuntimeJson(paths.connection, { url, agentToken, pid: process.pid, address, port });
    console.log(`共享 SSH 终端已启动 (${address}:${port})`);
  } catch (error) {
    server.close();
    if (uiPublished) await unlink(paths.ui).catch(() => {});
    await serviceLock.release().catch(() => {});
    throw error;
  }
}
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  try { await startup; } catch { return; }
  for (const s of sessions.values()) s.close();
  for (const ws of wss.clients) ws.close(1001, '服务停止');
  server.close(); wss.close();
  await Promise.all([paths.connection, paths.ui].map(file => unlink(file).catch(() => {})));
  await serviceLock?.release().catch(() => {});
  setTimeout(() => process.exit(0), 500).unref();
}
const startup = main();
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
startup.catch(error => {
  if (error instanceof ServiceBusy) process.exitCode = SERVICE_BUSY;
  else { console.error(runtimeErrorMessage(error)); process.exitCode = 1; }
});
