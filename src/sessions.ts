import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { Profile } from './profiles.js';
import type { AgentIdentity } from './agents.js';

export interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  clear?(): void;
  onData(fn: (data: string) => void): unknown;
  onExit(fn: (event: { exitCode: number }) => void): unknown;
}
type Lock = { kind: 'user' | 'agent'; owner: string; lease: string; agent?: AgentIdentity };

export class Session extends EventEmitter {
  readonly id = randomUUID();
  readonly createdAt = new Date().toISOString();
  readonly terminal: InstanceType<typeof headless.Terminal>;
  readonly serializer = new serialize.SerializeAddon();
  readonly createdBy: { kind: 'user' | 'agent'; agent?: AgentIdentity };
  assignedTo: AgentIdentity | null;
  status: 'open' | 'closed' = 'open';
  privateMode = false;
  lock: Lock | null;
  revision = 0;
  cols = 100;
  rows = 30;
  sequence = 0;
  historyEpoch = 0;
  private renderedSequence = 0;
  private renderQueue: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(readonly profile: Profile, readonly pty: Pty, owner: string, creator?: AgentIdentity) {
    super();
    this.createdBy = Object.freeze(creator ? { kind: 'agent' as const, agent: { ...creator } } : { kind: 'user' as const });
    this.assignedTo = creator ? { ...creator } : null;
    this.lock = creator ? null : { kind: 'user', owner, lease: randomUUID() };
    // The sole retained content buffer. UI and MCP use this same terminal,
    // including its bounded scrollback; there is no raw output log.
    this.terminal = new headless.Terminal({ cols: this.cols, rows: this.rows, scrollback: 2000, allowProposedApi: true });
    this.terminal.loadAddon(this.serializer);
    this.terminal.parser.registerCsiHandler({ final: 'J' }, params => {
      if (params[0] === 3) this.historyEpoch++;
      return false;
    });
    pty.onData(data => this.output(data));
    pty.onExit(({ exitCode }) => {
      this.status = 'closed'; this.lock = null; this.changed(); this.emit('exit', exitCode);
    });
  }
  summary(agentId?: string) {
    const publicLock = this.lock ? (({ lease, ...rest }) => rest)(this.lock) : null;
    return { id: this.id, name: this.profile.name, host: this.profile.host, port: this.profile.port,
      loginUser: this.profile.username, status: this.status, privateMode: this.privateMode,
      lock: publicLock, createdBy: this.createdBy, assignedTo: this.assignedTo,
      ...(agentId ? { isMine: this.assignedTo?.id === agentId } : {}),
      revision: this.revision, cols: this.cols, rows: this.rows, createdAt: this.createdAt,
      sequence: this.sequence, historyEpoch: this.historyEpoch };
  }
  private changed() { this.revision++; this.emit('state', this.summary()); }
  private ensureOpen() { if (this.status !== 'open') throw new Error('SSH 会话已关闭'); }
  private ensurePublic() { if (this.privateMode) throw new Error('私密模式已开启，Agent 无权观察或输入'); }
  requireAssignee(actor: AgentIdentity) {
    if (this.assignedTo?.id !== actor.id) throw new Error('会话未交接给当前 Agent；请在用户指定 sessionId 后显式调用 attach_session');
  }
  attach(actor: AgentIdentity) {
    this.ensurePublic();
    if (this.assignedTo?.id === actor.id) return;
    if (this.lock?.kind === 'agent') throw new Error('另一 Agent 正在操作；请用户先接管输入，再交接');
    // An observer may attach while the user is typing or running top. Input
    // stays locked to that user until the holder explicitly releases it.
    this.assignedTo = { ...actor }; this.changed();
  }
  returnToUser(owner: string) { this.takeover(owner); this.assignedTo = null; this.changed(); }
  private output(data: string) {
    const seq = ++this.sequence;
    this.renderQueue = this.renderQueue.then(() => new Promise<void>(resolve => {
      this.terminal.write(data, () => {
        this.renderedSequence = seq;
        this.emit('output', { data, private: this.privateMode, seq, uiSeq: seq });
        this.emit('public-output', seq); resolve();
      });
    }));
  }
  userInput(owner: string, data: string, revision: number) {
    this.ensureOpen();
    if (revision !== this.revision) throw new Error('终端状态已变化，请重新输入');
    if (this.lock && (this.lock.kind !== 'user' || this.lock.owner !== owner)) throw new Error('终端正由另一方操作，请先接管输入权');
    if (!this.lock) this.lock = { kind: 'user', owner, lease: randomUUID() };
    this.pty.write(data); this.changed();
  }
  takeover(owner: string) {
    this.ensureOpen();
    this.lock = { kind: 'user', owner, lease: randomUUID() }; this.changed();
  }
  setPrivacy(privateMode: boolean) { this.privateMode = privateMode; this.changed(); }
  setPrivate(_owner: string) { this.setPrivacy(true); }
  releaseUser(owner: string) {
    this.ensureOpen();
    if (!this.lock || this.lock.kind !== 'user' || this.lock.owner !== owner) throw new Error('当前页面未持有输入权，不能释放');
    this.lock = null; this.changed();
  }
  releaseAgent(lease: string, actor: AgentIdentity) {
    this.ensureOpen(); this.requireAssignee(actor);
    if (this.lock?.kind !== 'agent' || this.lock.owner !== actor.id || this.lock.lease !== lease) throw new Error('Agent 锁已失效或不属于当前 Agent，不能释放');
    this.lock = null; this.changed();
  }
  acceptControl(actor: AgentIdentity) {
    this.ensureOpen(); this.ensurePublic(); this.requireAssignee(actor);
    if (this.lock) throw new Error('输入权已被占用，请等待持有者释放；Agent 不能抢占输入权');
    this.lock = { kind: 'agent', owner: actor.id, agent: { ...actor }, lease: randomUUID() };
    this.changed();
    return { sessionId: this.id, lease: this.lock.lease,
      instruction: '直接通过 send_input 操作当前终端。先观察画面区分 Shell、密码提示或运行中的程序；完成本次操作后主动 release_control，不会自动释放。' };
  }
  agentInput(data: string, lease: string, actor: AgentIdentity) {
    this.ensureOpen(); this.ensurePublic(); this.requireAssignee(actor);
    if (this.lock?.kind !== 'agent' || this.lock.owner !== actor.id || this.lock.lease !== lease) throw new Error('Agent 锁已失效或被用户接管');
    this.pty.write(data); this.changed();
  }
  terminalReply(data: string) {
    this.ensureOpen();
    if (data.length > 256 || !/^(?:\x1b\[[?>]?[0-9;]{0,40}[cRn]|\x1b\[[IO])+$/.test(data)) throw new Error('无效终端应答');
    this.pty.write(data);
  }
  private async capture<T>(fn: () => T, agent: boolean): Promise<T> {
    if (agent) this.ensurePublic();
    const epoch = this.historyEpoch;
    const view = this.renderQueue.then(fn);
    this.renderQueue = view.then(() => {});
    const result = await view;
    if (agent) this.ensurePublic();
    // A clear occurring while a read was pending invalidates its old result.
    if (agent && epoch !== this.historyEpoch) return this.capture(fn, true);
    return result;
  }
  async read(after = 0) {
    return this.capture(() => {
      const buffer = this.terminal.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
      return { sequence: this.renderedSequence, historyEpoch: this.historyEpoch, mode: 'terminal_snapshot',
        truncated: false, replaced: after !== 0 && after !== this.renderedSequence,
        chunks: after === this.renderedSequence ? [] : [{ seq: this.renderedSequence, data: lines.join('\n') }],
        buffer: buffer.type, retainedLines: buffer.length };
    }, true);
  }
  async screen(agent = true) {
    return this.capture(() => {
      const buffer = this.terminal.buffer.active, lines: string[] = [];
      for (let y = buffer.baseY; y < buffer.baseY + this.rows; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
      return { text: lines.join('\n'), cols: this.cols, rows: this.rows, cursorX: buffer.cursorX, cursorY: buffer.cursorY,
        historyEpoch: this.historyEpoch, sequence: this.renderedSequence, buffer: buffer.type };
    }, agent);
  }
  snapshot() {
    return this.capture(() => ({ data: this.serializer.serialize(), sequence: this.renderedSequence, cols: this.terminal.cols, rows: this.terminal.rows }), false);
  }
  async clearHistory() {
    if (this.status === 'open') this.pty.clear?.();
    const seq = ++this.sequence; this.historyEpoch++;
    this.renderQueue = this.renderQueue.then(async () => {
      const alternate = this.terminal.buffer.active.type === 'alternate';
      this.terminal.reset();
      if (alternate) await new Promise<void>(resolve => this.terminal.write('\x1b[?1049h', resolve));
      this.renderedSequence = seq;
      this.emit('reset', { data: this.serializer.serialize(), seq, uiSeq: seq, cols: this.cols, rows: this.rows });
      this.emit('public-output', seq);
    });
    await this.renderQueue; this.changed();
  }
  resize(cols: number, rows: number) {
    this.ensureOpen(); this.cols = cols; this.rows = rows; this.pty.resize(cols, rows);
    const seq = ++this.sequence;
    this.renderQueue = this.renderQueue.then(() => {
      this.terminal.resize(cols, rows); this.renderedSequence = seq;
      this.emit('resize', { cols, rows, seq, uiSeq: seq }); this.emit('public-output', seq); this.changed();
    });
  }
  close() { if (this.status === 'open' && !this.closing) { this.closing = true; this.pty.kill(); } }
}
