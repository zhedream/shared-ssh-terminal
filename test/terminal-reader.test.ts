import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Session, type Pty } from '../src/sessions.js';
import { profileSchema } from '../src/profiles.js';
const profile = { ...profileSchema.parse({ name: 'test', host: 'localhost', username: 'test' }), id: 'test-profile' };
class Fake extends EventEmitter implements Pty {
  write() {} resize() {} kill() { this.emit('exit', { exitCode: 0 }); }
  onData(fn: (s: string) => void) { this.on('data', fn); }
  onExit(fn: (s: { exitCode: number }) => void) { this.on('exit', fn); }
}
const fixture = () => { const p = new Fake(); return { p, s: new Session(profile, p, 'user') }; };
const text = (v: Awaited<ReturnType<Session['observe']>>) => v.lines.map(l => l.text).join('\n');

test('new readers get latest current rows, no automatic backlog; independent cursors and unchanged reads are empty', async () => {
  const { p, s } = fixture();
  p.emit('data', Array.from({ length: 100 }, (_, i) => `LINE-${i}`).join('\r\n'));
  const a = await s.observe('A', 'changes', { maxLines: 3 });
  assert(text(a).includes('LINE-99')); assert(!text(a).includes('LINE-0\n')); assert(a.truncated && a.hasMore);
  assert.equal((await s.observe('A', 'changes')).lines.length, 0);
  assert(text(await s.observe('B', 'changes', { maxLines: 3 })).includes('LINE-99'));
  p.emit('data', '\r\nLATEST');
  const delta = await s.observe('A', 'changes');
  assert.equal(delta.mode, 'terminal_delta'); assert(text(delta).includes('LATEST'));
  assert(!text(delta).includes('LINE-98')); assert.equal((await s.observe('A', 'changes')).lines.length, 0);
  s.close();
});

test('normal history pages newest to oldest and long UTF-16 rows are bounded without split surrogate pairs', async () => {
  const { p, s } = fixture(); s.resize(400, 30);
  const original = '🐈'.repeat(150); p.emit('data', original);
  let page = await s.observe('A', 'history', { maxChars: 128 });
  const pieces = [text(page)]; assert(page.returnedChars <= 128); assert(page.nextCursor);
  while (page.nextCursor) {
    page = await s.observe('A', 'history', { maxChars: 128, cursor: page.nextCursor });
    assert(page.returnedChars <= 128); assert(!/[\uD800-\uDBFF]$/.test(text(page))); pieces.push(text(page));
  }
  assert.equal(pieces.reverse().join(''), original);
  s.close();
});

test('pagination never returns an old body after overwrite, clear, privacy toggle, or another task/session cursor', async () => {
  const { p, s } = fixture(); p.emit('data', 'A\r\nB\r\nC');
  const first = await s.observe('A', 'history', { maxLines: 1 }); assert(first.nextCursor);
  await assert.rejects(s.observe('B', 'history', { cursor: first.nextCursor! }), /读取者/);
  const other = fixture(); await assert.rejects(other.s.observe('A', 'history', { cursor: first.nextCursor! }), /游标/); other.s.close();
  p.emit('data', '\rOVERWRITE');
  await assert.rejects(s.observe('A', 'history', { cursor: first.nextCursor! }), /变化/);
  const second = await s.observe('A', 'history', { maxLines: 1 });
  s.setPrivacy(true); await assert.rejects(s.observe('A', 'history', { cursor: second.nextCursor! }), /私密/);
  s.setPrivacy(false); assert((await s.observe('A', 'changes')).reset);
  await s.clearHistory(); await assert.rejects(s.observe('A', 'history', { cursor: second.nextCursor! }), /变化/);
  assert(!text(await s.observe('A', 'history')).includes('OVERWRITE')); s.close();
});

test('Vim-like alternate screen is current; normal history is explicit and survives alternate redraws', async () => {
  const { p, s } = fixture(); p.emit('data', 'SHELL-HISTORY\r\nmore\r\nlatest');
  await s.observe('A', 'changes'); p.emit('data', '\x1b[?1049hVIM-CURRENT');
  const alternate = await s.observe('A', 'changes');
  assert(alternate.reset); assert.equal(alternate.buffer, 'alternate'); assert(text(alternate).includes('VIM-CURRENT'));
  assert(!text(alternate).includes('SHELL-HISTORY'));
  const history = await s.observe('A', 'history', { maxLines: 1 });
  assert.equal(history.activeBuffer, 'alternate'); assert.equal(history.buffer, 'normal'); assert(history.nextCursor);
  p.emit('data', '\r\x1b[2KEDITED');
  const delta = await s.observe('A', 'changes'); assert(text(delta).includes('EDITED')); assert(!text(delta).includes('VIM-CURRENT'));
  const older = await s.observe('A', 'history', { maxLines: 10, cursor: history.nextCursor! }); assert(text(older).includes('SHELL-HISTORY'));
  p.emit('data', '\x1b[?1049l'); const back = await s.observe('A', 'changes'); assert(back.reset); assert(!text(back).includes('EDITED'));
  s.close();
});

test('scrollback eviction never resurrects old content and a huge unread backlog resets to latest only', async () => {
  const { p, s } = fixture(); p.emit('data', 'SECRET-OLD\r\n');
  const before = await s.observe('A', 'history', { maxLines: 1 }); await s.observe('A', 'changes');
  p.emit('data', Array.from({ length: 2200 }, (_, i) => `ROW-${i}`).join('\r\n'));
  const current = await s.observe('A', 'changes', { maxLines: 4 });
  assert(text(current).includes('ROW-2199')); assert(!text(current).includes('SECRET-OLD')); assert(current.reset);
  await assert.rejects(s.observe('A', 'history', { cursor: before.nextCursor! }), /变化/);
  s.close();
});

test('overwrites, erased rows, resize, explicit resync and closed-session reads remain observable without writes', async () => {
  const { p, s } = fixture(); p.emit('data', 'FIRST\r\nSECOND'); await s.observe('A', 'changes');
  p.emit('data', '\x1b[1;1H\x1b[2K'); const erase = await s.observe('A', 'changes'); assert(erase.lines.some(l => l.text === ''));
  p.emit('data', '\x1b[2;1H\x1b[2K\x1b[1;1H');
  const below = await s.observe('A', 'changes'); assert(below.lines.some(l => l.line === 1 && l.text === ''));
  s.resize(90, 20); assert((await s.observe('A', 'changes')).reset);
  assert((await s.observe('A', 'changes', { resync: true })).reset);
  s.close(); assert((await s.observe('A', 'screen')).lines.length > 0);
});
test('moving the alternate-screen cursor to a previously omitted region returns bounded context rather than an empty delta', async () => {
  const { p, s } = fixture(); s.resize(100, 100);
  p.emit('data', '\x1b[?1049h' + Array.from({ length: 100 }, (_, i) => `ALT-${i}`).join('\r\n'));
  const bottom = await s.observe('A', 'changes', { maxLines: 10 }); assert(!text(bottom).includes('ALT-0\n'));
  p.emit('data', '\x1b[1;1H');
  const top = await s.observe('A', 'changes', { maxLines: 10 });
  assert(top.reset); assert(text(top).includes('ALT-0')); assert(top.lines.length <= 10);
  assert.equal((await s.observe('A', 'changes', { maxLines: 10 })).lines.length, 0); s.close();
});
