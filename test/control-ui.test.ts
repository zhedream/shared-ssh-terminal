import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('both input controls update across ownership, release, privacy, pending and disconnected states', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function renderActive()'), source.indexOf('function ensureTerminal('));
  const nodes = new Map<string, any>();
  const $ = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { classList: { toggle() {} }, value: '', setAttribute() {}, replaceChildren() {}, append() {} });
    return nodes.get(id);
  };
  const session: any = { id: 'session', status: 'open', privateMode: false, lock: null };
  const context: any = { $, sessions: new Map([['session', session]]), activeId: 'session', terminals: new Map(), ready: true, clientId: 'page-A', controlPending: new Set(), actorLabel: () => 'Agent A', messagesOpen: false, sessionMessages: new Map(), messageDrafts: new Map(), messageTarget: { sessionId: 'session' }, messageSending: false, element: () => ({ append() {} }) };
  const check = (takeover: boolean, release: boolean) => {
    runInNewContext(render + '\nrenderActive();', context);
    assert.equal($('takeover').disabled, !takeover);
    assert.equal($('release').disabled, !release);
  };
  check(true, false); // Free lock.
  session.lock = { kind: 'user', owner: 'page-A' }; check(false, true);
  session.privateMode = true; check(false, true); // Privacy never prevents releasing your own lock.
  session.privateMode = false;
  session.lock = { kind: 'user', owner: 'page-B' }; check(true, false);
  session.lock = { kind: 'agent', owner: 'agent-A' }; check(true, false);
  session.lock = null; check(true, false); // Another page/Agent released it.
  context.controlPending.add('session'); check(false, false);
  context.controlPending.clear();
  session.status = 'closed'; check(false, false);
  session.status = 'open'; context.ready = false; check(false, false);
});

test('message sending is independent of the input lock and disabled for privacy, changed recipients or offline state', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function renderMessages()'), source.indexOf('function ensureTerminal('));
  const nodes = new Map<string, any>();
  const $ = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { classList: { toggle() {} }, value: 'user message', setAttribute() {}, replaceChildren() {}, append() {} });
    return nodes.get(id);
  };
  const session: any = { id: 'session', status: 'open', privateMode: false, assignedTo: { id: 'A' }, lock: { kind: 'agent' } };
  const context: any = { $, sessions: new Map([['session', session]]), activeId: 'session', ready: true, messagesOpen: true, messageSending: false,
    messageTarget: { sessionId: 'session', agentId: 'A' }, messageDrafts: new Map(), sessionMessages: new Map(), actorLabel: () => 'Agent A', element: () => ({ append() {} }) };
  const check = (disabled: boolean) => { runInNewContext(render + '\nrenderMessages();', context); assert.equal($('send-message').disabled, disabled); };
  check(false); session.privateMode = true; check(true); session.privateMode = false;
  session.assignedTo = { id: 'B' }; check(true); context.messageTarget.agentId = 'B'; check(false);
  context.ready = false; check(true); context.ready = true;
  context.messageSending = true; check(true); assert.equal($('message-text').disabled, true);
});
