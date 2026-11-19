import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { RuntimeError } from './service-runtime.js';

export function sshPlatform(platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') return { platform, executable: 'ssh.exe', configFile: 'NUL', savePassword: true } as const;
  if (platform === 'linux') return { platform, executable: 'ssh', configFile: '/dev/null', savePassword: false } as const;
  throw new RuntimeError('共端服务目前支持 Windows 和 Linux。');
}

export async function resolveLinuxSsh(searchPath = process.env.PATH ?? '') {
  for (const directory of searchPath.split(':')) {
    if (!path.posix.isAbsolute(directory)) continue;
    const executable = path.posix.join(directory, 'ssh');
    try {
      await access(executable, constants.X_OK);
      if ((await stat(executable)).isFile()) return executable;
    } catch { /* Try the next absolute PATH entry. */ }
  }
  throw new Error('找不到可执行的 OpenSSH 客户端 ssh。请确认已安装 openssh-client，且启动共端的 PATH 包含其绝对目录。');
}

export function hostKeyOptions(platform: ReturnType<typeof sshPlatform>['platform'], dataDirectory: string) {
  // Linux starts ssh in the data directory. Using a fixed relative filename
  // keeps arbitrary directory names out of OpenSSH's config/token parser.
  if (platform === 'linux') return ['-o', 'UserKnownHostsFile=./known_hosts', '-o', 'GlobalKnownHostsFile=/dev/null'];
  const knownHosts = path.win32.join(dataDirectory, 'known_hosts').replaceAll('\\', '/').replaceAll('"', '\\"');
  return ['-o', `UserKnownHostsFile="${knownHosts}"`];
}
