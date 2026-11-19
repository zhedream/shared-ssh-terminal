import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('both input controls update across ownership, release, privacy, pending and disconnected states', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function canReturnToAgent('), source.indexOf('function ensureTerminal('));
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
test('a pending history response cannot redisplay cleared content in the user dialog', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const invalidate = source.slice(source.indexOf('function invalidateHistory('), source.indexOf('const dismissedStorageKey'));
  const load = source.slice(source.indexOf('async function loadHistory('), source.indexOf("$('view-history').addEventListener"));
  const nodes = new Map<string, any>();
  const $ = (id: string) => { if (!nodes.has(id)) nodes.set(id, { textContent: '', disabled: false }); return nodes.get(id); };
  let finish: (value: any) => void = () => {};
  const context: any = { $, ready: true, historySessionId: 'one', historyCursor: null, historyBusy: false, historyRequest: 0,
    normalHistoryRevisions: new Map(), request: () => new Promise(resolve => { finish = resolve; }) };
  runInNewContext(invalidate + load + '\nvar pendingHistory = loadHistory();', context);
  runInNewContext("invalidateHistory('历史已清空');", context);
  finish({ lines: [{ line: 0, offset: 0, text: 'OLD-CLEARED-TEXT' }], nextCursor: null, normalHistoryRevision: 1, returnedChars: 16, hasMore: false, activeBuffer: 'normal' });
  await context.pendingHistory;
  assert.equal($('history-text').textContent, ''); assert.equal($('history-status').textContent, '历史已清空');
});

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const appHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function mockBrowser(address: string) {
  type Listener = (event: any) => void;
  function mockElement(id = '') {
    const classes = new Set(appHtml.match(new RegExp('id="' + id + '" class="([^"]+)"'))?.[1].split(' '));
    const listeners = new Map<string, Listener>();
    const children: unknown[] = [];
    return {
      children, textContent: '', value: '', inert: id === 'workspace', disabled: false,
      elements: { auth: { addEventListener() {} }, savePassword: { addEventListener() {} } },
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name),
        toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name),
      },
      focus() {}, setAttribute() {}, remove() {},
      append(...items: unknown[]) { children.push(...items); },
      replaceChildren() { children.length = 0; },
      addEventListener(type: string, listener: Listener) { listeners.set(type, listener); },
      fire(type: string) { listeners.get(type)?.({ preventDefault() {} }); },
    };
  }
  const nodes = new Map<string, ReturnType<typeof mockElement>>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, mockElement(id));
    return nodes.get(id)!;
  };
  const location = new URL(address);
  const storageAccess: string[] = [];
  const storage = {
    getItem(key: string) { storageAccess.push(key); return null; },
    setItem(key: string) { storageAccess.push(key); },
    removeItem(key: string) { storageAccess.push(key); },
  };
  const requests: Array<{ route: string; options: RequestInit; hash: string }> = [];
  const replies: Array<number | 'offline'> = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let timerId = 0;
  const sockets: MockSocket[] = [];
  class MockSocket {
    static OPEN = 1;
    readyState = 0;
    frames: string[] = [];
    listeners = new Map<string, Listener>();
    constructor(public url: URL) { sockets.push(this); }
    addEventListener(type: string, listener: Listener) { this.listeners.set(type, listener); }
    open() { this.readyState = 1; this.listeners.get('open')?.({}); }
    send(data: string) { this.frames.push(data); }
    receive(packet: unknown) { this.listeners.get('message')?.({ data: JSON.stringify(packet) }); }
    close() { this.readyState = 3; this.listeners.get('close')?.({}); }
  }
  const displays: MockTerminal[] = [];
  class MockTerminal {
    text = '';
    disposed = false;
    constructor() { displays.push(this); }
    loadAddon() {}
    open() {}
    onData() {}
    reset() { this.text = ''; }
    resize() {}
    write(data: string) { this.text += data; }
    focus() {}
    dispose() { this.disposed = true; }
  }
  const context = {
    document: { getElementById: node, createElement: () => mockElement(), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} }, location, history: { replaceState(_state: null, _title: string, path: string) { location.href = new URL(path, location).href; } },
    localStorage: storage, sessionStorage: storage, URL, URLSearchParams, AbortSignal, crypto,
    WebSocket: MockSocket, Terminal: MockTerminal, FitAddon: { FitAddon: class {} },
    setInterval() {},
    setTimeout(callback: () => void, ms: number) { timers.set(++timerId, { callback, ms }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    async fetch(route: string, options: RequestInit) {
      requests.push({ route, options, hash: location.hash });
      const reply = replies.shift();
      assert.notEqual(reply, undefined, 'unexpected HTTP request ' + route);
      if (reply === 'offline') throw new Error('Offline');
      return { status: reply, ok: reply === 204, async json() { return { error: 'unexpected server body' }; } };
    },
  };
  return {
    node, location, storageAccess, requests, replies, sockets, displays,
    start() { runInNewContext(appSource, context); },
    invoke(source: string) { return runInNewContext(source, context); },
    runTimer(ms: number) {
      const timer = [...timers].find(([, t]) => t.ms === ms);
      assert.ok(timer, 'expected timer at ' + ms);
      timers.delete(timer[0]);
      timer[1].callback();
    },
    settle: () => new Promise<void>(resolve => setImmediate(resolve)),
  };
}

test('a launch link removes its fragment before one redemption and waits for Cookie auth and socket sync', async () => {
  const page = mockBrowser('http://127.0.0.1:43219/?view=terminal#pair=mock-link');
  page.replies.push(204, 204);
  page.start();
  await page.settle();
  assert.equal(page.location.href, 'http://127.0.0.1:43219/?view=terminal');
  assert.deepEqual(page.requests.map(r => [r.route, r.hash]), [['/api/pair', ''], ['/api/auth', '']]);
  assert.equal(page.requests[0].options.body, '{"code":"mock-link"}');
  assert.equal(page.requests[0].options.credentials, 'same-origin');
  assert.equal(page.sockets.length, 1);
  const socket = page.sockets[0];
  assert.equal(socket.url.href, 'ws://127.0.0.1:43219/terminal');
  socket.open();
  assert.deepEqual(socket.frames, []);
  await assert.rejects(page.invoke('request("create")'), /尚未连接/);
  await assert.rejects(page.invoke('api("/api/profiles", { method: "POST" })'), /请先连接/);
  assert.equal(page.node('workspace').inert, true);
  assert.equal(page.node('workspace').classList.contains('hidden'), true);
  socket.receive({ type: 'hello', clientId: 'browser-one', profiles: [], sessions: [] });
  socket.receive({ type: 'synced', sessions: [] });
  assert.equal(page.node('workspace').inert, false);
  assert.equal(page.node('workspace').classList.contains('hidden'), false);
  assert.equal(page.node('connection-text').textContent, '本地服务已连接');
  assert.equal(page.storageAccess.some(key => /token|pair/i.test(key)), false);
});

test('a bare address supports manual retry on 400 and 429, and can recheck a lost redemption response', async () => {
  const page = mockBrowser('http://localhost:43219/');
  page.replies.push(401, 400, 429, 'offline', 204);
  page.start();
  await page.settle();
  assert.equal(page.node('pair-panel').classList.contains('hidden'), false);
  assert.equal(page.sockets.length, 0);
  for (const message of [/无效/, /过于频繁/, /未能确认/]) {
    page.node('pair-code').value = ' mock-form ';
    page.node('pair-form').fire('submit');
    page.node('pair-form').fire('submit');
    assert.equal(page.node('pair-submit').disabled, true);
    await page.settle();
    assert.equal(page.node('pair-code').value, '');
    assert.equal(page.node('pair-submit').disabled, false);
    assert.match(page.node('pair-status').textContent, message);
    assert.equal(page.sockets.length, 0);
  }
  assert.equal(page.requests.filter(r => r.route === '/api/pair').length, 3);
  assert.equal(page.requests[1].options.body, '{"code":"mock-form"}');
  page.node('pair-check').fire('click');
  await page.settle();
  assert.equal(page.sockets.length, 1);
  assert.equal(page.node('pair-panel').classList.contains('hidden'), true);
});

test('a successful redemption without a stored Cookie returns to pairing without opening a socket', async () => {
  const page = mockBrowser('http://localhost:43219/#pair=mock-no-cookie');
  page.replies.push(204, 401);
  page.start();
  await page.settle();
  assert.equal(page.sockets.length, 0);
  assert.equal(page.node('pair-panel').classList.contains('hidden'), false);
  assert.match(page.node('pair-status').textContent, /未保留登录状态/);
});

test('an authenticated business request relies on the Cookie and stops on a stale login', async () => {
  const page = mockBrowser('http://localhost:43219/');
  page.replies.push(204, 401, 401);
  page.start();
  await page.settle();
  const socket = page.sockets[0];
  socket.open();
  socket.receive({ type: 'hello', clientId: 'browser-one', profiles: [], sessions: [] });
  socket.receive({ type: 'synced', sessions: [] });
  await assert.rejects(page.invoke('api("/api/profiles", { method: "POST", body: "{}" })'), /登录态已失效/);
  assert.equal(page.requests[1].options.credentials, 'same-origin');
  assert.equal(new Headers(page.requests[1].options.headers).has('Authorization'), false);
  assert.equal(page.node('workspace').inert, true);
  page.runTimer(2000);
  await page.settle();
  assert.deepEqual(page.requests.map(r => r.route), ['/api/auth', '/api/profiles', '/api/auth']);
  assert.equal(page.node('pair-panel').classList.contains('hidden'), false);
});

test('Cookie startup restores a session, reconnects after a network error, and hides expired session data', async () => {
  const page = mockBrowser('https://localhost:43220/');
  const session = { id: 'fixture-session', cols: 80, rows: 24, status: 'open', lock: { kind: 'user', owner: 'other' } };
  function sync(index: number, text: string) {
    const socket = page.sockets[index];
    socket.open();
    socket.receive({ type: 'hello', clientId: 'browser-' + index, profiles: [], sessions: [session] });
    socket.receive({ type: 'snapshot', sessionId: session.id, cols: 80, rows: 24, data: text });
    socket.receive({ type: 'synced', sessions: [session] });
    return socket;
  }
  page.replies.push(204, 'offline', 204, 401);
  page.start();
  await page.settle();
  const first = sync(0, 'original snapshot');
  assert.equal(first.url.href, 'wss://localhost:43220/terminal');
  assert.equal(page.displays[0].text, 'original snapshot');
  const inFlight = assert.rejects(page.invoke('request("input", { data: "one action" })'), /连接已断开/);
  first.close();
  await inFlight;
  assert.equal(first.frames.length, 1);
  assert.equal(page.node('workspace').inert, true);
  page.runTimer(2000);
  await page.settle();
  assert.equal(page.sockets.length, 1);
  assert.equal(page.node('pair-panel').classList.contains('hidden'), true);
  page.runTimer(2000);
  await page.settle();
  const second = sync(1, 'restored snapshot');
  assert.equal(page.displays[0].text, 'restored snapshot');
  assert.deepEqual(second.frames, []);
  second.close();
  page.runTimer(2000);
  await page.settle();
  assert.equal(page.node('pair-panel').classList.contains('hidden'), false);
  assert.equal(page.node('workspace').classList.contains('hidden'), true);
  assert.equal(page.displays[0].disposed, true);
  assert.equal(page.node('tabs').children.length, 0);
  assert.equal(page.sockets.length, 2);
  assert.ok(page.requests.every(r => r.route === '/api/auth'));
});

async function handoffFixture(snapshot = {}) {
  const page = mockBrowser('http://localhost:43219/');
  const session = {
    id: 'fixture-handoff', status: 'open', cols: 100, rows: 30, revision: 11,
    assignedTo: { id: 'agent-a', name: 'Agent A' }, lock: null, handoff: null, ...snapshot,
  };
  page.replies.push(204);
  page.start();
  await page.settle();
  const ws = page.sockets[0];
  ws.open();
  ws.receive({ type: 'hello', clientId: 'page-a', profiles: [], sessions: [session] });
  ws.receive({ type: 'synced', sessions: [session] });
  return { page, ws, session };
}

test('handoff restores from the initial snapshot, follows broadcasts and gives privacy priority', async () => {
  const { page, ws, session } = await handoffFixture({ handoff: { message: '<b>请交回</b>' } });
  const hidden = (id: string) => page.node(id).classList.contains('hidden');
  const update = (patch: object) => ws.receive({ type: 'state', session: { ...session, ...patch } });
  assert.equal(hidden('handoff-panel'), false);
  assert.equal(page.node('handoff-message').textContent, 'Agent 请求交回：<b>请交回</b>');
  assert.equal(page.node('handoff-message').children.length, 0);
  assert.equal(page.node('return-to-agent').disabled, false);
  assert.equal(page.node('release').disabled, true);
  update({ privateMode: true, lock: { kind: 'user', owner: 'page-a' } });
  assert.match(page.node('status-banner').textContent, /^私密已开启/);
  assert.equal(hidden('handoff-panel'), false);
  assert.equal(hidden('handoff-message'), true);
  assert.equal(page.node('return-to-agent').disabled, false);
  assert.equal(page.node('release').disabled, false);
  update({ assignedTo: null, lock: { kind: 'user', owner: 'page-a' }, handoff: { message: null } });
  assert.equal(hidden('handoff-panel'), false);
  assert.equal(page.node('handoff-message').textContent, '');
  assert.equal(page.node('return-to-agent').disabled, true);
  assert.equal(page.node('release').disabled, false);
  update({ status: 'closed', handoff: null });
  assert.equal(hidden('handoff-panel'), true);
  assert.equal(hidden('return-to-agent'), true);
});

test('explicit return sends the current revision only from an eligible page and waits for server state', async () => {
  const { page, ws, session } = await handoffFixture({ lock: { kind: 'user', owner: 'page-a' } });
  const update = (patch: object) => ws.receive({ type: 'state', session: { ...session, ...patch } });
  const hidden = () => page.node('handoff-panel').classList.contains('hidden');
  const handoff = { message: '准备好了' };
  assert.equal(hidden(), true);
  update({ revision: 14, lock: { kind: 'user', owner: 'page-b' }, handoff });
  assert.equal(page.node('return-to-agent').disabled, true);
  assert.equal(page.node('release').disabled, true);
  page.node('return-to-agent').fire('click');
  assert.deepEqual(ws.frames, []);
  update({ revision: 15, lock: null, handoff });
  page.node('return-to-agent').fire('click');
  page.node('return-to-agent').fire('click');
  assert.equal(ws.frames.length, 1);
  const first = JSON.parse(ws.frames[0]);
  assert.equal(first.type, 'return-to-agent');
  assert.equal(first.sessionId, session.id);
  assert.equal(first.revision, 15);
  assert.equal(page.node('return-to-agent').disabled, true);
  ws.receive({ type: 'error', requestId: first.requestId, error: '状态已变化' });
  await page.settle();
  assert.equal(hidden(), false);
  assert.equal(page.node('return-to-agent').disabled, false);
  assert.equal(page.node('toast').textContent, '状态已变化');
  update({ revision: 16, lock: null, handoff });
  page.node('return-to-agent').fire('click');
  const retry = JSON.parse(ws.frames[1]);
  assert.equal(retry.revision, 16);
  update({ revision: 17, lock: null, handoff: null });
  ws.receive({ type: 'ack', requestId: retry.requestId });
  await page.settle();
  assert.equal(hidden(), true);
  update({ revision: 18, handoff });
  page.node('release').fire('click');
  const release = JSON.parse(ws.frames[2]);
  assert.equal(release.type, 'release');
  assert.equal(hidden(), false);
  update({ revision: 19, lock: null, handoff: null });
  ws.receive({ type: 'ack', requestId: release.requestId });
  await page.settle();
  assert.equal(hidden(), true);
});
