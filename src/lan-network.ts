import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import { createSecureContext } from 'node:tls';
import { z } from 'zod';

function isLanAddress(address: string) {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || (first === 169 && second === 254);
}

function isBrowserHost(host: string) {
  if (isIPv4(host)) return isLanAddress(host);
  return host.length <= 253 && host !== 'localhost' && /[a-z]/i.test(host) &&
    host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
    !/^\d+$/.test(host.split('.').at(-1)!);
}

export function lanOrigin(host: string, port: number) {
  return new URL(`https://${host}:${port}`).origin;
}

export const lanDiscoverySchema = z.object({
  address: z.string().refine(isLanAddress),
  port: z.number().int().min(1).max(65535),
  origin: z.string(),
}).refine(lan => {
  try {
    const { hostname } = new URL(lan.origin);
    return isBrowserHost(hostname) && lan.origin === lanOrigin(hostname, lan.port);
  } catch { return false; }
});
export type LanDiscovery = z.infer<typeof lanDiscoverySchema>;

export const lanPathEnv = ['SHARED_SSH_LAN_CERT', 'SHARED_SSH_LAN_KEY'] as const;

export async function loadLanConfiguration(env = process.env) {
  const { SHARED_SSH_LAN_BIND: address, SHARED_SSH_LAN_PORT: portText, SHARED_SSH_LAN_HOST: browserHost,
    SHARED_SSH_LAN_CERT: certPath, SHARED_SSH_LAN_KEY: keyPath } = env;
  if ([address, portText, browserHost, certPath, keyPath].every(value => value === undefined)) return;
  if (!address || !portText || !browserHost || !certPath || !keyPath) throw new Error('启用局域网需要完整设置 SHARED_SSH_LAN_BIND、PORT、HOST、CERT、KEY。');
  if (!isLanAddress(address)) throw new Error('SHARED_SSH_LAN_BIND 必须是具体的私有或链路本地 IPv4 接口地址。');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SHARED_SSH_LAN_PORT 必须是 1 到 65535 的端口。');
  const host = browserHost.toLowerCase();
  if (!isBrowserHost(host)) throw new Error('SHARED_SSH_LAN_HOST 必须是浏览器使用的局域网 IPv4 地址或 DNS 名称，且不含端口。');
  let cert: Buffer, key: Buffer;
  try { [cert, key] = await Promise.all([readFile(path.resolve(certPath)), readFile(path.resolve(keyPath))]); }
  catch { throw new Error('无法读取 SHARED_SSH_LAN_CERT 或 SHARED_SSH_LAN_KEY，请核对证书、私钥路径及权限。'); }
  const tls = { cert, key, minVersion: 'TLSv1.2' as const };
  let leaf: X509Certificate;
  try { leaf = new X509Certificate(cert); createSecureContext(tls); }
  catch { throw new Error('局域网证书或私钥无效，请提供匹配的 PEM 证书及私钥。'); }
  const now = Date.now();
  if (now < Date.parse(leaf.validFrom) || now >= Date.parse(leaf.validTo)) throw new Error('局域网证书尚未生效或已过期。');
  const matched = isIPv4(host) ? leaf.checkIP(host) : leaf.checkHost(host, { subject: 'never' });
  if (!matched) throw new Error('局域网证书的 SAN 必须匹配 SHARED_SSH_LAN_HOST。');
  return { address, port, host, tls };
}

export function lanRequestOrigin(req: IncomingMessage, lan: LanDiscovery | undefined, requireOrigin: boolean) {
  if (!lan || req.socket.localPort !== lan.port || req.socket.localAddress !== lan.address) return;
  const { host, origin } = req.headersDistinct;
  const expected = new URL(lan.origin);
  if (host?.length !== 1) return;
  const authority = host[0].toLowerCase();
  if (authority !== expected.host && !(lan.port === 443 && authority === expected.hostname + ':443')) return;
  if (!origin) return requireOrigin ? undefined : expected.origin;
  if (origin.length === 1 && origin[0] === expected.origin) return expected.origin;
}
