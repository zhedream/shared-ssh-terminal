import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { homedir, release } from 'node:os';
import path from 'node:path';
import type { IPty, spawn } from 'node-pty';
import type { Pty } from './sessions.js';
import { localTerminalHelper } from './local-terminal-helper.js';

export type LocalLaunch = { kind: 'local'; name: string; cwd: string; command?: string; runConfigId?: string };
export class LocalTerminalError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function supportsLocalTerminal() {
  return process.platform === 'win32' && Number(release().split('.')[2]) >= 18309;
}

const builds = new Map<string, Promise<string>>();
function powershellPath() {
  const root = process.env.SystemRoot;
  if (!root || !path.isAbsolute(root)) throw new LocalTerminalError('local_start_failed', '无法找到 Windows PowerShell。');
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function ensureHelper(runtime: string, shell: string) {
  const pending = builds.get(runtime);
  if (pending) return pending;
  const build = (async () => {
    const version = createHash('sha256').update(localTerminalHelper).digest('hex').slice(0, 16);
    const target = path.join(runtime, `terminal-job-${version}.exe`);
    if (await access(target).then(() => true, () => false)) return target;
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const temporary = path.join(runtime, `terminal-job-${randomUUID()}.exe`);
    try {
      await new Promise<void>((resolve, reject) => {
        const compiler = execFile(shell, ['-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))|ConvertFrom-Json; Add-Type -TypeDefinition $p.source -OutputAssembly $p.target -OutputType ConsoleApplication"],
        { windowsHide: true, timeout: 12000 }, error => error ? reject(error) : resolve());
        compiler.stdin!.on('error', reject);
        compiler.stdin!.end(Buffer.from(JSON.stringify({ source: localTerminalHelper, target: temporary }), 'utf8').toString('base64'));
      });
      await rename(temporary, target);
      return target;
    } finally { await unlink(temporary).catch(() => {}); }
  })().catch(error => { builds.delete(runtime); throw error; });
  builds.set(runtime, build);
  return build;
}

export async function validatedLocalDirectory(value = homedir()) {
  if (!path.isAbsolute(value)) throw new LocalTerminalError('invalid_cwd', '请选择本机的绝对启动目录。');
  const cwd = path.normalize(value);
  if (!await stat(cwd).then(result => result.isDirectory(), () => false)) {
    throw new LocalTerminalError('invalid_cwd', '本机启动目录不存在或不能访问。');
  }
  return cwd;
}

const envNames = new Set(['APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS',
  'OS', 'PATH', 'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']);
function localEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name, value]) => value !== undefined && envNames.has(name.toUpperCase()))) as Record<string, string>;
  return { ...env, TERM: 'xterm-256color' };
}

export async function spawnLocalTerminal(
  spawnPty: typeof spawn, runtime: string, launch: LocalLaunch, cols: number, rows: number,
  bind: (pty: Pty) => void, signal: AbortSignal,
) {
  if (!supportsLocalTerminal()) throw new LocalTerminalError('local_terminal_unavailable', '本地终端需要支持 ConPTY 的 Windows。');
  const cwd = await validatedLocalDirectory(launch.cwd);
  const shell = powershellPath();
  const pipeName = 'sst-terminal-' + randomUUID();
  const pipe = createServer();
  let control: Socket | undefined;
  let live = true;
  const cancel = () => {
    live = false;
    pipe.close();
    // Closing the control stream also terminates the Job if the broker exits.
    control?.end(Buffer.from([1]));
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const helper = await ensureHelper(runtime, shell);
    await new Promise<void>((resolve, reject) => {
      pipe.once('error', reject);
      pipe.listen('\\\\.\\pipe\\' + pipeName, resolve);
    });
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PTY Job startup timed out')), 6500);
      pipe.on('connection', socket => {
        if (control || !live) { socket.destroy(); return; }
        control = socket;
        pipe.close();
        socket.on('error', () => {});
        if (!live) { socket.destroy(); return; }
        let reply = '';
        const ready = (chunk: Buffer) => {
          reply += chunk.toString('ascii');
          if ('READY\n'.startsWith(reply) && reply !== 'READY\n') return;
          clearTimeout(timer);
          socket.off('data', ready);
          if (reply === 'READY\n') resolve();
          else reject(new Error('Invalid PTY Job handshake'));
        };
        socket.on('data', ready);
        socket.once('close', () => { clearTimeout(timer); reject(new Error('PTY Job closed before startup')); });
      });
      const args = [pipeName, shell];
      if (launch.command !== undefined) args.push(Buffer.from(launch.command, 'utf16le').toString('base64'));
      let child: IPty;
      try { child = spawnPty(helper, args, { cwd, cols, rows, name: 'xterm-256color', env: localEnvironment(), useConpty: true, useConptyDll: true }); }
      catch (error) { clearTimeout(timer); reject(error); return; }
      child.onExit(() => {
        // node-pty 1.1 keeps the Windows relay worker listening after natural
        // exit. Release that relay without entering its PID-based kill path.
        const relay = (child as IPty & { _agent?: { inSocket?: Socket; _conoutSocketWorker?: { dispose(): void } } })._agent;
        relay?.inSocket?.destroy();
        relay?._conoutSocketWorker?.dispose();
        reject(new Error('PTY Job exited before startup'));
      });
      bind({
        write: text => child.write(text),
        resize: (columns, lines) => child.resize(columns, lines),
        clear: () => child.clear(),
        kill: cancel,
        onData: callback => child.onData(callback),
        onExit: callback => child.onExit(event => { clearTimeout(timer); cancel(); callback(event); }),
      });
    });
  } catch (error) {
    cancel();
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof LocalTerminalError) throw error;
    throw new LocalTerminalError('local_start_failed', '无法启动本地 PowerShell。请检查 Windows PowerShell、ConPTY 和本地进程权限。');
  } finally { signal.removeEventListener('abort', cancel); }
}
