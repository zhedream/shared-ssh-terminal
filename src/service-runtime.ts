import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LOCAL_ADDRESS, preferredLocalPort } from './local-network.js';
import { installRoot, type ServicePaths } from './paths.js';

export const SERVICE_NAME = 'shared-ssh-terminal';
export const SERVICE_BUSY = 75;
export class RuntimeError extends Error {}

const pidSchema = z.number().int().positive().max(0x7fffffff);
const bearerSchema = z.string().regex(/^[a-f0-9]{64}$/);
const connectionSchema = z.object({
  url: z.string(), agentToken: bearerSchema, pid: pidSchema,
  address: z.literal(LOCAL_ADDRESS), port: z.number().int().min(1024).max(65535),
}).refine(c => c.url === `http://${c.address}:${c.port}`);
export type ServiceConnection = z.infer<typeof connectionSchema>;

function errno(error: unknown) { return (error as NodeJS.ErrnoException)?.code; }

export function runtimeErrorMessage(error: unknown) {
  if (error instanceof RuntimeError) return error.message;
  const { code, syscall } = (error ?? {}) as NodeJS.ErrnoException;
  const operation = [syscall, code].filter(value => value && /^[a-zA-Z_0-9]+$/.test(value)).join(' ');
  return `本地服务操作失败${operation ? ` (${operation})` : ''}。请检查运行目录权限或配置。`;
}

export function configuredPort() {
  try { return preferredLocalPort(process.env.SHARED_SSH_PORT); }
  catch { throw new RuntimeError('SHARED_SSH_PORT 需设为 1024 到 65535 之间的整数。'); }
}

async function runtimeId(paths: ServicePaths) {
  let resolved: string;
  try { resolved = await realpath(paths.runtime); }
  catch (error) { if (errno(error) === 'ENOENT') return; throw error; }
  return createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex');
}

function lockAddress(id: string) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${SERVICE_NAME}-${id}`;
  if (process.platform === 'linux') return `\0${SERVICE_NAME}-${id}`;
  throw new RuntimeError('服务单例目前支持 Windows 和 Linux 的本机锁。');
}

async function lockIsHeld(paths: ServicePaths) {
  const id = await runtimeId(paths);
  if (!id) return false;
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(lockAddress(id));
    socket.setTimeout(750, () => socket.destroy(new RuntimeError('无法核对运行目录的单例锁。请稍后重试。')));
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      if (['ENOENT', 'ECONNREFUSED'].includes(errno(error) ?? '')) resolve(false);
      else if (errno(error) === 'EBUSY') resolve(true);
      else reject(error);
    });
  });
}

// `undefined` means missing; `null` means present with invalid contents.
async function readJson(file: string): Promise<unknown> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    if (errno(error) === 'EISDIR') return null;
    throw error;
  }
  try { return JSON.parse(raw); } catch { return null; }
}

async function ownerIsLive(paths: ServicePaths) {
  const raw = await readJson(paths.owner);
  if (raw === undefined) return;
  const owner = z.object({ pid: pidSchema }).safeParse(raw);
  if (!owner.success) {
    throw new RuntimeError('owner.json 不完整，无法确认原实例。请用原入口核对服务，或指定独立的 SHARED_SSH_RUNTIME_DIR。');
  }
  try { process.kill(owner.data.pid, 0); return true; }
  catch (error) { if (errno(error) === 'ESRCH') return false; throw error; }
}

export async function acquireServiceLock(paths: ServicePaths) {
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const id = await runtimeId(paths);
  if (!id) throw new RuntimeError('运行目录在启动时消失。请重试。');
  // An OS-owned socket releases automatically on exit, including crashes. The
  // outer runtime path is canonical so aliases cannot start a second instance.
  const lock = createServer(socket => socket.destroy());
  const held = await new Promise<boolean>((resolve, reject) => {
    const onError = (error: Error) => {
      if (errno(error) === 'EADDRINUSE') resolve(false);
      else reject(error);
    };
    lock.once('error', onError);
    lock.listen({ path: lockAddress(id), exclusive: true }, () => {
      lock.off('error', onError);
      resolve(true);
    });
  });
  if (!held) return;
  const close = () => new Promise<void>(resolve => lock.close(() => resolve()));
  let claimed = false;
  try {
    const live = await ownerIsLive(paths);
    if (live === true) {
      throw new RuntimeError('运行目录已有仍在运行的进程。请用其原入口核对服务，或指定独立的 SHARED_SSH_RUNTIME_DIR。');
    }
    if (live === false) await unlink(paths.owner);
    const owner = await open(paths.owner, 'wx', 0o600);
    claimed = true;
    try { await owner.writeFile(JSON.stringify({ pid: process.pid })); }
    finally { await owner.close(); }
  } catch (error) {
    if (claimed) await unlink(paths.owner).catch(() => {});
    await close();
    throw error;
  }
  return { id, release: async () => {
    try { await unlink(paths.owner); }
    finally { await close(); }
  } };
}

async function readConnection(paths: ServicePaths) {
  const result = connectionSchema.safeParse(await readJson(paths.connection));
  return result.success ? result.data : undefined;
}

export async function findService(paths: ServicePaths, signal?: AbortSignal): Promise<ServiceConnection | undefined> {
  const connection = await readConnection(paths);
  if (!connection) return;
  const id = await runtimeId(paths);
  if (!id) return;
  try {
    const response = await fetch(`${connection.url}/agent/instance`, {
      headers: { Authorization: `Bearer ${connection.agentToken}` }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(750)]) : AbortSignal.timeout(750),
    });
    if (!response.ok) { await response.body?.cancel(); return; }
    const { service, runtime, pid, address, port } = await response.json();
    if (service === SERVICE_NAME && runtime === id && pid === connection.pid && address === connection.address && port === connection.port) {
      return connection;
    }
  } catch { signal?.throwIfAborted(); }
}

export async function serviceStatus(paths: ServicePaths) {
  const service = await findService(paths);
  if (service) return { running: true as const, address: service.address, port: service.port, pid: service.pid };
  if (await lockIsHeld(paths) || await ownerIsLive(paths)) {
    throw new RuntimeError('本地服务未就绪或身份无法确认。请稍后重试，并检查运行目录的 service.stderr.log。');
  }
  return { running: false as const, address: null, port: null };
}

type Launch = { finished: boolean; code?: number | null };
async function launchService(paths: ServicePaths): Promise<Launch> {
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const stdout = await open(paths.stdout, 'a', 0o600);
  try {
    const stderr = await open(paths.stderr, 'a', 0o600);
    try {
      const fromSource = fileURLToPath(import.meta.url).endsWith('.ts');
      const args = fromSource ? ['--import', 'tsx', 'src/server.ts'] : ['dist/server.js'];
      const launch: Launch = { finished: false };
      const child = spawn(process.execPath, args, {
        cwd: installRoot, detached: true, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd],
        env: { ...process.env, SHARED_SSH_DATA_DIR: paths.data, SHARED_SSH_RUNTIME_DIR: paths.runtime },
      });
      child.once('error', () => { launch.finished = true; });
      child.once('exit', code => { launch.code = code; launch.finished = true; });
      child.unref();
      return launch;
    } finally { await stderr.close(); }
  } finally { await stdout.close(); }
}

export async function ensureService(paths: ServicePaths, signal?: AbortSignal) {
  const deadline = Date.now() + 10000;
  let launch: Launch | undefined;
  do {
    signal?.throwIfAborted();
    const connection = await findService(paths, signal);
    if (connection) return connection;
    if (launch?.finished && launch.code !== SERVICE_BUSY) {
      throw new RuntimeError('本地服务启动失败。请检查运行目录的 service.stderr.log，修复后重试。');
    }
    if ((!launch || launch.finished) && !await lockIsHeld(paths)) {
      configuredPort();
      launch = await launchService(paths);
    }
    await delay(100, undefined, { signal });
  } while (Date.now() < deadline);
  throw new RuntimeError('本地服务未在等待时间内就绪。请检查运行目录的 service.stderr.log，或确认目录是否仍由原实例使用。');
}

async function uiCredential(paths: ServicePaths, connection: ServiceConnection) {
  const ui = z.object({ url: z.string() }).safeParse(await readJson(paths.ui));
  const prefix = `${connection.url}/#`;
  if (!ui.success || !ui.data.url.startsWith(prefix) || !bearerSchema.safeParse(ui.data.url.slice(prefix.length)).success) {
    throw new RuntimeError('UI 启动信息与已验证的本地服务不符。请核对运行目录，或用原入口停止后重试。');
  }
  return { url: ui.data.url, token: ui.data.url.slice(prefix.length) };
}

export async function browserUrl(paths: ServicePaths, connection: ServiceConnection) {
  const { url, token } = await uiCredential(paths, connection);
  const response = await fetch(`${connection.url}/api/state`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(3000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new RuntimeError('页面启动凭据无效。请核对运行目录后重试。');
  return url;
}

export async function stopService(paths: ServicePaths) {
  const service = await findService(paths);
  if (!service) {
    const status = await serviceStatus(paths);
    if (!status.running) return false;
    throw new RuntimeError('服务状态正在变化。请重新执行 stop。');
  }
  const { token } = await uiCredential(paths, service);
  const response = await fetch(`${service.url}/api/shutdown`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(3000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new RuntimeError('服务拒绝关闭请求。请核对运行目录和实例状态。');
  const deadline = Date.now() + 5000;
  do {
    const current = await readConnection(paths);
    if (current?.agentToken !== service.agentToken) {
      if (!await lockIsHeld(paths)) return true;
      // A concurrent caller may launch a new generation after this one's exit.
      if (current && (await findService(paths))?.agentToken === current.agentToken) return true;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new RuntimeError('服务已收到关闭请求，退出尚未确认。重试前请执行 status。');
}
