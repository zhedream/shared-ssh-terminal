// Inspect Git's staged bytes, never dump suspected secret values to the console.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
const files = git(['ls-files', '--cached', '-z']).split('\0').filter(Boolean);
if (!files.length) throw new Error('No staged/tracked files. Add the intended source files first.');
const privateValues = [homedir()];
try {
  const records = JSON.parse(readFileSync('data/profiles.json', 'utf8'));
  for (const row of records) {
    const p = row.profile || row;
    if (p.host && !/^(localhost|127\.|::1$|example\.)/.test(p.host)) privateValues.push(p.host);
    if (p.identityFile) privateValues.push(p.identityFile);
  }
} catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot inspect local profile metadata; resolve it before publishing.'); }
const failures = [];
const blockedPath = /(^|\/)(data|\.runtime|\.ssh|node_modules|dist|screenshots|coverage)\/|(^|\/)(?:\.env(?:\..+)?|profiles\.json.*|known_hosts.*|connection\.json|ui\.json|id_rsa.*|id_ed25519.*|codex-clipboard-.*)$|\.(?:pem|key|ppk|pfx|p12|bak|log|zip|7z|docx)$/i;
const secrets = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\b(?:agentToken|uiToken|encryptedPassword)\s*["']?\s*:\s*["'][A-Za-z0-9+/=]{32,}["']/,
];
for (const file of files) {
  if (blockedPath.test(file) && file !== '.env.example') { failures.push(`${file}: private/artifact path`); continue; }
  const text = git(['show', ':' + file]);
  if (text.includes('\0')) { failures.push(`${file}: binary file needs separate review`); continue; }
  if (secrets.some(pattern => pattern.test(text))) failures.push(`${file}: possible credential material`);
  const normalized = text.replaceAll('\\\\', '\\').toLowerCase();
  if (privateValues.some(value => normalized.includes(value.toLowerCase()))) failures.push(`${file}: local host or personal path`);
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`PASS: ${files.length} Git-index files checked; no blocked paths or recognized private values. Manual review remains required.`);
