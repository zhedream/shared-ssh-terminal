import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeRuntimeJson } from './local-network.js';

const validCode = /^[A-Za-z0-9_-]{43}$/;
const codeLifetime = 5 * 60_000;
const cookieSeconds = 7 * 24 * 60 * 60;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const pairingError = '配对码无效或已过期，请运行 shared-ssh-terminal pair 获取新配对码。';

// Called under the runtime owner lock. Invalid existing key material fails
// closed so an unreadable or damaged file cannot silently invalidate sessions.
export async function loadPairingKey(file: string) {
  let stored: unknown;
  try { stored = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取配对签名密钥');
    const key = randomBytes(32);
    await writeRuntimeJson(file, key.toString('hex'));
    return key;
  }
  if (typeof stored !== 'string' || !/^[a-f0-9]{64}$/.test(stored)) throw new Error('配对签名密钥格式错误');
  return Buffer.from(stored, 'hex');
}

export class Pairing {
  private readonly codes = new Map<string, number>();
  private attempts = 0;
  private resetAt = 0;
  readonly cookieName: string;

  constructor(private readonly key: Buffer, runtimeId: string, private readonly now = Date.now) {
    this.cookieName = 'sst_session_' + runtimeId.slice(0, 32);
  }

  issue() {
    const now = this.now();
    for (const [id, expiry] of this.codes) if (expiry <= now) this.codes.delete(id);
    if (this.codes.size >= 128) return;
    const code = randomBytes(32).toString('base64url');
    this.codes.set(digest(code), now + codeLifetime);
    return code;
  }

  allowAttempt() {
    const now = this.now();
    if (now >= this.resetAt) {
      this.attempts = 0;
      this.resetAt = now + 60_000;
    }
    if (this.attempts >= 60) return false;
    this.attempts++;
    return true;
  }

  redeem(code: unknown, hostname: string) {
    if (typeof code !== 'string' || !validCode.test(code)) return;
    const id = digest(code);
    const expiry = this.codes.get(id);
    // There is no await between lookup and deletion.
    if (expiry === undefined || !this.codes.delete(id) || expiry <= this.now()) return;
    const value = `${Math.floor(this.now() / 1000) + cookieSeconds}.${randomBytes(16).toString('hex')}`;
    const signature = this.sign(hostname, value).toString('hex');
    return `${this.cookieName}=${value}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${cookieSeconds}`;
  }

  private sign(hostname: string, value: string) {
    return createHmac('sha256', this.key).update(`${this.cookieName}\n${hostname}\n${value}`).digest();
  }

  expiresAt(cookie: string | undefined, hostname: string) {
    const prefix = this.cookieName + '=';
    const entries = cookie?.split(';').map(entry => entry.trim()).filter(entry => entry.startsWith(prefix)) ?? [];
    if (entries.length !== 1) return;
    const match = /^(\d{1,12}\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(entries[0].slice(prefix.length));
    if (!match) return;
    const [, value, signature] = match;
    const expiry = Number(value.split('.')[0]) * 1000;
    if (expiry <= this.now() || !timingSafeEqual(this.sign(hostname, value), Buffer.from(signature, 'hex'))) return;
    return expiry;
  }
}
