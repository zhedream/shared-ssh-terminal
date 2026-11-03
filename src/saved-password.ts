import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Pty } from './sessions.js';
import type { Profile } from './profiles.js';

let build: Promise<string> | undefined;
export function ensureAskpass(root: string, runtime: string) {
  if (process.platform !== 'win32') throw new Error('保存密码自动登录目前仅支持 Windows');
  return build ??= (async () => {
    const source = path.join(root, 'scripts', 'ssh-askpass.cs');
    const hash = createHash('sha256').update(await readFile(source)).digest('hex').slice(0, 16);
    const target = path.join(runtime, `ssh-askpass-${hash}.exe`);
    try { await readFile(target); return target; } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    await mkdir(runtime, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))|ConvertFrom-Json; Add-Type -Path $p.source -OutputAssembly $p.target -OutputType ConsoleApplication"],
      { windowsHide: true, timeout: 30000 }, (error) => error ? reject(new Error('自动登录组件初始化失败，请检查 Windows PowerShell 是否可用')) : resolve()).stdin!.end(Buffer.from(JSON.stringify({ source, target }), 'utf8').toString('base64'));
    });
    return target;
  })().catch(error => { build = undefined; throw error; });
}

// Authentication questions come from OpenSSH's askpass channel, never from
// matching remote terminal output. Passwords therefore cannot become commands.
export class SavedPasswordPty extends EventEmitter implements Pty {
  private child?: Pty;
  private pending?: { socket: Socket; answer: string; timer: NodeJS.Timeout };
  private password?: string;
  private used = false;
  private sockets = new Set<Socket>();
  private server = createServer(socket => this.request(socket));
  private token = randomBytes(32).toString('hex');
  private pipe = `sst-askpass-${randomBytes(16).toString('hex')}`;
  constructor(private profile: Profile, password: string) { super(); this.password = password; }
  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject); this.server.listen('\\\\.\\pipe\\' + this.pipe, resolve);
    });
    return { SST_ASKPASS_PIPE: this.pipe, SST_ASKPASS_TOKEN: this.token };
  }
  bind(child: Pty) {
    this.child = child;
    child.onData(data => this.emit('data', data));
    child.onExit(event => { this.dispose(); this.emit('exit', event); });
  }
  dispose() {
    this.password = undefined;
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
  }
  private request(socket: Socket) {
    this.sockets.add(socket); let input = '', received = false;
    const timer = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer); this.sockets.delete(socket);
      if (this.pending?.socket === socket) { clearTimeout(this.pending.timer); this.pending = undefined; }
    });
    socket.on('data', chunk => {
      if (received) return;
      input += chunk.toString('utf8');
      if (input.length > 20000) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      received = true; clearTimeout(timer);
      const [token, encoded] = input.trim().split('\t');
      if (token !== this.token || !encoded || this.pending) { socket.destroy(); return; }
      const prompt = Buffer.from(encoded, 'base64').toString('utf8');
      const passwordPrompt = `${this.profile.username}@${this.profile.host}'s password:`;
      if (!this.used && prompt.trim() === passwordPrompt) {
        this.used = true;
        this.respond(socket, this.password!); this.password = undefined;
        return;
      }
      // Host-key confirmation and further challenges remain interactive.
      // Do not echo any answer: a password retry or OTP may also use askpass.
      if (this.used && prompt.trim() === passwordPrompt) this.emit('data', '\r\n保存的密码未被接受，请手动输入或编辑服务器配置更新密码。\r\n');
      this.emit('data', '\r\n' + prompt + ' ');
      this.pending = { socket, answer: '', timer: setTimeout(() => {
        socket.destroy(); this.emit('data', '\r\n认证确认超时，请重新连接。\r\n');
      }, 120000) };
    });
  }
  private respond(socket: Socket, answer: string) { socket.end('ok:' + Buffer.from(answer, 'utf8').toString('base64') + '\n'); }
  write(data: string) {
    if (!this.pending) { this.child?.write(data); return; }
    for (const char of data) {
      const p = this.pending;
      if (!p) break; // Discard trailing paste/keys; never deliver them to a shell.
      if (char === '\x03' || char === '\x1b') {
        clearTimeout(p.timer); p.socket.destroy(); this.pending = undefined; this.emit('data', '\r\n'); break;
      }
      if (char === '\r' || char === '\n') {
        clearTimeout(p.timer); this.pending = undefined; this.respond(p.socket, p.answer); this.emit('data', '\r\n'); break;
      }
      if (char === '\x7f' || char === '\b') p.answer = Array.from(p.answer).slice(0, -1).join('');
      else if (char >= ' ' && p.answer.length < 4096) p.answer += char;
    }
  }
  resize(cols: number, rows: number) { this.child?.resize(cols, rows); }
  clear() { this.child?.clear?.(); }
  kill() { this.dispose(); this.child?.kill(); }
  onData(fn: (data: string) => void) { this.on('data', fn); }
  onExit(fn: (event: { exitCode: number }) => void) { this.on('exit', fn); }
}
