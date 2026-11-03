import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('publication guard checks staged bytes and rejects secrets or runtime files even when the worktree is clean', async () => {
  const runtime = path.join(root, '.runtime'); await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(path.join(runtime, 'publish-guard-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, windowsHide: true, stdio: 'pipe' });
  const check = () => spawnSync(process.execPath, [path.join(root, 'scripts/check-publish.mjs')], { cwd: directory, windowsHide: true, encoding: 'utf8' });
  try {
    git('init'); await writeFile(path.join(directory, 'source.txt'), 'public source'); git('add', 'source.txt'); assert.equal(check().status, 0);
    const fakeToken = 'ghp_' + 'X'.repeat(36);
    await writeFile(path.join(directory, 'source.txt'), fakeToken); git('add', 'source.txt');
    await writeFile(path.join(directory, 'source.txt'), 'clean worktree, secret still staged');
    const failed = check(); assert.notEqual(failed.status, 0); assert(!failed.stderr.includes(fakeToken));
    git('add', 'source.txt'); assert.equal(check().status, 0);
    await mkdir(path.join(directory, '.runtime')); await writeFile(path.join(directory, '.runtime/ui.json'), '{}');
    git('add', '.runtime/ui.json'); assert.notEqual(check().status, 0);
  } finally {
    const resolved = path.resolve(directory);
    assert(resolved.startsWith(path.resolve(runtime) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  }
});
