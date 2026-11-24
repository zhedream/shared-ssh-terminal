import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { Profiles, sshArgs, sshStartupDirectory } from './profiles.js';
import { HandedToUserError, LocalSession, Session, type Pty } from './sessions.js';
import { LocalTerminalError, spawnLocalTerminal, supportsLocalTerminal, type LocalLaunch } from './local-terminal.js';
import { openLocalInput, RunConfigs, startRunSchema } from './run-configs.js';
import { readSshConfig } from './ssh-config.js';
import { hostKeyOptions, resolveLinuxSsh, sshPlatform } from './ssh-platform.js';
import { Agents, type AgentIdentity } from './agents.js';
import { ensureAskpass, SavedPasswordPty } from './saved-password.js';
import { Messages, messagePage } from './messages.js';
import { LOCAL_ADDRESS, listenLocal, listenOn, localRequestOrigin, writeRuntimeJson } from './local-network.js';
import { lanOrigin, lanRequestOrigin, loadLanConfiguration, type LanDiscovery } from './lan-network.js';
import { lanPairingError, loadPairingKey, Pairing, pairingError } from './pairing.js';
import { installRoot as ROOT, servicePaths } from './paths.js';
import { acquireServiceLock, configuredPort, RuntimeError, runtimeErrorMessage, SERVICE_BUSY, SERVICE_NAME } from './service-runtime.js';

const uiVersion = createHash('sha256').update(Buffer.concat(await Promise.all(
  ['public/index.html', 'public/app.js', 'public/app.css'].map(file => readFile(path.join(ROOT, file)))
))).digest('hex').slice(0, 16);
const paths = servicePaths();
const { data: DATA, runtime: RUNTIME } = paths;
const instanceId = randomUUID();
let serviceLock: Awaited<ReturnType<typeof acquireServiceLock>>;
let instance: { service: string; runtime: string; pid: number; address: string; port: number; instanceId: string; lan?: LanDiscovery } | undefined;
let lanServer: https.Server | undefined;
let platform: ReturnType<typeof sshPlatform>;
let pty: typeof import('node-pty');
class ServiceBusy extends Error {}
const token = () => randomBytes(32).toString('hex');
const adminToken = token(), agentToken = token();
let pairing: Pairing | undefined;
const profiles = new Profiles(DATA);
const runConfigs = new RunConfigs(DATA);
const agents = new Agents();
const sessions = new Map<string, Session>();
const messages = new Messages();
messages.setMaxListeners(100);
const sockets = new Map<WebSocket, boolean>();
const synchronizing = new Map<WebSocket, { local: boolean; pending: unknown[] }>();
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
function actualLoopback(req: IncomingMessage) {
  return req.socket.localAddress === LOCAL_ADDRESS && req.socket.remoteAddress === LOCAL_ADDRESS;
}
function localManagement(req: IncomingMessage) {
  return actualLoopback(req) && req.headers.origin === undefined;
}
function localBrowserAccess(req: IncomingMessage, secure: boolean) {
  return !secure && actualLoopback(req);
}
function capabilities(local: boolean) {
  const reason = local ? supportsLocalTerminal() ? undefined : 'platform_not_supported' : 'loopback_only';
  return { savePassword: platform.savePassword, localTerminal: reason === undefined, localTerminalUnavailableReason: reason };
}
function requireLocal(local: boolean) {
  if (!local) throw new LocalTerminalError('local_terminal_unavailable', '本地终端仅允许已配对的本机回环浏览器访问。');
  if (!supportsLocalTerminal()) throw new LocalTerminalError('local_terminal_unavailable', '本地终端需要支持 ConPTY 的 Windows。');
}
function empty(res: ServerResponse) {
  res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
}
function send(ws: WebSocket, value: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, '输出积压，请重新连接'); return; }
  ws.send(JSON.stringify(value));
}
function broadcast(value: unknown, localOnly = false) {
  for (const [ws, local] of sockets) if (local || !localOnly) send(ws, value);
  for (const [ws, { local, pending }] of synchronizing) {
    if (localOnly && !local) continue;
    if (pending.length > 10000) { ws.close(1013, '同步输出过多，请重新连接'); synchronizing.delete(ws); }
    else pending.push(value);
  }
}
function visibleSessions(local: boolean) {
  return [...sessions.values()].filter(s => local || s.kind === 'ssh');
}
function visibleSession(id: string, local: boolean) {
  const s = sessions.get(id);
  return s && (local || s.kind === 'ssh') ? s : undefined;
}
function session(id: string, local = true) {
  const s = visibleSession(id, local);
  if (!s) throw new LocalTerminalError('session_not_found', '会话不存在');
  return s;
}
function registerSession(s: Session) {
  sessions.set(s.id, s);
  const publish = (event: unknown) => {
    if (sessions.get(s.id) === s) broadcast(event, s.kind === 'local');
  };
  s.on('state', state => { messages.changed(); publish({ type: 'state', session: state }); });
  s.on('output', output => publish({ type: 'output', sessionId: s.id, ...output }));
  s.on('reset', reset => publish({ type: 'reset', sessionId: s.id, ...reset }));
  s.on('resize', size => publish({ type: 'resize', sessionId: s.id, ...size }));
  s.on('exit', exitCode => publish({ type: 'exit', sessionId: s.id, exitCode, generation: s.processGeneration }));
  publish({ type: 'state', session: s.summary() });
}
function dismissSession(s: Session) {
  sessions.delete(s.id); messages.clear(s.id);
  broadcast({ type: 'dismissed', sessionId: s.id }, s.kind === 'local');
}
function localSession(s: Session) {
  if (!(s instanceof LocalSession)) throw new LocalTerminalError('lifecycle_conflict', '此操作仅用于本地终端。');
  return s;
}
function launchLocal(s: LocalSession) {
  return (bind: (pty: Pty) => void, signal: AbortSignal) => spawnLocalTerminal(pty.spawn, RUNTIME, s.launch, s.cols, s.rows, bind, signal);
}
function concurrentLocal(key: string | undefined, exclude?: LocalSession) {
  if (!key) return;
  return [...sessions.values()].find((s): s is LocalSession =>
    s instanceof LocalSession && s !== exclude && s.deduplicationKey === key && s.occupied);
}
async function startLocal(launch: LocalLaunch, owner: string, creator?: AgentIdentity, explicitKey?: string) {
  if (shuttingDown) throw new Error('服务正在停止');
  const key = launch.runConfigId ? 'config:' + launch.runConfigId
    : explicitKey === undefined ? undefined : JSON.stringify([creator ? 'agent' : 'browser', creator?.id ?? owner, explicitKey]);
  const signature = JSON.stringify(launch);
  const previous = concurrentLocal(key);
  if (previous) {
    if (!launch.runConfigId && previous.signature !== signature) throw new LocalTerminalError('start_conflict', '此启动标识已用于其他启动参数。');
    await previous.waitForStart();
    return { sessionId: previous.id, reused: true };
  }
  if ([...sessions.values()].filter(s => s instanceof LocalSession && s.occupied).length >= 16) throw new Error('最多同时打开 16 个本地终端');
  const s = new LocalSession(launch, key, signature, owner, creator);
  registerSession(s);
  try { await s.start(launchLocal(s)); }
  catch (error) { dismissSession(s); throw error; }
  return { sessionId: s.id, reused: false };
}
function openLocal(value: unknown, owner: string, actor?: AgentIdentity) {
  const { cwd, startKey } = z.object(openLocalInput).parse(value);
  return startLocal({ kind: 'local', name: 'PowerShell', cwd: cwd ?? homedir() }, owner, actor, startKey);
}
function startRun(value: unknown, owner: string, actor?: AgentIdentity) {
  const input = startRunSchema.parse(value);
  if (input.configId) {
    const { id: runConfigId, name, cwd, command } = runConfigs.get(input.configId);
    return startLocal({ kind: 'local', runConfigId, name, cwd, command }, owner, actor);
  }
  return startLocal({ kind: 'local', name: input.name ?? '本地命令', cwd: input.cwd!, command: input.command! }, owner, actor, input.startKey);
}
async function restartLocal(s: LocalSession, actor?: AgentIdentity) {
  if (shuttingDown) throw new Error('服务正在停止');
  if (concurrentLocal(s.deduplicationKey, s)) throw new LocalTerminalError('start_conflict', '同一启动标识已有本地终端在运行。');
  if (!s.occupied && [...sessions.values()].filter(other => other instanceof LocalSession && other.occupied).length >= 16) {
    throw new Error('最多同时打开 16 个本地终端');
  }
  await s.restart(launchLocal(s), actor && (() => {
    s.requireAssignee(actor);
    if (s.privateMode) throw new Error('私密模式已开启，Agent 无权重启终端');
  }));
}
async function createSession(profileId: string, owner: string, creator?: AgentIdentity, startupDir?: string) {
  if (shuttingDown) throw new Error('服务正在停止');
  if (creating + visibleSessions(false).filter(s => s.status === 'open').length >= 16) throw new Error('最多同时打开 16 个连接');
  creating++;
  let saved: SavedPasswordPty | undefined;
  try {
    const profile = profiles.get(profileId);
    if (startupDir !== undefined) profile.startupDir = startupDir;
    const linux = platform.platform === 'linux';
    const args = sshArgs(profile, platform.configFile, hostKeyOptions(platform.platform, DATA));
    let cwd = linux ? DATA : ROOT;
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' };
    if (linux) env.SSH_ASKPASS_REQUIRE = 'never';
    if (profile.savePassword) {
      // Snapshot the credential before any await can let a profile edit change
      // the endpoint/credential pairing underneath this connection.
      const password = await profiles.password(profile.id);
      const helper = await ensureAskpass(ROOT, RUNTIME);
      saved = new SavedPasswordPty(profile, password);
      // Keep the helper path relative to the inherited working directory so its
      // argument stays ASCII. OpenSSH must not search PATH for a bare filename.
      cwd = path.dirname(helper);
      Object.assign(env, await saved.listen(), { SSH_ASKPASS: `.\\${path.basename(helper)}`, SSH_ASKPASS_REQUIRE: 'force' });
    }
    const executable = linux ? await resolveLinuxSsh() : platform.executable;
    if (shuttingDown) throw new Error('服务正在停止');
    let child;
    try { child = pty.spawn(executable, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env }); }
    catch (error) {
      const { code, message } = error as NodeJS.ErrnoException;
      if (code === 'ENOENT' || /^Cannot create process, error code: (2|3)$/.test(message)) {
        throw new Error(`无法找到 OpenSSH 客户端 ${platform.executable}。请检查 OpenSSH 安装、PATH 和工作目录。`);
      }
      throw new Error('无法启动 OpenSSH 的本地 PTY。请检查系统终端权限和原生模块安装。');
    }
    saved?.bind(child);
    const s = new Session(profile, saved ?? child, owner, creator);
    registerSession(s);
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
  z.object({ action: z.literal('get_capabilities') }),
  z.object({ action: z.literal('list_run_configs') }),
  z.object({ action: z.literal('open_local_shell'), ...openLocalInput }),
  startRunSchema.safeExtend({ action: z.literal('start_run') }),
  z.object({ action: z.literal('stop_session'), sessionId: z.guid(), lease: z.guid(), mode: z.never().optional() }),
  z.object({ action: z.literal('restart_session'), sessionId: z.guid(), lease: z.guid() }),
  z.object({ action: z.literal('list_sessions'), scope: z.enum(['mine', 'all']).default('mine') }),
  z.object({ action: z.literal('create_session'), profileId: z.guid(), startupDir: sshStartupDirectory.optional() }),
  z.object({ action: z.literal('attach_session'), sessionId: z.guid() }),
  z.object({ action: z.literal('take_control'), sessionId: z.guid() }),
  z.object({ action: z.literal('release_control'), sessionId: z.guid(), lease: z.guid() }),
  z.object({ action: z.literal('handoff_to_user'), sessionId: z.guid(), lease: z.guid() }),
  z.object({ action: z.literal('request_control_return'), sessionId: z.guid(), message: z.string().trim().min(1).max(2000) }),
  z.object({ action: z.literal('read_output'), sessionId: z.guid(), ...readLimits, resync: z.boolean().optional(), after: z.number().int().min(0).optional(), waitMs: z.number().int().min(0).max(15000).default(0) }),
  z.object({ action: z.literal('read_screen'), sessionId: z.guid(), ...readLimits, startRow: z.number().int().min(0).max(159).optional() }),
  z.object({ action: z.literal('read_history'), sessionId: z.guid(), ...readLimits }),
  z.object({ action: z.literal('send_input'), sessionId: z.guid(), lease: z.guid(), data: z.string().max(16000) }),
  z.object({ action: z.literal('read_messages'), sessionId: z.guid(), unreadOnly: z.boolean().default(false), waitMs: z.number().int().min(0).max(15000).default(0), maxMessages: z.number().int().min(1).max(20).default(5), maxChars: z.number().int().min(2000).max(16000).default(4000), before: z.guid().optional() }),
  z.object({ action: z.literal('acknowledge_messages'), sessionId: z.guid(), messageIds: z.array(z.guid()).min(1).max(100) }),
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
  if (p.action === 'get_capabilities') return capabilities(true);
  if (p.action === 'list_run_configs') { requireLocal(true); return runConfigs.list(); }
  if (p.action === 'open_local_shell') { requireLocal(true); return openLocal(p, 'pending-user', actor); }
  if (p.action === 'start_run') { requireLocal(true); return startRun(p, 'pending-user', actor); }
  if (p.action === 'list_profiles') return profiles.list();
  if (p.action === 'list_sessions') return [...sessions.values()].filter(s => p.scope === 'all' || s.assignedTo?.id === actor.id)
    .map(s => s instanceof LocalSession ? s.agentSummary(actor.id) : s.summary(actor.id));
  if (p.action === 'create_session') return (await createSession(p.profileId, 'pending-user', actor, p.startupDir)).summary(actor.id);
  if (p.action === 'stop_session' || p.action === 'restart_session') {
    requireLocal(true);
    const s = localSession(session(p.sessionId));
    s.requireAgentLease(p.lease, actor, true);
    if (p.action === 'stop_session') await s.stop('graceful');
    else await restartLocal(s, actor);
    return s.agentSummary(actor.id);
  }
  const s = session(p.sessionId);
  if (p.action === 'attach_session') { s.attach(actor); return s instanceof LocalSession ? s.agentSummary(actor.id) : s.summary(actor.id); }
  s.requireAssignee(actor);
  if (p.action === 'read_messages' || p.action === 'acknowledge_messages') {
    if (s.privateMode) throw new Error('私密模式已开启，Agent 无权读取或确认消息');
    if (p.action === 'acknowledge_messages') {
      messages.acknowledge(actor.id, s.id, p.messageIds);
      broadcast({ type: 'messages', sessionId: s.id, messages: messages.list(s.id) }, s.kind === 'local');
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
  if (p.action === 'release_control') {
    if (s instanceof LocalSession && s.privateMode) throw new Error('私密模式已开启，Agent 无权操作本地终端');
    s.releaseAgent(p.lease, actor); return s.summary(actor.id);
  }
  if (p.action === 'handoff_to_user') { s.handoffToUser(p.lease, actor); return s.summary(actor.id); }
  if (p.action === 'request_control_return') { s.requestControlReturn(actor, p.message); return s.summary(actor.id); }
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

function requestOrigin(req: IncomingMessage, secure: boolean, required = false) {
  return secure ? lanRequestOrigin(req, instance?.lan, required) : localRequestOrigin(req, required);
}

async function handleBrowser(req: IncomingMessage, res: ServerResponse, secure: boolean) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const origin = requestOrigin(req, secure);
    if (!origin) return json(res, 403, { error: '来源不被允许' });
    if (!instance || shuttingDown) return json(res, 503, { error: '服务未就绪' });
    const requested = new URL(req.url ?? '/', origin);
    if (requested.origin !== origin) return json(res, 403, { error: '来源不被允许' });
    const route = requested.pathname;
    const local = localBrowserAccess(req, secure);
    if (secure && (route === '/agent' || route.startsWith('/agent/') || route === '/api/pair-code' || route === '/api/shutdown')) {
      return json(res, 404, { error: '接口不存在' });
    }
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
        const target = requested.searchParams.get('target');
        if (target !== null && target !== 'lan') return json(res, 400, { error: '配对目标无效' });
        if (target === 'lan' && !instance?.lan) return json(res, 409, { error: '当前实例未启用局域网 HTTPS。' });
        const code = pairing?.issue(target === 'lan' ? instance?.lan?.origin : undefined);
        if (!code) return json(res, 429, { error: '未使用的配对码过多，请稍后再试。' });
        return json(res, 200, { code });
      }
      if (!['GET', 'HEAD'].includes(req.method ?? '') && !requestOrigin(req, secure, true)) {
        return json(res, 403, { error: '来源不被允许' });
      }
      const hostname = new URL(origin).hostname;
      if (route === '/api/pair' && req.method === 'POST') {
        const invalid = secure ? lanPairingError : pairingError;
        if (!pairing?.allowAttempt()) {
          res.setHeader('Retry-After', '60');
          return json(res, 429, { error: '配对请求过多，请稍后重试。' });
        }
        let code: unknown;
        try { code = (await body(req, 1024))?.code; }
        catch { return json(res, 400, { error: invalid }); }
        const cookie = pairing.redeem(code, hostname, secure ? origin : undefined);
        if (!cookie) return json(res, 400, { error: invalid });
        res.setHeader('Set-Cookie', cookie);
        return empty(res);
      }
      if (!pairing?.expiresAt(req.headers.cookie, hostname, secure)) return json(res, 401, { error: '请先配对浏览器。' });
      if (route === '/api/auth' && req.method === 'GET') return empty(res);
      if (route === '/api/state' && req.method === 'GET') return json(res, 200, {
        profiles: profiles.list(), sessions: visibleSessions(local).map(s => s.summary()), capabilities: capabilities(local),
      });
      if (route === '/api/run-configs' || route.startsWith('/api/run-configs/')) {
        if (!local) return json(res, 404, { error: '接口不存在' });
        requireLocal(local);
        if (route === '/api/run-configs' && req.method === 'GET') return json(res, 200, runConfigs.list());
        let result;
        if (route === '/api/run-configs' && req.method === 'POST') result = await runConfigs.save(await body(req));
        else if (/^\/api\/run-configs\/[^/]+$/.test(route) && req.method === 'DELETE') {
          result = await runConfigs.remove(z.guid().parse(route.split('/').at(-1)));
        } else return json(res, 404, { error: '接口不存在' });
        broadcast({ type: 'run-configs', runConfigs: runConfigs.list() }, true);
        return json(res, 200, result);
      }
      if (route === '/api/ssh-config' && req.method === 'GET') return json(res, 200, await readSshConfig());
      if (route === '/api/profiles' && req.method === 'POST') {
        const profile = await profiles.save(await body(req));
        broadcast({ type: 'profiles', profiles: profiles.list() }); return json(res, 200, profile);
      }
      if (route.startsWith('/api/profiles/') && req.method === 'DELETE') {
        await profiles.remove(z.guid().parse(route.split('/').at(-1)));
        broadcast({ type: 'profiles', profiles: profiles.list() }); return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: '接口不存在' });
    }
    if (req.method !== 'GET' || !assets[route]) return json(res, 404, { error: '页面不存在' });
    const [file, contentType] = assets[route];
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    const content = await readFile(file);
    res.end(route === '/' ? content.toString('utf8').replaceAll('__SST_UI_VERSION__', uiVersion) : content);
  } catch (e: any) {
    if (res.headersSent) res.end();
    else if (e instanceof HandedToUserError) json(res, 409, { error: e.message, code: e.code });
    else if (e instanceof LocalTerminalError) json(res, e.code === 'local_terminal_unavailable' && !supportsLocalTerminal() ? 501 : 400, { error: e.message, code: e.code });
    else json(res, 400, { error: e.message ?? '操作失败' });
  }
}

const server = http.createServer((req, res) => void handleBrowser(req, res, false));
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
function browserUpgrade(secure: boolean) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const origin = requestOrigin(req, secure, true);
    if (!instance || shuttingDown || !origin || req.url !== '/terminal') { socket.destroy(); return; }
    const expiry = pairing?.expiresAt(req.headers.cookie, new URL(origin).hostname, secure);
    if (!expiry) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => attachBrowser(ws, expiry, localBrowserAccess(req, secure)));
  };
}
server.on('upgrade', browserUpgrade(false));
function attachBrowser(ws: WebSocket, expiry: number, local: boolean) {
  const clientId = randomUUID();
  const timeout = setTimeout(() => ws.close(1008, '配对已过期'), Math.max(0, expiry - Date.now()));
  let queue = syncBrowser(ws, clientId, local).catch(() => { ws.close(1011, '同步失败'); });
  ws.on('message', raw => {
    queue = queue.then(async () => {
      let requestId: string | undefined;
      try {
        const p = JSON.parse(raw.toString());
        requestId = p.requestId;
        if (ws.readyState !== WebSocket.OPEN || Date.now() >= expiry) return;
        if (typeof requestId !== 'string') throw new Error('请求缺少标识');
        let result: unknown = { ok: true };
        if (p.type === 'create') result = (await createSession(z.guid().parse(p.profileId), clientId, undefined, sshStartupDirectory.optional().parse(p.startupDir))).summary();
        else if (p.type === 'open-local-shell' || p.type === 'start-run') {
          requireLocal(local);
          result = await (p.type === 'open-local-shell' ? openLocal(p, clientId) : startRun(p, clientId));
        }
        else if (p.type === 'stop-session' || p.type === 'restart-session' || p.type === 'delete-session') {
          requireLocal(local);
          const s = localSession(session(z.guid().parse(p.sessionId), local));
          if (p.type === 'delete-session') { await s.remove(); dismissSession(s); }
          else {
            if (p.type === 'restart-session') await restartLocal(s);
            else await s.stop(z.enum(['graceful', 'force']).default('graceful').parse(p.mode));
            result = s.summary();
          }
        }
        else if (p.type === 'dismiss-tab') {
          // Repeating a completed dismissal is a no-op. An inaccessible
          // local ID is likewise a no-op on the LAN listener.
          const s = visibleSession(z.guid().parse(p.sessionId), local);
          if (s) {
            if (s.status === 'open') throw new Error(s.kind === 'ssh' ? '请先关闭 SSH 连接，再移除页签' : '请先停止本地终端，再移除页签');
            if (s instanceof LocalSession) await s.remove();
            dismissSession(s);
          }
        }
        else {
          const s = session(z.guid().parse(p.sessionId), local);
          if (p.type === 'input') s.userInput(clientId, z.string().max(16000).parse(p.data), z.number().int().parse(p.revision));
          else if (p.type === 'terminal-reply') s.terminalReply(z.string().max(256).parse(p.data));
          else if (p.type === 'takeover') s.takeover(clientId);
          else if (p.type === 'return-to-user') s.returnToUser(clientId);
          else if (p.type === 'return-to-agent') s.returnToAgent(clientId, z.number().int().parse(p.revision));
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
            if (z.guid().parse(p.targetAgentId) !== s.assignedTo.id) throw new Error('关联 Agent 已变化，请确认接收者后重新发送');
            result = messages.send(s.id, s.assignedTo, z.string().trim().min(1).max(2000).parse(p.text));
            broadcast({ type: 'messages', sessionId: s.id, messages: messages.list(s.id) }, s.kind === 'local');
          }
          else if (p.type === 'clear-messages') { messages.clear(s.id); broadcast({ type: 'messages', sessionId: s.id, messages: [] }, s.kind === 'local'); }
          else if (p.type === 'clear-history') { await s.clearHistory(); messages.clear(s.id); broadcast({ type: 'messages', sessionId: s.id, messages: [] }, s.kind === 'local'); }
          else if (p.type === 'resize') await s.resize(z.number().int().min(20).max(400).parse(p.cols), z.number().int().min(5).max(160).parse(p.rows));
          else if (p.type === 'close') { if (s instanceof LocalSession) await s.stop('graceful'); else s.close(); }
          else throw new Error('未知终端操作');
        }
        send(ws, { type: 'ack', requestId, result });
      } catch (e: any) {
        send(ws, { type: 'error', requestId, error: e.message ?? '操作失败',
          code: e instanceof LocalTerminalError || e instanceof HandedToUserError ? e.code : undefined });
      }
    }).catch(() => ws.close(1011, '会话错误'));
  });
  ws.on('error', () => {});
  ws.on('close', () => { clearTimeout(timeout); sockets.delete(ws); synchronizing.delete(ws); });
}

async function syncBrowser(ws: WebSocket, clientId: string, local: boolean) {
  const pending: any[] = [];
  synchronizing.set(ws, { local, pending });
  try {
    send(ws, { type: 'hello', instanceId, uiVersion, clientId, capabilities: capabilities(local),
      profiles: profiles.list(), sessions: visibleSessions(local).map(s => s.summary()) });
    const boundaries = new Map<string, number>();
    for (const s of visibleSessions(local)) {
      const snapshot = await s.snapshot();
      if (sessions.get(s.id) !== s) continue;
      boundaries.set(s.id, snapshot.sequence);
      send(ws, { type: 'snapshot', sessionId: s.id, ...snapshot });
      send(ws, { type: 'messages', sessionId: s.id, messages: messages.list(s.id) });
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    for (const event of pending) {
      if (!['output', 'reset', 'resize'].includes(event.type) || event.uiSeq > (boundaries.get(event.sessionId) ?? -1)) send(ws, event);
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    sockets.set(ws, local);
    send(ws, { type: 'synced', sessions: visibleSessions(local).map(s => s.summary()) });
  } finally { synchronizing.delete(ws); }
}

async function main() {
  platform = sshPlatform();
  const requestedPort = configuredPort();
  serviceLock = await acquireServiceLock(paths);
  if (!serviceLock) throw new ServiceBusy();
  let uiPublished = false;
  try {
    if (platform.platform === 'linux' && Object.keys(process.env).some(key => key.startsWith('SHARED_SSH_LAN_'))) {
      throw new RuntimeError('Linux 目前只支持本机回环。请取消 SHARED_SSH_LAN_* 配置后重新启动。');
    }
    try {
      pty = await import('node-pty');
      if (typeof pty.spawn !== 'function') throw new Error('Missing PTY factory');
    } catch {
      throw new RuntimeError('无法加载 node-pty 原生模块。请在当前系统及 Node 版本下重新安装依赖，并检查原生构建工具。');
    }
    let lanConfiguration;
    try { lanConfiguration = await loadLanConfiguration(); }
    catch (error) { throw new RuntimeError((error as Error).message); }
    await mkdir(DATA, { recursive: true, mode: 0o700 });
    try { await profiles.load(); }
    catch { throw new RuntimeError('无法加载本机服务器配置。请检查配置文件格式和目录权限，修复后重试。'); }
    if (platform.platform === 'win32') {
      try { await runConfigs.load(); }
      catch { throw new RuntimeError('无法加载本机运行配置。请检查 run-configs.json 的格式和目录权限，修复后重试。'); }
    }
    try { pairing = new Pairing(await loadPairingKey(paths.pairingKey), serviceLock.id); }
    catch { throw new RuntimeError('无法加载配对签名密钥。请检查运行目录的 pairing-key.json。'); }
    const { address, port } = await listenLocal(server, requestedPort);
    const url = `http://${address}:${port}`;
    let lan: LanDiscovery | undefined;
    if (lanConfiguration) {
      lanServer = https.createServer(lanConfiguration.tls, (req, res) => void handleBrowser(req, res, true));
      lanServer.on('upgrade', browserUpgrade(true));
      try {
        const bound = await listenOn(lanServer, lanConfiguration.port, lanConfiguration.address);
        lan = { ...bound, origin: lanOrigin(lanConfiguration.host, bound.port) };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new RuntimeError(`无法监听局域网 HTTPS${code ? ` (${code})` : ''}。请检查接口地址、端口及系统权限。`);
      }
    }
    await writeRuntimeJson(paths.ui, { adminToken });
    uiPublished = true;
    await writeRuntimeJson(paths.connection, { url, agentToken, pid: process.pid, address, port, instanceId, lan });
    instance = { service: SERVICE_NAME, runtime: serviceLock.id, pid: process.pid, address, port, instanceId, lan };
    console.log(`共享 SSH 终端已启动 (${address}:${port})`);
    if (lan) console.log(`局域网浏览器入口 ${lan.origin}。可访问该地址的设备可以尝试连接，请仅在信任的网络启用。`);
  } catch (error) {
    server.close();
    server.closeAllConnections();
    lanServer?.close();
    lanServer?.closeAllConnections();
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
  server.close(); lanServer?.close(); wss.close();
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
