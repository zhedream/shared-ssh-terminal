import { z } from 'zod';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WindowsSecrets, type SecretProtector } from './secrets.js';

export const sshStartupDirectory = z.string().min(1).max(2048)
  .refine(value => value.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(value), '请输入有效的远端启动目录');
export const profileSchema = z.object({
  id: z.guid().optional(),
  name: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9_.:\-]+$/).refine(v => !v.startsWith('-')),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_.\-]+$/).refine(v => !v.startsWith('-')),
  auth: z.enum(['password', 'key', 'agent']).default('password'),
  savePassword: z.boolean().default(false),
  identityFile: z.string().max(2048).optional(),
  startupDir: sshStartupDirectory.optional(),
  note: z.string().max(500).default('')
}).strict().superRefine((p, ctx) => {
  if (p.auth === 'key' && (!p.identityFile || !path.isAbsolute(p.identityFile))) {
    ctx.addIssue({ code: 'custom', path: ['identityFile'], message: '私钥连接需要本机私钥的绝对路径' });
  }
});
export type Profile = z.infer<typeof profileSchema> & { id: string };
const storedSchema = z.object({ profile: profileSchema, encryptedPassword: z.string().optional() });
const inputSchema = z.object({ password: z.string().max(4096).refine(v => !/[\r\n\0]/.test(v), '密码不能包含换行或空字符').optional() });
type Stored = { profile: Profile; encryptedPassword?: string };
const windowsPassword = '此服务器配置包含 Windows 保存的密码。请在「服务器」中另建使用手动密码或本机私钥的配置，或在原 Windows 账户中使用此配置。';

export class Profiles {
  private items: Stored[] = [];
  private writes: Promise<void> = Promise.resolve();
  private changes: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private secrets: SecretProtector | null = process.platform === 'win32' ? new WindowsSecrets() : null) {}
  async load() {
    try {
      const values = JSON.parse(await readFile(path.join(this.directory, 'profiles.json'), 'utf8'));
      this.items = values.map((value: unknown) => {
        const row = storedSchema.parse(typeof value === 'object' && value !== null && 'profile' in value ? value : { profile: value });
        return { ...row, profile: { ...row.profile, id: row.profile.id ?? randomUUID(), savePassword: !!row.encryptedPassword && row.profile.auth === 'password' } };
      });
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
  list() { return this.items.map(p => ({ ...p.profile })); }
  get(id: string) {
    const item = this.items.find(p => p.profile.id === id);
    if (!item) throw new Error('服务器配置不存在');
    return { ...item.profile };
  }
  password(id: string) {
    const item = this.items.find(p => p.profile.id === id);
    if (!item?.profile.savePassword || !item.encryptedPassword) throw new Error('该服务器未保存登录密码');
    if (!this.secrets) throw new Error(windowsPassword);
    return this.secrets.unprotect(item.encryptedPassword);
  }
  save(value: unknown): Promise<Profile> {
    const pending = this.changes.catch(() => {}).then(() => this.saveOne(value));
    this.changes = pending;
    return pending;
  }
  private async saveOne(value: unknown) {
    const { password, ...fields } = z.object({}).passthrough().parse(value) as Record<string, unknown>;
    const secretInput = inputSchema.parse({ password });
    const parsed = profileSchema.parse(fields);
    const item: Profile = { ...parsed, id: parsed.id ?? randomUUID() };
    const index = this.items.findIndex(p => p.profile.id === item.id);
    const old = this.items[index];
    if (!this.secrets) {
      if (old?.encryptedPassword !== undefined) throw new Error(windowsPassword);
      if (item.savePassword || secretInput.password !== undefined) {
        throw new Error('当前平台不支持保存密码。请在「服务器」中保存不含密码的配置，并在终端手动登录。');
      }
    } else if (old?.encryptedPassword !== undefined && fields.savePassword === undefined && secretInput.password === undefined) {
      if (item.auth !== 'password') throw new Error('此配置已保存密码。更改认证方式前请明确关闭保存密码。');
      item.savePassword = true;
    }
    let encryptedPassword: string | undefined;
    item.savePassword = item.auth === 'password' && item.savePassword;
    if (item.savePassword && this.secrets) {
      if (secretInput.password) encryptedPassword = await this.secrets.protect(secretInput.password);
      else if (old?.encryptedPassword && old.profile.host === item.host && old.profile.port === item.port && old.profile.username === item.username) encryptedPassword = old.encryptedPassword;
      else throw new Error('请填写要保存的登录密码；修改服务器地址、端口或用户后需要重新填写');
    }
    const next = this.items.slice();
    if (index === -1) next.push({ profile: item, encryptedPassword }); else next[index] = { profile: item, encryptedPassword };
    await this.persist(next); this.items = next;
    return { ...item };
  }
  remove(id: string) {
    const pending = this.changes.catch(() => {}).then(async () => {
      const next = this.items.filter(p => p.profile.id !== id);
      await this.persist(next); this.items = next;
    });
    this.changes = pending; return pending;
  }
  private persist(items: Stored[]) {
    const json = JSON.stringify(items, null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, 'profiles.json');
      await writeFile(file + '.tmp', json, { mode: 0o600 });
      await rename(file + '.tmp', file);
    });
    return this.writes;
  }
}

function sshDirectoryCommand(directory: string) {
  // OpenSSH passes this as a single command to the remote account shell.
  const literal = "'" + (directory.startsWith('-') ? './' + directory : directory).replaceAll("'", "'\\''") + "'";
  return 'CDPATH=; if ! cd ' + literal + ' 2>/dev/null; then ' +
    "printf '%s\\n' '共端：远端启动目录不可用，继续使用登录目录。' >&2; fi; exec \"${SHELL:-/bin/sh}\" -l";
}

export function sshArgs(p: Profile, configFile = process.platform === 'win32' ? 'NUL' : '/dev/null', hostKeys: string[] = []) {
  const args = ['-F', configFile, '-tt', '-p', String(p.port), '-l', p.username,
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=ask', '-o', 'EscapeChar=none'];
  if (p.auth === 'key') args.push('-i', p.identityFile!, '-o', 'IdentitiesOnly=yes');
  if (p.auth === 'password') args.push('-o', 'PubkeyAuthentication=no', '-o', p.savePassword ? 'PreferredAuthentications=password' : 'PreferredAuthentications=keyboard-interactive,password');
  args.push(...hostKeys, '--', p.host);
  if (p.startupDir !== undefined) args.push(sshDirectoryCommand(p.startupDir));
  return args;
}
