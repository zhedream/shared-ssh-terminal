import { readFile, glob } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { profileSchema } from './profiles.js';

export function words(line: string): string[] {
  let text = '', quote = '';
  for (const char of line.trim()) {
    if (char === '#' && !quote) break;
    if ((char === '"' || char === "'") && (!quote || quote === char)) quote = quote ? '' : char;
    text += char;
  }
  return (text.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(v => /^["']/.test(v) ? v.slice(1, -1) : v);
}
function matches(alias: string, patterns: string[]) {
  const match = (pattern: string) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$', 'i').test(alias);
  return patterns.some(p => !p.startsWith('!') && match(p)) && !patterns.some(p => p.startsWith('!') && match(p.slice(1)));
}
function expandHome(file: string, home: string) {
  return file === '~' ? home : /^~[/\\]/.test(file) ? path.join(home, file.slice(2)) : file;
}
export function parseConfig(text: string, home = homedir()) {
  const sections: { patterns: string[]; values: Map<string, string[]>; conditional: boolean }[] = [];
  let current = { patterns: ['*'], values: new Map<string, string[]>(), conditional: false };
  sections.push(current);
  const aliases = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const tokens = words(line.replace(/^(\s*[^\s=]+)\s*=\s*/, '$1 '));
    if (!tokens.length) continue;
    const key = tokens.shift()!.toLowerCase();
    if (key === 'host' || key === 'match') {
      current = { patterns: tokens, values: new Map(), conditional: key === 'match' }; sections.push(current);
      if (key === 'host') for (const alias of tokens) if (/^[a-zA-Z0-9_.:\-]+$/.test(alias) && !alias.startsWith('-')) aliases.add(alias);
    } else {
      const values = current.values.get(key) ?? []; values.push(tokens.join(' ')); current.values.set(key, values);
    }
  }
  return [...aliases].map(alias => {
    const values = new Map<string, string[]>();
    for (const section of sections) {
      if (section.conditional || !matches(alias, section.patterns)) continue;
      for (const [key, entries] of section.values) {
        if (key === 'identityfile') values.set(key, [...(values.get(key) ?? []), ...entries]);
        else if (!values.has(key)) values.set(key, entries);
      }
    }
    const get = (key: string) => values.get(key)?.[0];
    const host = get('hostname') || alias, username = get('user') || '';
    let identityFile = get('identityfile');
    if (identityFile === 'none') identityFile = undefined;
    if (identityFile) identityFile = expandHome(identityFile.replaceAll('%d', home).replaceAll('%h', host).replaceAll('%r', username).replaceAll('%%', '%'), home);
    const profile = { name: alias, host, port: Number(get('port') || 22), username,
      auth: identityFile ? 'key' as const : 'agent' as const,
      ...(identityFile ? { identityFile } : {}), note: '从 SSH config 快速添加；导入后独立维护' };
    const parsed = profileSchema.safeParse(profile);
    const notes: string[] = [];
    if (sections.some(s => s.conditional)) notes.push('Match 条件未求值');
    if (get('proxyjump') || get('proxycommand')) notes.push('未复制代理 / 跳板选项');
    if ((values.get('identityfile')?.length ?? 0) > 1) notes.push('仅取第一个 IdentityFile');
    if (!username) notes.push('未指定 User，请导入后填写');
    return { alias, profile, valid: parsed.success, notes, error: parsed.success ? null : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
  });
}

export async function readSshConfig(home = homedir()) {
  const configPath = path.join(home, '.ssh', 'config');
  let count = 0;
  const active = new Set<string>();
  const includeNotes: string[] = [];
  async function read(file: string, depth: number): Promise<string> {
    if (depth > 8 || ++count > 128) throw new Error('SSH config 的 Include 层级或文件数过多');
    const absolute = path.resolve(file);
    if (active.has(absolute)) throw new Error('SSH config 的 Include 存在循环');
    active.add(absolute);
    try {
      const text = await readFile(absolute, 'utf8');
      if (text.length > 1024 * 1024) throw new Error('SSH config 文件过大');
      const lines: string[] = [];
      for (const line of text.split(/\r?\n/)) {
        const tokens = words(line.replace(/^(\s*[^\s=]+)\s*=\s*/, '$1 '));
        if (tokens[0]?.toLowerCase() !== 'include') { lines.push(line); continue; }
        for (const pattern of tokens.slice(1)) {
          if (pattern.includes('%') || pattern.includes('${')) { includeNotes.push('含变量的 Include 未展开'); continue; }
          const expanded = expandHome(pattern, home);
          const absolutePattern = (path.isAbsolute(expanded) ? expanded : path.join(home, '.ssh', expanded)).replaceAll('\\', '/');
          const files: string[] = [];
          for await (const match of glob(absolutePattern)) files.push(match);
          for (const match of files.sort()) lines.push(await read(match, depth + 1));
        }
      }
      return lines.join('\n');
    } finally { active.delete(absolute); }
  }
  const text = await read(configPath, 0);
  return { configPath, candidates: parseConfig(text, home), notes: [...new Set(includeNotes)],
    description: '仅复制 HostName、User、Port 和首个 IdentityFile；导入后独立维护，不修改或自动同步原文件。' };
}
