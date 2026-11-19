#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { servicePaths } from './paths.js';
import { pairingUrl, ensureService, RuntimeError, runtimeErrorMessage, serviceStatus, stopService } from './service-runtime.js';

function openBrowser(url: string) {
  return new Promise<void>((resolve, reject) => {
    const failed = () => reject(new RuntimeError('无法打开默认浏览器。请检查 Windows 的默认应用设置。'));
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Start-Process -FilePath ([Console]::In.ReadToEnd())"],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', failed);
    child.once('close', code => { if (code === 0) resolve(); else failed(); });
    child.stdin.on('error', failed);
    child.stdin.end(url);
  });
}

async function main(args: string[]) {
  const paths = servicePaths();
  const command = args[0];
  if (args.length === 1 && command === 'mcp') {
    await import('./mcp.js');
    return;
  }
  if (command === 'server' && (args.length === 1 || (args.length === 2 && args[1] === '--open'))) {
    if (args[1] && process.platform !== 'win32') throw new RuntimeError('--open 仅支持 Windows，请在 Windows 使用旧入口打开页面。');
    const service = await ensureService(paths);
    if (args[1]) await openBrowser(await pairingUrl(paths, service));
    console.log(JSON.stringify({ running: true, address: service.address, port: service.port, pid: service.pid, lan: service.lan }));
    if (service.lan) console.error(`局域网浏览器入口 ${service.lan.origin}。可访问该地址的设备可以尝试连接，请仅在信任的网络启用。`);
    return;
  }
  if (args.length === 1 && command === 'status') {
    console.log(JSON.stringify(await serviceStatus(paths)));
    return;
  }
  if (command === 'pair' && (args.length === 1 || (args.length === 2 && args[1] === '--lan'))) {
    console.log(await pairingUrl(paths, await ensureService(paths), args[1] === '--lan'));
    return;
  }
  if (args.length === 1 && command === 'stop') {
    console.error('停止此运行目录的共端服务会关闭其所有 SSH 会话。');
    const stopped = await stopService(paths);
    console.log(JSON.stringify({ stopped }));
    return;
  }
  const usage = '用法: shared-ssh-terminal server [--open] | status | pair [--lan] | mcp | stop';
  if (!args.length || (args.length === 1 && command === '--help')) { console.log(usage); return; }
  throw new RuntimeError(usage);
}

main(process.argv.slice(2)).catch(error => {
  console.error(runtimeErrorMessage(error));
  process.exitCode = 1;
});
