import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import type { Profile } from './profiles.js';
import type { AgentIdentity } from './agents.js';
import { TerminalReader, type ReadLimits } from './terminal-reader.js';
import { LocalTerminalError, type LocalLaunch } from './local-terminal.js';

export interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  clear?(): void;
  onData(fn: (data: string) => void): unknown;
  onExit(fn: (event: { exitCode: number }) => void): unknown;
}
type Lock = { kind: 'user' | 'agent'; owner: string; lease: string; agent?: AgentIdentity };
export class HandedToUserError extends Error {
  readonly code = 'handed_to_user';
  constructor() { super('终端已交给用户处理，请等待用户点击「交回 Agent」或主动释放输入权。'); }
}

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
  private handoff: { message: string | null } | null = null;
  revision = 0;
  cols = 100;
  rows = 30;
  sequence = 0;
  historyEpoch = 0;
  private renderedSequence = 0;
  private renderQueue: Promise<void> = Promise.resolve();
  private closing = false;
  private reader = new TerminalReader();
  private bufferVersion = 0;
  private normalOffset = 0;
  private normalGeneration = 0;
  private normalHistoryRevision = 0;
  protected historyTruncated = false;
  protected pty?: Pty;
  private trimMarker?: { marker: { line: number; isDisposed: boolean; dispose(): void }; line: number };

  constructor(readonly profile: Profile | LocalLaunch, pty: Pty | undefined, owner: string, creator?: AgentIdentity) {
    super();
    this.createdBy = Object.freeze(creator ? { kind: 'agent' as const, agent: { ...creator } } : { kind: 'user' as const });
    this.assignedTo = creator ? { ...creator } : null;
    this.lock = creator ? null : { kind: 'user', owner, lease: randomUUID() };
    // The sole retained content buffer. UI and MCP use this same terminal,
    // including its bounded scrollback; there is no raw output log.
    this.terminal = new headless.Terminal({ cols: this.cols, rows: this.rows, scrollback: 2000, allowProposedApi: true });
    this.terminal.loadAddon(this.serializer);
    this.terminal.buffer.onBufferChange(() => { this.bufferVersion++; });
    this.trackTrimming();
    this.terminal.parser.registerCsiHandler({ final: 'J' }, params => {
      if (params[0] === 3) this.historyEpoch++;
      return false;
    });
    if (pty) this.bindPty(pty);
  }
  get kind() { return 'kind' in this.profile ? 'local' as const : 'ssh' as const; }
  get processGeneration(): number | undefined { return undefined; }
  protected bindPty(pty: Pty) {
    this.pty = pty;
    pty.onData(data => { if (this.pty === pty) this.output(data); });
    pty.onExit(({ exitCode }) => {
      if (this.pty !== pty) return;
      this.pty = undefined;
      this.processExited(exitCode);
    });
  }
  protected processExited(exitCode: number) {
    this.status = 'closed'; this.lock = null; this.handoff = null; this.changed(); this.emit('exit', exitCode);
  }
  summary(agentId?: string) {
    const publicLock = this.lock ? (({ lease, ...rest }) => rest)(this.lock) : null;
    const profile = this.profile;
    const target = 'kind' in profile ? { kind: profile.kind } : { kind: 'ssh' as const,
      host: profile.host, port: profile.port, loginUser: profile.username, startupDir: profile.startupDir };
    return { id: this.id, name: profile.name, ...target, status: this.status, privateMode: this.privateMode,
      lock: publicLock, createdBy: this.createdBy, assignedTo: this.assignedTo,
      handoff: this.handoff && { message: agentId && (this.privateMode || this.assignedTo?.id !== agentId) ? null : this.handoff.message },
      ...(agentId ? { isMine: this.assignedTo?.id === agentId } : {}),
      revision: this.revision, cols: this.cols, rows: this.rows, createdAt: this.createdAt,
      sequence: this.sequence, historyEpoch: this.historyEpoch };
  }
  protected changed() { this.revision++; this.emit('state', this.summary()); }
  protected livePty() {
    if (!this.pty || this.status !== 'open') throw new Error(this.kind === 'ssh' ? 'SSH 会话已关闭' : '本地终端未运行');
    return this.pty;
  }
  private ensureOpen() { this.livePty(); }
  private ensurePublic() { if (this.privateMode) throw new Error('私密模式已开启，Agent 无权观察或输入'); }
  requireAssignee(actor: AgentIdentity) {
    if (this.assignedTo?.id !== actor.id) throw new Error('会话未交接给当前 Agent；请在用户指定 sessionId 后显式调用 attach_session');
  }
  attach(actor: AgentIdentity) {
    this.ensurePublic();
    if (this.assignedTo?.id === actor.id) return;
    if (this.lock?.kind === 'agent') throw new Error('另一 Agent 正在操作；请用户先接管输入，再交接');
    this.assignedTo = { ...actor };
    if (this.handoff) this.handoff = { message: null };
    this.changed();
  }
  returnToUser(owner: string) {
    this.ensureOpen();
    this.lock = { kind: 'user', owner, lease: randomUUID() };
    this.assignedTo = null;
    if (this.handoff) this.handoff = { message: null };
    this.changed();
  }
  protected output(data: string) {
    const seq = ++this.sequence;
    const generation = this.processGeneration;
    this.renderQueue = this.renderQueue.then(() => new Promise<void>(resolve => {
      const wasNormal = this.terminal.buffer.active.type === 'normal';
      this.terminal.write(data, () => {
        if (wasNormal || String(this.terminal.buffer.active.type) === 'normal') this.normalHistoryRevision++;
        this.trackTrimming();
        this.renderedSequence = seq;
        this.emit('output', { data, private: this.privateMode, seq, uiSeq: seq, generation, normalHistoryRevision: this.normalHistoryRevision });
        this.emit('public-output', seq); resolve();
      });
    }));
  }
  userInput(owner: string, data: string, revision: number) {
    this.ensureOpen();
    if (revision !== this.revision) throw new Error('终端状态已变化，请重新输入');
    if (this.lock && (this.lock.kind !== 'user' || this.lock.owner !== owner)) throw new Error('终端正由另一方操作，请先接管输入权');
    if (!this.lock) this.lock = { kind: 'user', owner, lease: randomUUID() };
    this.livePty().write(data); this.changed();
  }
  takeover(owner: string) {
    this.ensureOpen();
    this.lock = { kind: 'user', owner, lease: randomUUID() }; this.changed();
  }
  setPrivacy(privateMode: boolean) { if (this.privateMode !== privateMode) this.reader.invalidate(); this.privateMode = privateMode; this.changed(); }
  setPrivate(_owner: string) { this.setPrivacy(true); }
  releaseUser(owner: string) {
    this.ensureOpen();
    if (!this.lock || this.lock.kind !== 'user' || this.lock.owner !== owner) throw new Error('当前页面未持有输入权，不能释放');
    this.lock = null; this.handoff = null; this.changed();
  }
  returnToAgent(owner: string, revision: number) {
    this.ensureOpen();
    if (revision !== this.revision) throw new Error('终端状态已变化，请重新交回');
    if (!this.handoff || !this.assignedTo) throw new Error('当前会话没有可交回的关联 Agent');
    if (this.lock && (this.lock.kind !== 'user' || this.lock.owner !== owner)) {
      throw new Error('只有持有输入权的页面可交回 Agent');
    }
    this.lock = null; this.handoff = null; this.changed();
  }
  releaseAgent(lease: string, actor: AgentIdentity) {
    this.ensureOpen(); this.requireAssignee(actor);
    if (this.lock?.kind !== 'agent' || this.lock.owner !== actor.id || this.lock.lease !== lease) throw new Error('Agent 锁已失效或不属于当前 Agent，不能释放');
    this.lock = null; this.changed();
  }
  acceptControl(actor: AgentIdentity) {
    this.ensureOpen(); this.ensurePublic(); this.requireAssignee(actor);
    if (this.handoff) throw new HandedToUserError();
    if (this.lock?.kind === 'agent') throw new Error('输入权已被 Agent 占用，请等待持有者释放');
    this.lock = { kind: 'agent', owner: actor.id, agent: { ...actor }, lease: randomUUID() };
    this.changed();
    return { sessionId: this.id, lease: this.lock.lease,
      instruction: '直接通过 send_input 操作当前终端。先观察画面区分 Shell、密码提示或运行中的程序；完成本次操作后主动 release_control，不会自动释放。' };
  }
  handoffToUser(lease: string, actor: AgentIdentity) {
    this.ensureOpen(); this.ensurePublic(); this.requireAssignee(actor);
    if (this.lock?.kind !== 'agent' || this.lock.owner !== actor.id || this.lock.lease !== lease) {
      throw new Error('Agent 锁已失效或不属于当前 Agent，不能交给用户');
    }
    this.lock = null; this.handoff = { message: null }; this.changed();
  }
  requestControlReturn(actor: AgentIdentity, message: string) {
    this.ensureOpen(); this.ensurePublic(); this.requireAssignee(actor);
    if (!this.handoff) throw new Error('当前会话未处于人工交接状态');
    this.handoff = { message }; this.changed();
  }
  agentInput(data: string, lease: string, actor: AgentIdentity) {
    this.requireAgentLease(lease, actor);
    this.livePty().write(data); this.changed();
  }
  requireAgentLease(lease: string, actor: AgentIdentity, lifecycle = false) {
    if (!lifecycle) this.ensureOpen();
    this.ensurePublic(); this.requireAssignee(actor);
    if (lifecycle && this.handoff) throw new HandedToUserError();
    if (lifecycle) this.ensureOpen();
    if (this.lock?.kind !== 'agent' || this.lock.owner !== actor.id || this.lock.lease !== lease) throw new Error('Agent 锁已失效或被用户接管');
  }
  terminalReply(data: string) {
    this.ensureOpen();
    if (data.length > 256 || !/^(?:\x1b\[[?>]?[0-9;]{0,40}[cRn]|\x1b\[[IO])+$/.test(data)) throw new Error('无效终端应答');
    this.livePty().write(data);
  }
  private async capture<T>(fn: () => T, agent: boolean): Promise<T> {
    if (agent) this.ensurePublic();
    const epoch = this.historyEpoch;
    const view = this.renderQueue.then(fn);
    this.renderQueue = view.then(() => {}, () => {});
    const result = await view;
    if (agent) this.ensurePublic();
    // A clear occurring while a read was pending invalidates its old result.
    if (agent && epoch !== this.historyEpoch) return this.capture(fn, true);
    return result;
  }
  private trackTrimming() {
    if (this.trimMarker) {
      const { marker, line } = this.trimMarker;
      const evicted = marker.isDisposed ? this.terminal.buffer.normal.baseY >= 2000 : marker.line < line;
      if (marker.isDisposed || marker.line > line) { this.normalOffset = 0; this.normalGeneration++; }
      else this.normalOffset += line - marker.line;
      if (evicted && !this.historyTruncated && this.kind === 'local') {
        this.historyTruncated = true;
        this.emit('state', this.summary());
      }
      if (!marker.isDisposed) this.trimMarker.line = marker.line;
    }
    if (this.terminal.buffer.active.type === 'normal') {
      this.trimMarker?.marker.dispose();
      const marker = this.terminal.registerMarker(0);
      this.trimMarker = marker ? { marker, line: marker.line } : undefined;
    }
  }
  async observe(owner: string, kind: 'changes' | 'screen' | 'history', options: ReadLimits = {}, agent = true) {
    return this.capture(() => {
      const buffer = kind === 'history' ? this.terminal.buffer.normal : this.terminal.buffer.active;
      const lines = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '');
      const result = this.reader.read({ lines, buffer: buffer.type, baseY: buffer.baseY, cursorX: buffer.cursorX, cursorY: buffer.cursorY,
        cols: this.cols, rows: this.rows, sequence: this.renderedSequence, historyEpoch: this.historyEpoch,
        bufferVersion: this.bufferVersion, normalOffset: this.normalOffset, normalGeneration: this.normalGeneration }, owner, kind, options);
      return { ...result, activeBuffer: this.terminal.buffer.active.type, normalHistoryRevision: this.normalHistoryRevision,
        ...(this.kind === 'local' ? { historyTruncated: this.historyTruncated } : {}) };
    }, agent);
  }
  lastReadSequence(owner: string) { return this.reader.lastSequence(owner); }
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
    const generation = this.processGeneration;
    return this.capture(() => ({ data: this.serializer.serialize(), sequence: this.renderedSequence,
      generation, cols: this.terminal.cols, rows: this.terminal.rows }), false);
  }
  async clearHistory() { return this.resetTerminal(true); }
  protected async resetTerminal(keepAlternate: boolean) {
    if (this.status === 'open') this.pty?.clear?.();
    const seq = ++this.sequence; this.historyEpoch++;
    const generation = this.processGeneration;
    this.renderQueue = this.renderQueue.then(async () => {
      const alternate = keepAlternate && this.terminal.buffer.active.type === 'alternate';
      this.trimMarker?.marker.dispose();
      this.trimMarker = undefined; this.normalOffset = 0; this.normalGeneration++; this.historyTruncated = false;
      this.terminal.reset();
      this.trackTrimming(); this.reader.invalidate(); this.normalHistoryRevision++;
      if (alternate) await new Promise<void>(resolve => this.terminal.write('\x1b[?1049h', resolve));
      this.renderedSequence = seq;
      this.emit('reset', { data: this.serializer.serialize(), seq, uiSeq: seq, generation, cols: this.cols, rows: this.rows });
      this.emit('public-output', seq);
    });
    await this.renderQueue; this.changed();
  }
  resize(cols: number, rows: number) {
    this.livePty().resize(cols, rows);
    const seq = ++this.sequence;
    const generation = this.processGeneration;
    this.renderQueue = this.renderQueue.then(() => {
      this.terminal.resize(cols, rows); this.cols = cols; this.rows = rows; this.renderedSequence = seq;
      this.trackTrimming(); this.normalHistoryRevision++;
      this.emit('resize', { cols, rows, seq, uiSeq: seq, generation }); this.emit('public-output', seq); this.changed();
    });
    return this.renderQueue;
  }
  close() { if (this.status === 'open' && !this.closing) { this.closing = true; this.pty?.kill(); } }
}

type LaunchPty = (bind: (pty: Pty) => void, signal: AbortSignal) => Promise<void>;
type LocalProcessState = 'starting' | 'running' | 'stopping' | 'exited' | 'stopped';
export class LocalSession extends Session {
  private processState: LocalProcessState = 'starting';
  private generation = 1;
  private forced = false;
  private exitCode?: number;
  private launchAbort?: AbortController;
  private transition?: { operation: 'start' | 'stop' | 'restart' | 'delete'; done: Promise<void> };
  private shuttingDown = false;

  constructor(readonly launch: LocalLaunch, readonly deduplicationKey: string | undefined,
    readonly signature: string, owner: string, actor?: AgentIdentity) {
    super(launch, undefined, owner, actor);
  }
  override get processGeneration() { return this.generation; }
  override summary(agentId?: string) {
    const process = { generation: this.generation, processState: this.processState, exitCode: this.exitCode,
      forced: this.forced, historyTruncated: this.historyTruncated };
    const { name, cwd, command, runConfigId } = this.launch;
    return { ...super.summary(agentId), name, cwd, command, runConfigId, ...process };
  }
  agentSummary(agentId: string) {
    if (!this.privateMode && this.assignedTo?.id === agentId) return this.summary(agentId);
    return { id: this.id, kind: 'local' as const, status: this.status, isMine: this.assignedTo?.id === agentId,
      processState: this.processState, generation: this.generation };
  }
  get occupied() { return this.status === 'open' || this.transition?.operation === 'restart'; }
  async waitForStart() {
    if (this.transition?.operation === 'start') await this.transition.done;
  }
  protected override livePty() {
    if (this.processState !== 'running') throw new LocalTerminalError('lifecycle_conflict', '本地终端当前不能接收输入。');
    return super.livePty();
  }
  protected override processExited(exitCode: number) {
    this.exitCode = exitCode;
    if (this.processState === 'stopping' && this.forced) {
      this.output('\r\n[共端：已强制终止此会话的本地进程树]\r\n');
    }
    this.processState = this.processState === 'stopping' ? 'stopped' : 'exited';
    super.processExited(exitCode);
  }
  private change(operation: 'start' | 'stop' | 'restart' | 'delete', perform: () => Promise<void>) {
    if (this.transition) throw new LocalTerminalError('lifecycle_conflict', '本地终端正在执行另一项操作，请稍后重试。');
    const done = Promise.resolve().then(perform);
    this.transition = { operation, done };
    const finish = () => { if (this.transition?.done === done) this.transition = undefined; };
    void done.then(finish, finish);
    return done;
  }
  private async launchProcess(spawn: LaunchPty) {
    if (this.shuttingDown) throw new LocalTerminalError('lifecycle_conflict', '服务正在停止。');
    const controller = new AbortController();
    this.launchAbort = controller;
    try {
      await spawn(pty => this.bindPty(pty), controller.signal);
      if (this.status === 'open') { this.processState = 'running'; this.changed(); }
    } catch (error) {
      if (this.status === 'open') {
        this.pty?.kill();
        if (!this.pty) this.processExited(125);
      }
      throw error;
    } finally { this.launchAbort = undefined; }
  }
  start(spawn: LaunchPty) { return this.change('start', () => this.launchProcess(spawn)); }
  private force() {
    if (this.forced || !this.pty) return;
    this.forced = true;
    this.changed();
    this.pty.kill();
  }
  private async stopProcess(mode: 'graceful' | 'force') {
    if (this.status === 'closed') return;
    const pty = this.pty;
    if (!pty) throw new LocalTerminalError('lifecycle_conflict', '本地终端仍在启动。');
    const controller = new AbortController();
    const exited = once(this, 'exit', { signal: controller.signal }).then(() => true);
    this.processState = 'stopping'; this.changed();
    try {
      if (mode === 'graceful') {
        try { pty.write('\x03'); } catch { /* Exit or force confirmation follows. */ }
        if (await Promise.race([exited, delay(8000, false, { signal: controller.signal })])) return;
      }
      this.force();
      if (!await Promise.race([exited, delay(6000, false, { signal: controller.signal })])) {
        throw new LocalTerminalError('lifecycle_conflict', '仍在等待本地进程退出，请稍后刷新状态。');
      }
    } finally { controller.abort(); }
  }
  stop(mode: 'graceful' | 'force') {
    if (this.transition?.operation === 'stop') {
      if (mode === 'force' && this.processState === 'stopping') this.force();
      return this.transition.done;
    }
    return this.change('stop', () => this.stopProcess(mode));
  }
  restart(spawn: LaunchPty, authorize?: () => void) {
    return this.change('restart', async () => {
      await this.stopProcess('graceful');
      authorize?.();
      if (this.shuttingDown) throw new LocalTerminalError('lifecycle_conflict', '服务正在停止。');
      this.generation++; this.forced = false; this.exitCode = undefined;
      this.status = 'open'; this.processState = 'starting'; this.changed();
      await this.resetTerminal(false);
      try { authorize?.(); }
      catch (error) { this.processExited(125); throw error; }
      this.output('\r\n[共端：本地终端已开始新一代]\r\n');
      await this.launchProcess(spawn);
    });
  }
  remove() { return this.change('delete', () => this.stopProcess('graceful')); }
  override close() {
    this.shuttingDown = true;
    this.launchAbort?.abort(new LocalTerminalError('lifecycle_conflict', '服务正在停止。'));
    this.pty?.kill();
  }
}
