import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeRuntimeJson } from './local-network.js';

export const runName = z.string().trim().min(1).max(80);
export const localDirectory = z.string().min(1).max(2048).refine(value => value.trim() !== '' && !/[\0\r\n]/.test(value), '请输入有效的本地目录');
export const runCommand = z.string().min(1).max(4096).refine(value => value.trim() !== '' && !value.includes('\0'), '请输入 PowerShell 命令');
export const startKey = z.string().min(1).max(128);
export const openLocalInput = { cwd: localDirectory.optional(), startKey: startKey.optional() };
export const startRunInput = { configId: z.guid().optional(), cwd: localDirectory.optional(), command: runCommand.optional(),
  name: runName.optional(), startKey: startKey.optional() };
export const startRunSchema = z.object(startRunInput).superRefine((value, context) => {
  const inline = value.cwd !== undefined || value.command !== undefined || value.name !== undefined || value.startKey !== undefined;
  if (value.configId ? inline : value.cwd === undefined || value.command === undefined) {
    context.addIssue({ code: 'custom', message: '请选择运行配置，或同时提供启动目录和命令' });
  }
});
const fields = { name: runName, cwd: localDirectory, command: runCommand, note: z.string().max(500).default('') };
const savedSchema = z.strictObject({ ...fields, id: z.guid() });
const inputSchema = z.strictObject({ ...fields, id: z.guid().optional() });
export type RunConfig = z.infer<typeof savedSchema>;

export class RunConfigs {
  private rows: RunConfig[] = [];
  private changes: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(directory: string) { this.file = path.join(directory, 'run-configs.json'); }

  async load() {
    try { this.rows = z.array(savedSchema).parse(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  list() { return this.rows.map(row => ({ ...row })); }
  get(id: string) {
    const row = this.rows.find(config => config.id === id);
    if (!row) throw new Error('运行配置不存在');
    return { ...row };
  }
  private update<T>(apply: () => { rows: RunConfig[]; result: T }) {
    const pending = this.changes.catch(() => {}).then(async () => {
      const { rows, result } = apply();
      await writeRuntimeJson(this.file, rows);
      this.rows = rows;
      return result;
    });
    this.changes = pending;
    return pending;
  }
  save(value: unknown) {
    const parsed = inputSchema.parse(value);
    return this.update(() => {
      const config = { ...parsed, id: parsed.id ?? randomUUID() };
      const rows = this.rows.slice();
      const index = rows.findIndex(row => row.id === config.id);
      if (index >= 0) rows[index] = config;
      else rows.push(config);
      return { rows, result: { ...config } };
    });
  }
  remove(id: string) {
    return this.update(() => ({ rows: this.rows.filter(row => row.id !== id), result: { ok: true } }));
  }
}
