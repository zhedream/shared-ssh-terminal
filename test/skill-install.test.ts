import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { installRoot } from '../src/paths.js';
import { agentNames, installSkill } from '../src/skill-install.js';

async function fixture(t: TestContext) {
  const prefix = path.resolve(tmpdir(), 'sst-skill-');
  const temp = await mkdtemp(prefix);
  t.after(async () => {
    const resolved = path.resolve(temp);
    assert(resolved.startsWith(prefix) && path.dirname(resolved) === path.dirname(prefix));
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  });
  const user = path.join(temp, 'simulated user');
  const root = path.join(temp, 'local package');
  const cli = path.join(root, 'dist', 'cli.js');
  await mkdir(path.dirname(cli), { recursive: true });
  await mkdir(path.join(root, 'skill'), { recursive: true });
  await writeFile(cli, '');
  await copyFile(path.join(installRoot, 'skill', 'SKILL.md'), path.join(root, 'skill', 'SKILL.md'));
  const configs = {
    codex: path.join(user, '.codex', 'config.toml'),
    claude: path.join(user, '.claude.json'),
    cursor: path.join(user, '.cursor', 'mcp.json'),
  };
  const sharedSkill = path.join(user, '.agents', 'skills', 'shared-ssh-terminal', 'SKILL.md');
  const claudeSkill = path.join(user, '.claude', 'skills', 'shared-ssh-terminal', 'SKILL.md');
  const options = { root, env: { SHARED_SSH_INSTALL_HOME: user, CODEX_HOME: path.join(temp, 'ignored-codex'),
    CLAUDE_CONFIG_DIR: path.join(temp, 'ignored-claude') } };
  async function seed(file: string, content: string) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { user, configs, cli, sharedSkill, claudeSkill, options, seed };
}

const missing = (file: string) => assert.rejects(access(file), { code: 'ENOENT' });
const all = [...agentNames];
const serverName = 'shared_ssh_terminal';

test('each client installs, repeats and uninstalls from a simulated home', async t => {
  for (const agent of all) {
    const f = await fixture(t);
    const file = f.configs[agent];
    assert.equal((await installSkill('install', [agent], f.options)).changed, 3);
    const read = await readFile(file, 'utf8');
    const entry = agent === 'codex' ? (parseToml(read).mcp_servers as any)[serverName] : parseJsonc(read).mcpServers[serverName];
    assert.equal(entry.command, process.execPath);
    assert.deepEqual(entry.args, [f.cli, 'mcp']);
    if (agent === 'claude') assert.equal(entry.type, 'stdio');
    const skill = agent === 'claude' ? f.claudeSkill : f.sharedSkill;
    assert.match(await readFile(skill, 'utf8'), /shared-ssh-terminal skill/);
    assert.deepEqual(await installSkill('install', [agent], f.options), { agents: [agent], changed: 0, backups: [] });
    const removed = await installSkill('uninstall', [agent], f.options);
    assert.equal(removed.backups.length, 1);
    assert.equal(await readFile(removed.backups[0], 'utf8'), read);
    await missing(file);
    await missing(skill);
    assert.equal((await installSkill('uninstall', [agent], f.options)).changed, 0);
  }
});

test('existing settings, comments and changes made after installation survive uninstall', async t => {
  const f = await fixture(t);
  const codex = '# original\r\nmodel = "example"\r\n[mcp_servers.other]\r\ncommand = "other"';
  const claude = '{"projects": {"fixture": {"mcpServers": {"keep": {"command": "fixture"}}}}, "mcpServers": {}}\n';
  const cursor = '{\n  // preserve this\n  "mcpServers": { "existing": { "command": "other" }, },\n}\n';
  await f.seed(f.configs.codex, codex);
  await f.seed(f.configs.claude, claude);
  await f.seed(f.configs.cursor, cursor);
  const installed = await installSkill('install', all, f.options);
  assert.deepEqual(new Set(await Promise.all(installed.backups.map(file => readFile(file, 'utf8')))), new Set([codex, claude, cursor]));
  const current = await readFile(f.configs.codex, 'utf8');
  await writeFile(f.configs.codex, current.replace('model = "example"', 'model = "updated"'));
  await installSkill('uninstall', ['codex'], f.options);
  await access(f.sharedSkill);
  assert.equal(await readFile(f.configs.codex, 'utf8'), codex.replace('"example"', '"updated"'));
  await installSkill('uninstall', ['claude', 'cursor'], f.options);
  await missing(f.sharedSkill);
  await missing(f.claudeSkill);
  assert.deepEqual(JSON.parse(await readFile(f.configs.claude, 'utf8')), JSON.parse(claude));
  const cursorAfter = await readFile(f.configs.cursor, 'utf8');
  assert.match(cursorAfter, /preserve this/);
  assert.deepEqual(parseJsonc(cursorAfter), parseJsonc(cursor));
});

test('all checks invalid formats and unowned registration before touching another client', async t => {
  const f = await fixture(t);
  await f.seed(f.configs.cursor, '{"mcpServers":');
  await assert.rejects(installSkill('install', all, f.options), /cursor 配置格式无效/);
  await missing(f.configs.codex);
  await missing(f.configs.claude);
  const conflict = '{"mcpServers":{"shared_ssh_terminal":{"command":"existing"}}}\n';
  await f.seed(f.configs.cursor, conflict);
  await assert.rejects(installSkill('install', all, f.options), /未由本安装器登记/);
  assert.equal((await installSkill('uninstall', all, f.options)).changed, 0);
  assert.equal(await readFile(f.configs.cursor, 'utf8'), conflict);
  await f.seed(f.configs.cursor, '{}');
  await f.seed(f.configs.codex, '[broken');
  await assert.rejects(installSkill('install', all, f.options), /codex 配置格式无效/);
  await f.seed(f.configs.codex, '');
  await f.seed(f.configs.claude, '{"mcpServers": {}, "mcpServers": {}}');
  await assert.rejects(installSkill('install', all, f.options), /claude 配置格式无效/);
  await missing(f.sharedSkill);
});

test('uninstall keeps a changed registration and an edited wrapper', async t => {
  const f = await fixture(t);
  await installSkill('install', ['cursor'], f.options);
  const installed = await readFile(f.configs.cursor, 'utf8');
  const edited = installed.replace('"mcp"', '"custom"');
  await writeFile(f.configs.cursor, edited);
  await assert.rejects(installSkill('uninstall', ['cursor'], f.options), /已编辑/);
  assert.equal(await readFile(f.configs.cursor, 'utf8'), edited);
  await writeFile(f.configs.cursor, installed);
  await writeFile(f.sharedSkill, 'user-edited skill');
  await assert.rejects(installSkill('uninstall', ['cursor'], f.options), /技能文件已存在或已编辑/);
  assert.equal(await readFile(f.sharedSkill, 'utf8'), 'user-edited skill');
});

test('mid-batch failures roll back install and uninstall and retain recoverable backups', async t => {
  const f = await fixture(t);
  const original = '# existing\nmodel = "example"\n';
  await f.seed(f.configs.codex, original);
  const failOnClaude = async (file: string) => { if (file === f.configs.claude) throw new Error('simulated filesystem failure'); };
  await assert.rejects(installSkill('install', all, { ...f.options, beforeChange: failOnClaude }), /已恢复本轮写入/);
  assert.equal(await readFile(f.configs.codex, 'utf8'), original);
  await missing(f.configs.cursor);
  await missing(f.sharedSkill);
  await missing(f.configs.claude);
  const entries = await readdir(path.dirname(f.configs.codex));
  assert.equal(entries.filter(name => name.endsWith('.bak')).length, 1);
  assert.equal(entries.some(name => name.endsWith('.tmp')), false);

  await installSkill('install', all, f.options);
  const installed = await Promise.all(Object.values(f.configs).map(file => readFile(file, 'utf8')));
  await assert.rejects(installSkill('uninstall', all, { ...f.options, beforeChange: failOnClaude }), /已恢复本轮写入/);
  assert.deepEqual(await Promise.all(Object.values(f.configs).map(file => readFile(file, 'utf8'))), installed);
  assert.equal((await installSkill('install', all, f.options)).changed, 0);
  await installSkill('uninstall', all, f.options);
});
