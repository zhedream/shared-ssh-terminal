import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunConfigs, startRunSchema } from '../src/run-configs.js';

test('run configs serialize concurrent changes and reload only declared configuration fields', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sst-run-configs-'));
  try {
    const configs = new RunConfigs(directory);
    await configs.load();
    const config = { name: 'fixture', cwd: directory, command: 'Write-Output fixture' };
    assert.throws(() => configs.save({ ...config, env: { FIXTURE: 'not stored' } }));
    const [first, second] = await Promise.all([configs.save(config), configs.save({ ...config, name: 'second' })]);
    assert.notEqual(first.id, second.id);
    await configs.save({ ...first, note: 'keep only the second' });
    await configs.remove(first.id);
    const reloaded = new RunConfigs(directory);
    await reloaded.load();
    assert.deepEqual(reloaded.list(), [second]);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'run-configs.json'), 'utf8')), [second]);
    assert(!startRunSchema.safeParse({ configId: second.id, command: 'ambiguous' }).success);
    assert(!startRunSchema.safeParse({ cwd: directory }).success);
    assert(startRunSchema.safeParse({ configId: second.id }).success);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
