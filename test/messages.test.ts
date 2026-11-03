import test from 'node:test';
import assert from 'node:assert/strict';
import { Messages, messagePage } from '../src/messages.js';
const a = { id: 'A', name: 'Agent A', application: 'test', project: 'project-A', task: 'task-A' };
const b = { ...a, id: 'B', name: 'Agent B' };

test('user messages have immutable recipients and privacy/association filters apply before delivery', () => {
  const inbox = new Messages();
  const first = inbox.send('one', a, '请先解释错误');
  inbox.send('two', b, '另一个任务');
  assert.deepEqual(inbox.unread(a.id, () => true).map(m => m.id), [first.id]);
  assert.equal(inbox.unread(a.id, () => false).length, 0);
  assert.equal(inbox.unread(b.id, s => s === 'one').length, 0);
  assert.throws(() => inbox.acknowledge(b.id, 'one', [first.id]), /不属于/);
  assert.throws(() => inbox.acknowledge(a.id, 'two', [first.id]), /不属于/);
  inbox.acknowledge(a.id, 'one', [first.id]);
  assert.equal(inbox.unread(a.id, () => true).length, 0);
  assert(inbox.list('one')[0].acknowledgedAt);
  const copy = inbox.list('one'); copy[0].text = 'tampered'; copy[0].target.id = b.id;
  assert.equal(inbox.list('one')[0].text, '请先解释错误'); assert.equal(inbox.list('one')[0].target.id, a.id);
});
test('clear removes readable and pending messages and wakes listeners; unrelated-session data is preserved', async () => {
  const inbox = new Messages(); inbox.send('one', a, '清空前'); inbox.send('two', a, '保留');
  const waiter = inbox.wait(inbox.revision, 15000); inbox.clear('one'); await waiter;
  assert.deepEqual(inbox.list('one'), []);
  assert.equal(inbox.unread(a.id, () => true)[0].text, '保留');
  const controller = new AbortController(), cancelled = inbox.wait(inbox.revision, 15000, controller.signal);
  controller.abort(); await cancelled; assert.equal(inbox.listenerCount('change'), 0);
});
test('bounded history refuses additional messages instead of silently hiding unacknowledged user requests', () => {
  const inbox = new Messages(); for (let i = 0; i < 100; i++) inbox.send('one', a, String(i));
  assert.throws(() => inbox.send('one', a, 'overflow'), /100/);
  assert.equal(inbox.list('one').length, 100); inbox.clear('one'); assert.equal(inbox.list('one').length, 0);
});
test('message pages prioritize latest, obey length/count budgets, and keep acknowledgment separate from reading', () => {
  const inbox = new Messages();
  const first = inbox.send('one', a, 'old'.repeat(500)); const second = inbox.send('one', a, 'new'.repeat(500));
  const page = messagePage(inbox.read(a.id, () => true), 2, 2000);
  assert.equal(page.messages.length, 1); assert.equal(page.messages[0].id, second.id); assert.equal(page.nextCursor, second.id);
  assert(page.returnedChars <= 2000); assert(!('target' in page.messages[0]));
  const older = messagePage(inbox.read(a.id, () => true), 2, 2000, page.nextCursor!); assert.equal(older.messages[0].id, first.id);
  assert.equal(inbox.unread(a.id, () => true).length, 2);
  inbox.acknowledge(a.id, 'one', [second.id]);
  const afterAck = messagePage(inbox.read(a.id, () => true), 2, 2000, page.nextCursor!, true);
  assert.equal(afterAck.messages[0].id, first.id);
  inbox.clear('one'); assert.throws(() => messagePage(inbox.read(a.id, () => true), 2, 2000, page.nextCursor!), /失效/);
});
