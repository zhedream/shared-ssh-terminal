import { spawn } from 'node:child_process';

export interface SecretProtector {
  protect(value: string): Promise<string>;
  unprotect(value: string): Promise<string>;
}

// DPAPI CurrentUser: no plaintext password or decryption key is written to disk.
export class WindowsSecrets implements SecretProtector {
  private run(operation: 'protect' | 'unprotect', value: string): Promise<string> {
    if (process.platform !== 'win32') return Promise.reject(new Error('保存密码目前仅支持 Windows 当前账户加密'));
    const code = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($v); $scope=[Security.Cryptography.DataProtectionScope]::CurrentUser; ` +
      (operation === 'protect'
        ? '$r=[Security.Cryptography.ProtectedData]::Protect($b,$null,$scope);'
        : '$r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,$scope);') +
      ' [Console]::Out.Write([Convert]::ToBase64String($r))';
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => child.kill(), 15000);
      child.stdout.on('data', data => { output += data.toString(); });
      // Never return PowerShell error details that might contain input data.
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.on('error', () => { clearTimeout(timer); reject(new Error('无法调用 Windows 密码保护服务')); });
      child.on('close', status => {
        clearTimeout(timer);
        if (status !== 0 || !/^[A-Za-z0-9+/=]+$/.test(output)) return reject(new Error('无法加密或解密密码，请在当前 Windows 账户下重新保存'));
        resolve(operation === 'protect' ? output : Buffer.from(output, 'base64').toString('utf8'));
      });
      child.stdin.end(operation === 'protect' ? Buffer.from(value, 'utf8').toString('base64') : value);
    });
  }
  protect(value: string) { return this.run('protect', value); }
  unprotect(value: string) { return this.run('unprotect', value); }
}
