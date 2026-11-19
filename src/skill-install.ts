import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, createScanner, getNodeValue, modify, parseTree, SyntaxKind, type Node, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { installRoot } from './paths.js';
import { RuntimeError } from './service-runtime.js';

export const agentNames = ['codex', 'claude', 'cursor'] as const;
type Agent = typeof agentNames[number];
type RecordValue = Record<string, unknown>;
type Format = 'toml' | 'json' | 'jsonc';
type Client = { agent: Agent; config: string; skill: string; format: Format };
type Change = { file: string; before?: string; after?: string; backup?: boolean };
const name = 'shared-ssh-terminal';
const serverName = 'shared_ssh_terminal';
const marker = '# Managed by shared-ssh-terminal install-skill';
const entrySchema = z.object({
  config: z.string().min(1), entry: z.record(z.string(), z.unknown()), configExisted: z.boolean(), namespaceExisted: z.boolean(),
}).strict();
const installerSchema = z.object({
  version: z.literal(1), skillHash: z.string().regex(/^[a-f0-9]{64}$/),
  clients: z.object({ codex: entrySchema.optional(), claude: entrySchema.optional(), cursor: entrySchema.optional() }).strict(),
}).strict();
type Receipt = z.infer<typeof entrySchema>;
type Ownership = z.infer<typeof installerSchema>;
const sha = (source: string) => createHash('sha256').update(source).digest('hex');
const own = (data: RecordValue | undefined, key: string) => data && Object.hasOwn(data, key) ? data[key] : undefined;

function asRecord(data: unknown): RecordValue {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.prototype.toString.call(data) !== '[object Object]') {
    throw new Error('配置值必须为对象');
  }
  return data as RecordValue;
}

function targets(agents: Agent[], env: NodeJS.ProcessEnv): Client[] {
  const alternate = env.SHARED_SSH_INSTALL_HOME;
  const userDirectory = alternate === undefined ? homedir() : path.resolve(alternate);
  if (alternate !== undefined && !path.isAbsolute(alternate)) throw new RuntimeError('SHARED_SSH_INSTALL_HOME 必须是模拟用户目录的绝对路径。');
  const codex = path.resolve((alternate === undefined && env.CODEX_HOME) || path.join(userDirectory, '.codex'));
  const customClaude = alternate === undefined && env.CLAUDE_CONFIG_DIR;
  const claude = path.resolve(customClaude || path.join(userDirectory, '.claude'));
  const sharedSkills = path.join(userDirectory, '.agents', 'skills', name);
  const clients: Record<Agent, Client> = {
    codex: { agent: 'codex', config: path.join(codex, 'config.toml'), skill: sharedSkills, format: 'toml' },
    claude: { agent: 'claude', config: path.join(customClaude ? claude : userDirectory, '.claude.json'), skill: path.join(claude, 'skills', name), format: 'json' },
    cursor: { agent: 'cursor', config: path.join(userDirectory, '.cursor', 'mcp.json'), skill: sharedSkills, format: 'jsonc' },
  };
  return agents.map(agent => clients[agent]);
}

async function readOptional(file: string) {
  try {
    if (!(await lstat(file)).isFile()) throw new RuntimeError(`预期为常规文件，请先检查 ${file}`);
    const bytes = await readFile(file);
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new RuntimeError(`文件不是有效的 UTF-8，请检查 ${file}`); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function checkDuplicateKeys(node: Node) {
  if (node.type === 'object') {
    const children = node.children ?? [];
    if (new Set(children.map(child => child.children?.[0].value)).size !== children.length) throw new Error('重复的配置键');
  }
  for (const child of node.children ?? []) checkDuplicateKeys(child);
}

function readConfig(client: Client, source: string) {
  const body = source.replace(/^\uFEFF/, '');
  try {
    const key = client.format === 'toml' ? 'mcp_servers' : 'mcpServers';
    let root: RecordValue;
    if (client.format === 'toml') root = asRecord(parseToml(body));
    else {
      const errors: ParseError[] = [];
      const tree = parseTree(body, errors, { disallowComments: client.format === 'json', allowTrailingComma: client.format === 'jsonc' });
      if (!tree || errors.length) throw new Error('配置格式无效');
      checkDuplicateKeys(tree);
      root = asRecord(getNodeValue(tree));
    }
    const container = own(root, key);
    const servers = container === undefined ? undefined : asRecord(container);
    const entry = own(servers, serverName);
    return { root, key, servers, entry: entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : entry };
  } catch {
    throw new RuntimeError(`${client.agent} 配置格式无效或 MCP 表结构不受支持。请检查 ${client.config} 后重试。`);
  }
}

function withoutEntry(config: ReturnType<typeof readConfig>) {
  const other = { ...config.root };
  const servers = { ...config.servers };
  delete servers[serverName];
  if (Object.keys(servers).length) other[config.key] = servers;
  else delete other[config.key];
  return other;
}

function comments(source: string) {
  const scanner = createScanner(source);
  const result: string[] = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) {
      result.push(source.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()));
    }
  }
  return result;
}

function tomlBlock(entry: RecordValue, nl: string) {
  return ['', marker, `[mcp_servers.${serverName}]`, ...Object.entries(entry).map(([key, value]) =>
    `${key} = ${JSON.stringify(value)}`), marker + ' (end)', ''].join(nl);
}

function changeConfig(client: Client, before: string | undefined, receipt: Receipt | undefined, entry: RecordValue | undefined) {
  const source = before ?? (client.format === 'toml' ? '' : '{}\n');
  const parsed = readConfig(client, source);
  const current = parsed.entry;
  if (current !== undefined && (!receipt || !isDeepStrictEqual(current, receipt.entry))) {
    throw new RuntimeError(`${client.agent} 的 ${serverName} 未由本安装器登记或已编辑。请备份并核对 ${client.config}，然后处理同名条目。`);
  }
  if (current === undefined && entry === undefined) return before;
  if (isDeepStrictEqual(current, entry)) return before;
  let next: string;
  if (client.format === 'toml') {
    next = source;
    if (current !== undefined && receipt) {
      const block = ['\r\n', '\n'].map(nl => tomlBlock(receipt.entry, nl)).find(candidate => source.includes(candidate));
      if (!block) throw new RuntimeError(`Codex 登记区块已调整。请核对 ${client.config}，保留需要的自定义内容后手动移除原登记。`);
      next = source.replace(block, '');
    }
    if (entry) next += tomlBlock(entry, source.includes('\r\n') ? '\r\n' : '\n');
  } else {
    const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
    const target = !entry && !receipt?.namespaceExisted && Object.keys(parsed.servers ?? {}).length === 1
      ? [parsed.key] : [parsed.key, serverName];
    const body = source.slice(bom.length);
    next = bom + applyEdits(body, modify(body, target, entry, { formattingOptions: {
      insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n',
    } }));
  }
  const result = readConfig(client, next);
  if (!isDeepStrictEqual(result.entry, entry)) throw new RuntimeError(`无法安全更新 ${client.config} 中的 MCP 登记。`);
  if (!isDeepStrictEqual(withoutEntry(parsed), withoutEntry(result)) ||
      (client.format === 'jsonc' && !isDeepStrictEqual(comments(source), comments(next)))) {
    throw new RuntimeError(`修改 MCP 登记会影响其他配置或注释。请核对 ${client.config} 中的同名条目。`);
  }
  if (!entry && !receipt?.configExisted && (/^\s*$/.test(next) || /^\s*\{\s*\}\s*$/.test(next))) return undefined;
  return next;
}

async function writeChange(file: string, content: string | undefined, expected: string | undefined) {
  const confirm = async () => {
    if (await readOptional(file) !== expected) throw new Error('文件在操作中发生变化');
  };
  if (content === undefined) { await confirm(); await unlink(file); return; }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await confirm();
    await rename(temporary, file);
  }
  finally { await unlink(temporary).catch(() => {}); }
}

async function applyChanges(changes: Change[], beforeChange?: (file: string) => Promise<void>) {
  const backups: string[] = [];
  const applied: Change[] = [];
  let file = '';
  try {
    for (const change of changes) {
      file = change.file;
      await beforeChange?.(file);
      if (await readOptional(file) !== change.before) throw new Error('文件在操作中发生变化');
      if (change.backup && change.before !== undefined) {
        const backup = file + '.before-shared-ssh-' + randomUUID() + '.bak';
        await writeFile(backup, change.before, { flag: 'wx', mode: 0o600 });
        backups.push(backup);
      }
      await writeChange(file, change.after, change.before);
      applied.push(change);
    }
  } catch {
    let restored = true;
    for (const change of applied.reverse()) {
      try {
        await writeChange(change.file, change.before, change.after);
      } catch { restored = false; }
    }
    const recovery = restored ? '已恢复本轮写入。' : '部分文件未能自动恢复，请核对现有文件与备份。';
    throw new RuntimeError(`无法更新 ${file}。${recovery} 请检查文件权限、占用或并发编辑。${backups.length ? '\n备份：' + backups.join('\n') : ''}`);
  }
  return backups;
}

export async function installSkill(operation: 'install' | 'uninstall', agents: Agent[], {
  env = process.env, root = installRoot, beforeChange,
}: { env?: NodeJS.ProcessEnv; root?: string; beforeChange?: (file: string) => Promise<void> } = {}) {
  const clients = targets(agents, env);
  const installing = operation === 'install';
  const cli = path.join(root, 'dist', 'cli.js');
  if (installing && await readOptional(cli) === undefined) throw new RuntimeError('找不到构建后的 CLI。请先运行 npm run build 或从本地包装安装。');
  const wrapper = installing ? await readFile(path.join(root, 'skill', 'SKILL.md'), 'utf8') : undefined;
  const changes: Change[] = [];
  const groups = new Map<string, Client[]>();
  for (const client of clients) {
    const group = groups.get(client.skill);
    if (group) group.push(client);
    else groups.set(client.skill, [client]);
  }
  for (const [directory, group] of groups) {
    const skill = path.join(directory, 'SKILL.md');
    const receiptFile = path.join(directory, '.shared-ssh-terminal-install.json');
    const oldSkill = await readOptional(skill);
    const oldReceipt = await readOptional(receiptFile);
    let owned: Ownership | undefined;
    if (oldReceipt !== undefined) {
      try { owned = installerSchema.parse(JSON.parse(oldReceipt)); }
      catch { throw new RuntimeError(`安装归属记录无效。请核对 ${receiptFile} 后重试。`); }
    }
    if (oldSkill !== undefined && (!owned || owned.skillHash !== sha(oldSkill))) {
      if (installing || group.some(client => owned?.clients[client.agent])) {
        throw new RuntimeError(`技能文件已存在或已编辑。请先备份并核对 ${skill}。`);
      }
    }
    const nextClients = { ...owned?.clients };
    for (const client of group) {
      const saved = owned?.clients[client.agent];
      if (!installing && !saved) continue;
      if (saved && path.relative(saved.config, client.config) !== '') {
        throw new RuntimeError(`${client.agent} 的接续配置目录已变化。请使用原配置目录先撤销登记：${saved.config}`);
      }
      const before = await readOptional(client.config);
      const entry = installing ? { ...(client.agent === 'claude' ? { type: 'stdio' } : {}),
        command: process.execPath, args: [cli, 'mcp'] } : undefined;
      const after = changeConfig(client, before, saved, entry);
      if (before !== after) changes.push({ file: client.config, before, after, backup: true });
      if (entry) {
        nextClients[client.agent] = saved ? { ...saved, entry } : { config: client.config, entry, configExisted: before !== undefined,
          namespaceExisted: before !== undefined && readConfig(client, before).servers !== undefined };
      } else delete nextClients[client.agent];
    }
    if (!installing && !owned) continue;
    const keep = Object.keys(nextClients).length > 0;
    const newSkill = keep ? wrapper ?? oldSkill : undefined;
    const nextReceipt = keep ? {
      version: 1, skillHash: newSkill === undefined ? owned!.skillHash : sha(newSkill),
      clients: Object.fromEntries(agentNames.flatMap(agent => nextClients[agent] ? [[agent, nextClients[agent]]] : [])),
    } : undefined;
    const encoded = nextReceipt ? JSON.stringify(nextReceipt, null, 2) + '\n' : undefined;
    if (newSkill !== oldSkill && (owned || installing)) changes.push({ file: skill, before: oldSkill, after: newSkill });
    if (encoded !== oldReceipt) changes.push({ file: receiptFile, before: oldReceipt, after: encoded });
  }
  return { agents, changed: changes.length, backups: await applyChanges(changes, beforeChange) };
}
