import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type ReadLimits = { maxChars?: number; maxLines?: number; cursor?: string; resync?: boolean; startRow?: number };
export type TerminalFrame = {
  lines: string[]; buffer: 'normal' | 'alternate'; baseY: number; cursorX: number; cursorY: number;
  cols: number; rows: number; sequence: number; historyEpoch: number;
  bufferVersion: number; normalGeneration: number; normalOffset: number;
};
type Baseline = { tag: string; hashes: Map<number, string>; end: number; sequence: number; shownStart: number; shownEnd: number };
type PageCursor = { owner: string; kind: 'view' | 'history'; stamp: string; start: number; end: number; index: number; offset: number; forward: boolean };
type TextLine = { line: number; text: string; offset: number; totalChars: number };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// Only hashes of the last observed viewport are retained per reader. There is
// no second terminal log and no cached page body to resurrect cleared content.
export class TerminalReader {
  private secret = randomBytes(32);
  private baselines = new Map<string, Baseline>();
  invalidate() { this.baselines.clear(); }
  lastSequence(owner: string) { return this.baselines.get(owner)?.sequence; }
  private encode(cursor: PageCursor) {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return body + '.' + createHmac('sha256', this.secret).update(body).digest('base64url');
  }
  private decode(value: string, owner: string, kind: PageCursor['kind'], stamp: string): PageCursor {
    if (value.length > 2048) throw new Error('分页游标无效');
    const [body, signature, extra] = value.split('.');
    const expected = createHmac('sha256', this.secret).update(body || '').digest('base64url');
    if (extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('分页游标无效或不属于此会话');
    let cursor: PageCursor;
    try { cursor = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new Error('分页游标无效'); }
    if (cursor.owner !== owner || cursor.kind !== kind) throw new Error('分页游标不属于当前读取者或读取类型');
    if (cursor.stamp !== stamp) throw new Error('分页内容已变化、清空或被覆盖，请从最新内容重新读取');
    return cursor;
  }
  read(frame: TerminalFrame, owner: string, kind: 'changes' | 'screen' | 'history', options: ReadLimits = {}) {
    const maxChars = Math.max(128, Math.min(16000, options.maxChars ?? 4000));
    const maxLines = Math.max(1, Math.min(100, options.maxLines ?? 40));
    const offset = frame.buffer === 'normal' ? frame.normalOffset : 0;
    const tag = [frame.historyEpoch, frame.bufferVersion, frame.normalGeneration, frame.buffer, frame.cols, frame.rows].join(':');
    const keyKind = kind === 'history' ? 'history' : 'view';
    const stamp = hash(JSON.stringify([keyKind, frame.historyEpoch, frame.normalGeneration, offset, frame.buffer, frame.cols, frame.rows,
      kind === 'history' ? 0 : frame.bufferVersion, frame.lines]));
    const previous = this.baselines.get(owner);
    const focusChanged = !!previous && frame.buffer === 'alternate' &&
      (frame.baseY + frame.cursorY < previous.shownStart || frame.baseY + frame.cursorY > previous.shownEnd);
    const reset = kind !== 'history' && (!previous || previous.tag !== tag || !!options.resync || focusChanged || (kind === 'screen' && !options.cursor));
    const hashes = new Map<number, string>();
    const viewEnd = Math.min(frame.lines.length - 1, frame.baseY + frame.rows - 1);
    for (let i = frame.baseY; i <= viewEnd; i++) hashes.set(i + offset, hash(frame.lines[i]));
    let end = viewEnd;
    // Ignore empty rows below the actual prompt, but keep the cursor's row.
    if (frame.buffer === 'normal') {
      while (end > frame.baseY + frame.cursorY && !frame.lines[end]) end--;
    }
    if (kind === 'changes' && !reset && !options.cursor) end = viewEnd; // Include erased rows below the cursor in deltas.
    let start = kind === 'history' ? 0 : frame.baseY;
    const forward = kind !== 'history' && frame.buffer === 'alternate';
    if (forward) start = frame.baseY + Math.max(0, Math.min(frame.rows - 1, options.startRow ?? Math.max(0, frame.cursorY - Math.floor(maxLines / 2))));
    else if (kind === 'screen' && options.startRow !== undefined) start = frame.baseY + Math.min(frame.rows - 1, options.startRow);
    let page: PageCursor = options.cursor ? this.decode(options.cursor, owner, keyKind, stamp)
      : { owner, kind: keyKind, stamp, start, end, index: forward ? start : end, offset: forward ? 0 : (frame.lines[end]?.length ?? 0), forward };
    start = page.start; end = page.end;
    const selected: TextLine[] = [];
    let used = 0, examined = 0;
    const incremental = kind === 'changes' && !reset && !options.cursor;
    const candidates = incremental ? [...hashes].filter(([line, digest]) => previous?.hashes.get(line) !== digest).length : end - start + 1;
    let index = page.index, position = page.offset;
    while (index >= start && index <= end && selected.length < maxLines) {
      const line = frame.lines[index] ?? '';
      if (incremental && previous?.hashes.get(index + offset) === hash(line)) {
        index += page.forward ? 1 : -1; position = page.forward ? 0 : (frame.lines[index]?.length ?? 0); continue;
      }
      const available = maxChars - used - (selected.length ? 1 : 0);
      if (available <= 0) break;
      let from = page.forward ? position : Math.max(0, position - available);
      let to = page.forward ? Math.min(line.length, position + available) : position;
      // UTF-16 offsets are explicit; never split a surrogate pair in text.
      if (from > 0 && /[\uDC00-\uDFFF]/.test(line[from] ?? '')) from++;
      if (to > from && /[\uDC00-\uDFFF]/.test(line[to] ?? '')) to--;
      if (line.length && from === to) break;
      const text = line.slice(from, to);
      selected.push({ line: index + offset, text, offset: from, totalChars: line.length });
      used += text.length + (selected.length > 1 ? 1 : 0); examined++;
      if (page.forward ? to < line.length : from > 0) { position = page.forward ? to : from; break; }
      index += page.forward ? 1 : -1; position = page.forward ? 0 : (frame.lines[index]?.length ?? 0);
    }
    const remaining = index >= start && index <= end;
    // Continuations intentionally request a bounded current-state page, not an
    // automatic backlog replay. Old unreturned changes are never auto-drained.
    const nextCursor = remaining ? this.encode({ ...page, index, offset: position }) : null;
    if (!page.forward) selected.reverse();
    if (kind !== 'history' && !options.cursor) {
      this.baselines.delete(owner);
      this.baselines.set(owner, { tag, hashes, end: viewEnd + offset, sequence: frame.sequence,
        shownStart: incremental && previous ? Math.min(previous.shownStart, selected[0]?.line ?? previous.shownStart) : selected[0]?.line ?? frame.baseY,
        shownEnd: incremental && previous ? Math.max(previous.shownEnd, selected.at(-1)?.line ?? previous.shownEnd) : selected.at(-1)?.line ?? viewEnd });
      if (this.baselines.size > 64) this.baselines.delete(this.baselines.keys().next().value!);
    }
    return {
      mode: kind === 'history' ? 'terminal_history' : incremental ? 'terminal_delta' : 'terminal_snapshot',
      sequence: frame.sequence, historyEpoch: frame.historyEpoch, buffer: frame.buffer,
      cols: frame.cols, rows: frame.rows, cursorX: frame.cursorX, cursorY: frame.cursorY,
      viewportStart: frame.baseY + offset, viewportEnd: viewEnd + offset,
      lines: selected, returnedChars: used, limits: { maxChars, maxLines },
      reset, resetReason: reset ? options.resync ? 'requested' : !previous ? 'first_read' : focusChanged ? 'cursor_outside_returned_region' : 'screen_or_access_changed' : null,
      truncated: candidates > examined || selected.some(l => l.text.length < l.totalChars),
      hasMore: remaining, nextCursor, omittedBefore: Math.max(0, start - (kind === 'history' ? 0 : frame.baseY)),
      omittedChangedLines: Math.max(0, candidates - examined),
      skippedOlderOutput: kind !== 'history' && !!previous && frame.buffer === 'normal' && frame.baseY + offset > previous.end + 1,
      paging: kind === 'history' || !page.forward ? 'older' : 'lower_screen_rows',
      hint: kind === 'history' ? '从最近历史向前分页。游标过期时重新读取；没有隐藏旧快照。'
        : '默认只观察当前画面，截断的旧变化不自动补读。可传 nextCursor 显式分页，或调用 read_history 从最近普通历史向前读取。',
    };
  }
}
