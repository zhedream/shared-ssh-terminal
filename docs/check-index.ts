import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(directory, e.name)) : e.name.endsWith('.md') ? [path.join(directory, e.name)] : []);
}
const docs = [...walk(path.join(root, 'docs')), ...walk(path.join(root, 'src')), ...['README.md', 'AGENTS.md', 'CLAUDE.md'].map(f => path.join(root, f))];
const index = path.join(root, 'docs/README.md');
function links(file: string) { return [...readFileSync(file, 'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]).filter(s => !/^(https?:|#)/.test(s)).map(s => path.resolve(path.dirname(file), s.split('#')[0])); }
const indexed = new Set(links(index));
const errors: string[] = [];
for (const file of docs) {
  if (file !== index && !indexed.has(file)) errors.push('未索引：' + path.relative(root, file));
  for (const target of links(file)) if (!existsSync(target)) errors.push('无效引用：' + path.relative(root, file) + ' → ' + path.relative(root, target));
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`PASS: ${docs.length} documents indexed; relative links resolve.`);
