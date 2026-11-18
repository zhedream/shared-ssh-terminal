import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function servicePaths(env = process.env, home = homedir()) {
  const base = path.join(home, '.shared-terminal');
  const data = path.resolve(env.SHARED_SSH_DATA_DIR || path.join(base, 'data'));
  const runtime = path.resolve(env.SHARED_SSH_RUNTIME_DIR || path.join(base, 'runtime'));
  return {
    data, runtime,
    owner: path.join(runtime, 'owner.json'),
    connection: path.join(runtime, 'connection.json'),
    ui: path.join(runtime, 'ui.json'),
    pairingKey: path.join(runtime, 'pairing-key.json'),
    stdout: path.join(runtime, 'service.stdout.log'),
    stderr: path.join(runtime, 'service.stderr.log'),
  };
}

export type ServicePaths = ReturnType<typeof servicePaths>;
