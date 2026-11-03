import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const agentIdentitySchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  application: z.string().trim().min(1).max(100),
  project: z.string().max(2048).default(''),
  task: z.string().max(200).default('')
}).strict();
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;
const registrationSchema = z.object({ identity: agentIdentitySchema, secret: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class Agents {
  private records = new Map<string, { identity: AgentIdentity; secret: string }>();
  register(value: unknown) {
    const parsed = registrationSchema.parse(value);
    const previous = this.records.get(parsed.identity.id);
    if (previous && !same(previous.secret, parsed.secret)) throw new Error('Agent 身份已被使用');
    if (this.records.size >= 1000 && !previous) throw new Error('Agent 实例过多，请重启空闲服务');
    const record = { identity: Object.freeze({ ...parsed.identity }), secret: parsed.secret };
    this.records.set(parsed.identity.id, record);
    return record.identity;
  }
  authenticate(id: string, secret: string) {
    const record = this.records.get(id);
    if (!record || !same(record.secret, secret)) throw new Error('Agent 实例认证失败，请重新加载 MCP 适配器');
    return record.identity;
  }
}
