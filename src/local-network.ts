import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:net';

export const LOCAL_ADDRESS = '127.0.0.1';

export function preferredLocalPort(value?: string) {
  const port = Number(value ?? 43127);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('端口需要在 1024 到 65535 之间');
  }
  return port;
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try { server.listen(port, LOCAL_ADDRESS); }
    catch (error) { onError(error); }
  });
}

export async function listenLocal(server: Server, preferredPort: number) {
  try {
    await listen(server, preferredPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    await listen(server, 0);
  }
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('无法获取本机监听地址');
  return { address: bound.address, port: bound.port };
}

export function localRequestOrigin(req: IncomingMessage, requireOrigin = false) {
  const { host, origin } = req.headersDistinct;
  if (host?.length !== 1) return;
  const authority = host[0].toLowerCase();
  const port = req.socket.localPort;
  if (authority !== `${LOCAL_ADDRESS}:${port}` && authority !== `localhost:${port}`) return;
  const expected = `http://${authority}`;
  if (!origin) return requireOrigin ? undefined : expected;
  if (origin.length === 1 && origin[0] === expected) return expected;
}

export async function writeRuntimeJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value)); }
    finally { await handle.close(); }
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
