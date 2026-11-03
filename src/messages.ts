import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AgentIdentity } from './agents.js';

export type UserMessage = {
  id: string; sessionId: string; target: AgentIdentity; source: 'user';
  text: string; createdAt: string; acknowledgedAt?: string;
};
export class Messages extends EventEmitter {
  private items = new Map<string, UserMessage[]>();
  revision = 0;
  changed() { this.revision++; this.emit('change'); }
  list(sessionId: string) { return (this.items.get(sessionId) ?? []).map(m => ({ ...m, target: { ...m.target } })); }
  send(sessionId: string, target: AgentIdentity, text: string) {
    const rows = this.items.get(sessionId) ?? [];
    if (rows.length >= 100) throw new Error('消息已达 100 条，请先清空该会话的消息历史');
    const message: UserMessage = { id: randomUUID(), sessionId, target: { ...target }, source: 'user', text, createdAt: new Date().toISOString() };
    this.items.set(sessionId, [...rows, message]); this.changed(); return { ...message };
  }
  read(agentId: string, allowed: (sessionId: string) => boolean, sessionId?: string, unreadOnly = false) {
    return [...this.items.values()].flat().filter(m => (!unreadOnly || !m.acknowledgedAt) && m.target.id === agentId && (!sessionId || m.sessionId === sessionId) && allowed(m.sessionId)).map(m => ({ ...m, target: { ...m.target } }));
  }
  unread(agentId: string, allowed: (sessionId: string) => boolean, sessionId?: string) { return this.read(agentId, allowed, sessionId, true); }
  acknowledge(agentId: string, sessionId: string, ids: string[]) {
    const rows = this.items.get(sessionId) ?? [];
    if (ids.some(id => !rows.some(m => m.id === id && m.target.id === agentId))) throw new Error('消息不存在或不属于当前 Agent');
    for (const m of rows) if (ids.includes(m.id) && !m.acknowledgedAt) m.acknowledgedAt = new Date().toISOString();
    this.changed();
  }
  clear(sessionId: string) { this.items.delete(sessionId); this.changed(); }
  async wait(after: number, waitMs: number, signal?: AbortSignal) {
    if (after !== this.revision || !waitMs || signal?.aborted) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.off('change', finish); signal?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, Math.min(waitMs, 15000));
      this.on('change', finish); signal?.addEventListener('abort', finish, { once: true });
      if (after !== this.revision || signal?.aborted) finish();
    });
  }
}
