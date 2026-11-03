/* global Terminal, FitAddon */
const $ = id => document.getElementById(id);
const loadedUiVersion = document.querySelector('meta[name="ui-version"]')?.content;
let reloadScheduled = false;
const authStorageKey = 'shared-ssh-token';
let token = location.hash.slice(1) || localStorage.getItem(authStorageKey) || sessionStorage.getItem(authStorageKey);
if (location.hash) history.replaceState(null, '', '/');
const sessions = new Map(), terminals = new Map(), pending = new Map();
const controlPending = new Set();
const sessionMessages = new Map(), messageDrafts = new Map();
let messagesOpen = false, messageSending = false, messageTarget;
const dismissedStorageKey = 'shared-ssh-dismissed-tabs';
let dismissedTabs;
try {
  const saved = JSON.parse(localStorage.getItem(dismissedStorageKey) || '[]');
  dismissedTabs = new Set(Array.isArray(saved) ? saved.filter(id => typeof id === 'string' && id.length === 36).slice(-1000) : []);
} catch { dismissedTabs = new Set(); }
function saveDismissedTabs() { try { localStorage.setItem(dismissedStorageKey, JSON.stringify([...dismissedTabs].slice(-1000).sort())); } catch {} }
let profiles = [], activeId = null, socket, clientId, ready = false, reconnectTimer, toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 6500); }
async function api(route, options = {}) {
  const response = await fetch(route, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
}
function request(type, args = {}) {
  if (!ready || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('本地服务尚未连接'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('操作响应超时；请查看终端状态，勿重复提交命令')); }, 10000);
    pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ type, requestId, ...args }));
  });
}
function getActive() { const s = sessions.get(activeId); if (!s) throw new Error('请先建立连接'); return s; }
function refreshUpdatedUi(version) {
  if (!loadedUiVersion || !/^[a-f0-9]{16}$/.test(version) || version === loadedUiVersion) return;
  if (reloadScheduled || pending.size || [...messageDrafts.values()].some(d => d.text) || [...terminals.values()].some(t => t.sending || t.input) || document.querySelector('dialog[open]')) return;
  reloadScheduled = true;
  toast('界面已更新，正在同步新版；SSH 连接会保留。');
  setTimeout(() => {
    reloadScheduled = false;
    if (pending.size || [...messageDrafts.values()].some(d => d.text) || [...terminals.values()].some(t => t.sending || t.input) || document.querySelector('dialog[open]')) return;
    try { if (activeId) sessionStorage.setItem('shared-ssh-active-tab', activeId); } catch {}
    location.reload();
  }, 700);
}
async function checkUiVersion() {
  try {
    const response = await fetch('/ui-version', { cache: 'no-store' });
    if (response.ok) refreshUpdatedUi((await response.json()).uiVersion);
  } catch {} // A local service restart is handled by the normal reconnect flow.
}
setInterval(checkUiVersion, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkUiVersion(); });
void checkUiVersion();
function canInput(s) { return ready && s.status === 'open' && (!s.lock || (s.lock.kind === 'user' && s.lock.owner === clientId)); }
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function actorLabel(actor) {
  if (!actor) return '用户 / 待交接';
  const project = actor.project?.split(/[\\/]/).filter(Boolean).at(-1);
  return [actor.name, project, actor.task].filter(Boolean).join(' / ');
}
function renderProfiles() {
  const root = $('profiles'); root.replaceChildren();
  if (!profiles.length) root.append(element('div', 'profile-empty', '添加常用服务器，\n在独立页签中建立 SSH 连接。'));
  for (const p of profiles) {
    const card = element('div', 'profile-card'), heading = element('div', 'profile-title');
    heading.append(element('strong', '', p.name));
    const edit = element('button', '', '···'); edit.title = '编辑服务器'; edit.addEventListener('click', () => openProfile(p)); heading.append(edit);
    card.append(heading, element('div', 'profile-address', `${p.username}@${p.host}:${p.port}`));
    if (p.note) card.append(element('div', 'profile-note', p.note));
    const connect = element('button', 'profile-connect', p.auth === 'key' ? '私钥连接' : p.auth === 'agent' ? 'Agent / 默认密钥' : p.savePassword ? '密码自动登录' : '密码连接');
    connect.disabled = !ready; connect.append(element('span', '', '连接 ↗'));
    connect.addEventListener('click', () => request('create', { profileId: p.id }).then(s => { updateSession(s); activate(s.id); }).catch(e => toast(e.message)));
    card.append(connect); root.append(card);
  }
}
function updateSession(s) {
  if (s.status === 'closed' && dismissedTabs.has(s.id)) {
    if (sessions.has(s.id)) { sessions.set(s.id, s); dismissClosedTab(s.id, false); }
    return;
  }
  sessions.set(s.id, s); ensureTerminal(s); if (!activeId) activeId = s.id; renderTabs(); renderActive();
}
function dismissClosedTab(id, publish = true) {
  if (sessions.get(id)?.status !== 'closed') return;
  const ids = [...sessions.keys()], index = ids.indexOf(id), terminal = terminals.get(id);
  dismissedTabs.add(id); saveDismissedTabs();
  if (publish && ready) request('dismiss-tab', { sessionId: id }).catch(e => toast(`页签已在本页移除，跨页面同步失败：${e.message}`));
  if (terminal) { clearTimeout(terminal.schedule); terminal.input = ''; terminal.term.dispose(); terminal.pane.remove(); }
  terminals.delete(id); sessions.delete(id); sessionMessages.delete(id); messageDrafts.delete(id);
  if (activeId === id) {
    const remaining = [...sessions.keys()];
    activeId = remaining[Math.min(index, remaining.length - 1)] ?? null;
  }
  renderTabs(); renderActive();
  if (activeId) { setTimeout(fitActive, 20); terminals.get(activeId)?.term.focus(); }
}
function renderTabs() {
  $('tabs').replaceChildren();
  for (const s of sessions.values()) {
    const item = element('div', 'tab-item');
    const tab = element('button', `tab${s.id === activeId ? ' active' : ''}${s.status === 'closed' ? ' dismissible' : ''}`); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(s.id === activeId));
    const kind = s.status === 'closed' ? '' : s.lock?.kind || 'free';
    tab.append(element('i', `tab-dot ${kind}`));
    const text = element('div', 'tab-text'); text.append(element('span', 'tab-title', s.name), element('span', 'tab-subtitle', `${s.currentUser || s.loginUser}@${s.host} · ${actorLabel(s.assignedTo)}`)); tab.append(text);
    tab.title = `${s.id}\n关联 Agent：${actorLabel(s.assignedTo)}`;
    if (s.lock) tab.append(element('span', 'tab-lock', s.lock.kind === 'agent' ? `🔒 ${s.lock.agent?.name || 'Agent'}` : s.privateMode ? '私密' : '🔒 用户'));
    if (s.status === 'closed') tab.append(element('span', 'muted', '已关闭'));
    tab.addEventListener('click', () => activate(s.id)); item.append(tab);
    if (s.status === 'closed') {
      const dismiss = element('button', 'tab-close', '×');
      dismiss.title = '移除已关闭页签'; dismiss.setAttribute('aria-label', `移除已关闭页签 ${s.name}`);
      dismiss.addEventListener('click', () => dismissClosedTab(s.id)); item.append(dismiss);
    }
    $('tabs').append(item);
  }
}
function activate(id) { activeId = id; renderTabs(); renderActive(); setTimeout(() => fitActive(), 20); terminals.get(id)?.term.focus(); }
function renderActive() {
  const s = sessions.get(activeId);
  $('empty').classList.toggle('hidden', !!s); $('session-panel').classList.toggle('hidden', !s);
  for (const [id, t] of terminals) t.pane.classList.toggle('hidden', id !== activeId);
  if (!s) return;
  $('session-host').textContent = `${s.host}:${s.port}`;
  $('session-user').textContent = `SSH ${s.loginUser}${s.currentUser ? ' → ' + s.currentUser : ''}`;
  const mine = s.lock?.kind === 'user' && s.lock.owner === clientId;
  $('session-ownership').textContent = `创建：${s.createdBy?.kind === 'agent' ? actorLabel(s.createdBy.agent) : '用户'}　｜　关联 Agent：${actorLabel(s.assignedTo)}`;
  let banner = s.assignedTo ? `共享画面 · ${actorLabel(s.assignedTo)} 可观察当前画面和滚动历史；输入一次只由一方控制。` : '用户会话 / 待交接 · 复制 sessionId 给指定 Agent 认领；输入权由所有页面和已关联 Agent 共用一把锁。', kind = '';
  if (!ready) { banner = '界面连接已断开，SSH 会话由本地服务继续维护。正在重新连接…'; kind = 'private'; }
  else if (s.status === 'closed') banner = 'SSH 连接已关闭。可查看已有输出，或点击页签右侧 × 移除此页签；重新连接请使用左侧服务器列表。';
  else if (s.privateMode) { banner = `私密已开启 · Agent 无权观察或输入，屏幕仍保留。${s.lock && !mine ? '输入由另一方持有，请点击「接管输入权」后操作。' : '关闭私密后，当前画面和仍保留的历史将可被 Agent 看到。'}`; kind = 'private'; }
  else if (s.lock?.kind === 'agent') { banner = `🔒 ${actorLabel(s.lock.agent)} 持有输入权 · 你可观察并随时接管。交接不终止当前程序。`; kind = 'agent'; }
  else if (s.lock) { banner = `🔒 ${mine ? '当前页面持有输入权' : s.lock.owner === 'pending-user' ? '等待用户接管输入权' : '另一页面持有输入权'} · 释放输入权后，其他页面或已关联 Agent 可获取。释放不终止当前程序。`; kind = 'user'; }
  else { banner += ' 输入权空闲，可接管输入权；开始输入也会自动获取锁。'; }
  if (s.status === 'open') banner += ' 操作完成后请主动释放输入权。';
  $('status-banner').className = 'status-banner ' + kind; $('status-banner').textContent = banner;
  $('session-detail').textContent = `输入权：${s.lock ? mine ? '当前页面' : s.lock.kind === 'agent' ? actorLabel(s.lock.agent) : '另一页面' : '空闲'}  ·  ${s.id.slice(0, 8)}`;
  $('terminal-size').textContent = `${s.cols} × ${s.rows}`;
  for (const id of ['interrupt', 'close-session']) $(id).disabled = !ready || s.status !== 'open';
  $('takeover').disabled = !ready || s.status !== 'open' || mine || controlPending.has(s.id);
  $('takeover').title = mine ? '当前页面已持有输入权' : s.lock ? '将输入权从当前持有者切换到此页面' : '获取空闲的输入权';
  $('private').textContent = s.privateMode ? '私密：开' : '私密：关';
  $('private').title = s.privateMode ? '关闭私密，让 Agent 看到当前画面和保留历史' : '开启私密，禁止 Agent 观察；不清屏、不切换输入权';
  $('private').disabled = !ready;
  $('clear-history').disabled = !ready;
  $('release').disabled = !ready || s.status !== 'open' || !mine || controlPending.has(s.id);
  $('release').title = mine ? '释放当前页面的输入锁；保留运行程序与未发送输入' : '只有当前页面持有输入权时才能释放';
  $('copy-session').disabled = !ready;
  $('return-to-user').disabled = !ready || s.status !== 'open' || !s.assignedTo;
  renderMessages();
}
function renderMessages() {
  const s = sessions.get(activeId);
  $('agent-messages').classList.toggle('hidden', !s || !messagesOpen);
  $('toggle-messages').setAttribute('aria-expanded', String(messagesOpen));
  if (!s) return;
  if (messageTarget?.sessionId !== s.id) {
    const draft = messageDrafts.get(s.id);
    messageTarget = { sessionId: s.id, agentId: draft?.targetAgentId || s.assignedTo?.id };
    $('message-text').value = draft?.text || '';
  }
  const changed = messageTarget.agentId !== s.assignedTo?.id;
  $('message-text').disabled = messageSending;
  $('message-recipient').textContent = s.assignedTo ? `接收者：${actorLabel(s.assignedTo)}` : '尚未关联 Agent';
  $('message-help').textContent = s.privateMode ? '私密已开启，Agent 无权接收消息。关闭私密后可发送。' : changed ? '关联 Agent 已变化。请关闭并重新打开消息面板，确认新的接收者后再发送。' : '消息不进入 SSH，也不改变输入权。通知是否唤醒 Agent 取决于客户端；“已确认收到”不代表任务完成。';
  $('send-message').disabled = !ready || !s.assignedTo || s.privateMode || changed || messageSending || !$('message-text').value.trim();
  $('clear-messages').disabled = !ready || messageSending;
  const list = $('message-list'); list.replaceChildren();
  for (const m of sessionMessages.get(s.id) || []) {
    const row = element('div', 'message-item');
    row.append(element('div', 'message-meta', `${new Date(m.createdAt).toLocaleTimeString()} · 发给 ${m.target.name} · ${m.acknowledgedAt ? 'Agent 已确认收到' : m.target.id === s.assignedTo?.id ? '待 Agent 确认收到' : '接收者已解除关联'}`), element('div', 'message-body', m.text));
    list.append(row);
  }
}
function ensureTerminal(s) {
  if (terminals.has(s.id)) return;
  const pane = element('div', 'terminal-pane hidden'); $('terminal-stack').append(pane);
  const term = new Terminal({ cols: s.cols, rows: s.rows, cursorBlink: true, scrollback: 2000, fontSize: 13,
    fontFamily: 'Cascadia Code, Consolas, Microsoft YaHei, monospace', theme: { background: '#0c121b', foreground: '#d5e1ef', cursor: '#75dfbd', selectionBackground: '#355b6b' }, allowProposedApi: false });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(pane);
  const t = { term, fit, pane, input: '', sending: false, schedule: null };
  terminals.set(s.id, t);
  // Input is serialized and acknowledged; no retry after a conflict or reconnect.
  term.onData(data => {
    if (/^(?:\x1b\[[?>]?[0-9;]{0,40}[cRn]|\x1b\[[IO])+$/.test(data)) {
      if (ready) request('terminal-reply', { sessionId: s.id, data }).catch(() => {});
      return;
    }
    const current = sessions.get(s.id);
    if (!current || !canInput(current)) { toast('当前输入已锁定，请先接管终端。'); return; }
    t.input += data;
    if (t.input.length > 16000) { t.input = ''; toast('粘贴内容过长，请分段输入。'); return; }
    if (!t.schedule) t.schedule = setTimeout(() => { t.schedule = null; flushInput(s.id); }, 15);
  });
}
async function flushInput(id) {
  const t = terminals.get(id); if (!t || t.sending || !t.input) return;
  const s = sessions.get(id), data = t.input; t.input = ''; t.sending = true;
  try {
    if (!canInput(s)) throw new Error('输入控制权已变化；本次输入未发送');
    await request('input', { sessionId: id, data, revision: s.revision });
  } catch (e) { t.input = ''; toast(e.message + '；请确认终端后再输入。'); }
  finally { t.sending = false; if (t.input) flushInput(id); }
}
function fitActive() {
  const s = sessions.get(activeId), t = terminals.get(activeId); if (!s || !t || !canInput(s)) return;
  const size = t.fit.proposeDimensions(); if (!size) return;
  const cols = Math.max(20, Math.min(400, size.cols)), rows = Math.max(5, Math.min(160, size.rows));
  if (cols !== s.cols || rows !== s.rows) request('resize', { sessionId: s.id, cols, rows }).catch(e => toast(e.message));
}
function connect() {
  if (!token) { $('connection-text').textContent = '请先从启动入口打开一次'; toast('首次使用请双击 start.cmd；之后同一浏览器可直接打开此地址。'); return; }
  socket = new WebSocket(`ws://${location.host}/terminal`);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', token })));
  socket.addEventListener('message', event => {
    const p = JSON.parse(event.data);
    if (p.type === 'hello') {
      refreshUpdatedUi(p.uiVersion);
      clientId = p.clientId; profiles = p.profiles;
      const serverIds = new Set(p.sessions.map(s => s.id));
      for (const id of sessionMessages.keys()) if (!serverIds.has(id)) { sessionMessages.delete(id); messageDrafts.delete(id); }
      dismissedTabs = new Set([...dismissedTabs].filter(id => serverIds.has(id)));
      saveDismissedTabs();
      const ids = new Set(p.sessions.filter(s => s.status !== 'closed' || !dismissedTabs.has(s.id)).map(s => s.id));
      for (const [id, t] of terminals) if (!ids.has(id)) { t.term.dispose(); t.pane.remove(); terminals.delete(id); sessions.delete(id); }
      if (!ids.has(activeId)) activeId = null;
      for (const s of p.sessions) { updateSession(s); terminals.get(s.id)?.term.reset(); }
    } else if (p.type === 'synced') {
      // Publish only a verified credential; an old bookmarked launch URL must
      // not replace a working credential in other windows.
      if (localStorage.getItem(authStorageKey) !== token) localStorage.setItem(authStorageKey, token);
      sessionStorage.removeItem(authStorageKey);
      ready = true; for (const s of p.sessions) updateSession(s);
      try {
        const restored = sessionStorage.getItem('shared-ssh-active-tab'); sessionStorage.removeItem('shared-ssh-active-tab');
        if (sessions.has(restored)) activate(restored);
      } catch {}
      $('connection-dot').classList.add('connected'); $('connection-text').textContent = '本地服务已连接'; renderProfiles(); renderActive(); setTimeout(fitActive, 30);
    } else if (p.type === 'state') updateSession(p.session);
    else if (p.type === 'profiles') { profiles = p.profiles; renderProfiles(); }
    else if (p.type === 'messages') { sessionMessages.set(p.sessionId, p.messages); if (p.sessionId === activeId) renderMessages(); }
    else if (p.type === 'dismissed') {
      const s = sessions.get(p.sessionId);
      dismissedTabs.add(p.sessionId); saveDismissedTabs();
      if (s) { s.status = 'closed'; dismissClosedTab(p.sessionId, false); }
    }
    else if (p.type === 'output') terminals.get(p.sessionId)?.term.write(p.data);
    else if (p.type === 'snapshot') { const t = terminals.get(p.sessionId); if (t) { t.term.resize(p.cols, p.rows); t.term.write(p.data); } }
    else if (p.type === 'resize') terminals.get(p.sessionId)?.term.resize(p.cols, p.rows);
    else if (p.type === 'reset') {
      const t = terminals.get(p.sessionId);
      if (t) { t.term.reset(); t.term.resize(p.cols, p.rows); t.term.write(p.data); }
    }
    else if (p.type === 'ack' || p.type === 'error') {
      const item = pending.get(p.requestId); if (item) { clearTimeout(item.timer); pending.delete(p.requestId); if (p.type === 'ack') item.resolve(p.result); else item.reject(new Error(p.error)); }
      else if (p.type === 'error') toast(p.error);
    }
  });
  socket.addEventListener('close', event => {
    ready = false; $('connection-dot').classList.remove('connected');
    for (const t of terminals.values()) { t.input = ''; clearTimeout(t.schedule); t.schedule = null; }
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('连接已断开；不自动重发输入')); } pending.clear();
    renderProfiles(); renderActive(); clearTimeout(reconnectTimer);
    if (event.code === 1008) {
      const latest = localStorage.getItem(authStorageKey);
      if (latest && latest !== token) { token = latest; reconnectTimer = setTimeout(connect, 100); return; }
      $('connection-text').textContent = '访问凭据已失效，请重新打开启动入口';
      toast('服务可能已重启。双击 start.cmd 更新访问凭据，已打开的其他窗口会自动同步。');
      return;
    }
    $('connection-text').textContent = '本地界面连接中断 · 正在重连（不代表 SSH 已关闭）';
    reconnectTimer = setTimeout(connect, 2000);
  });
  socket.addEventListener('error', () => {});
}
$('toggle-messages').addEventListener('click', () => {
  messagesOpen = !messagesOpen;
  if (messagesOpen) {
    const s = getActive(); messageTarget = { sessionId: s.id, agentId: s.assignedTo?.id };
    const draft = messageDrafts.get(s.id);
    if (draft) draft.targetAgentId = s.assignedTo?.id;
    $('message-text').value = draft?.text || '';
  }
  renderMessages(); setTimeout(fitActive, 20);
  if (messagesOpen) $('message-text').focus();
});
$('message-text').addEventListener('input', () => {
  if (activeId) messageDrafts.set(activeId, { text: $('message-text').value, targetAgentId: messageTarget?.agentId });
  renderMessages();
});
$('message-form').addEventListener('submit', async event => {
  event.preventDefault(); if (messageSending) return;
  const s = getActive(), text = $('message-text').value.trim();
  if (!text || !messageTarget?.agentId || messageTarget.agentId !== s.assignedTo?.id) { toast('请确认当前关联的 Agent 后再发送'); return; }
  messageSending = true; renderMessages();
  try {
    await request('send-message', { sessionId: s.id, targetAgentId: messageTarget.agentId, text });
    messageDrafts.delete(s.id); if (activeId === s.id) $('message-text').value = '';
  } catch (e) { toast(e.message + '；消息未自动重发。'); }
  finally { messageSending = false; renderMessages(); }
});
$('clear-messages').addEventListener('click', async () => {
  if (!confirm('清空此会话所有页面和 Agent 可读取的消息历史？已进入 Agent 上下文的消息无法撤回。')) return;
  try { await request('clear-messages', { sessionId: getActive().id }); } catch (e) { toast(e.message); }
});
function openProfile(p) {
  const form = $('profile-form'); form.reset(); form.elements.id.value = '';
  $('dialog-title').textContent = p ? '编辑服务器' : '添加服务器'; $('delete-profile').classList.toggle('hidden', !p);
  if (p) for (const key of ['id', 'name', 'host', 'port', 'username', 'auth', 'identityFile', 'note']) form.elements[key].value = p[key] || '';
  form.elements.savePassword.checked = !!p?.savePassword;
  form.dataset.hasSavedPassword = p?.savePassword ? 'true' : 'false';
  form.elements.password.placeholder = p?.savePassword ? '已保存；留空保留原密码，输入新密码可替换' : '输入登录密码';
  updateAuth(); $('profile-dialog').showModal();
}
function updateAuth() {
  const form = $('profile-form'), key = form.elements.auth.value === 'key', password = form.elements.auth.value === 'password';
  $('key-field').classList.toggle('hidden', !key); form.elements.identityFile.required = key;
  $('password-field').classList.toggle('hidden', !password);
  const saved = password && form.elements.savePassword.checked;
  $('saved-password-field').classList.toggle('hidden', !saved);
  form.elements.password.required = saved && form.dataset.hasSavedPassword !== 'true';
  if (!saved) form.elements.password.value = '';
}
$('add-server').addEventListener('click', () => openProfile()); $('empty-add').addEventListener('click', () => openProfile());
for (const id of ['dialog-close', 'dialog-cancel']) $(id).addEventListener('click', () => $('profile-dialog').close());
$('profile-form').elements.auth.addEventListener('change', updateAuth);
$('profile-form').elements.savePassword.addEventListener('change', updateAuth);
// Clear plaintext from the dialog on cancel, Escape, and successful save.
$('profile-dialog').addEventListener('close', () => { $('profile-form').elements.password.value = ''; });
$('profile-form').addEventListener('submit', async event => {
  event.preventDefault(); const p = Object.fromEntries(new FormData(event.target)); p.port = Number(p.port); if (!p.id) delete p.id; if (p.auth !== 'key') delete p.identityFile;
  p.savePassword = p.auth === 'password' && event.target.elements.savePassword.checked;
  if (!p.savePassword || !p.password) delete p.password;
  try { await api('/api/profiles', { method: 'POST', body: JSON.stringify(p) }); $('profile-dialog').close(); } catch (e) { toast(e.message); }
});
$('delete-profile').addEventListener('click', async () => {
  if (!confirm('删除此服务器配置？已有 SSH 连接会继续保留。')) return;
  try { await api('/api/profiles/' + $('profile-form').elements.id.value, { method: 'DELETE' }); $('profile-dialog').close(); } catch (e) { toast(e.message); }
});
for (const [id, action] of [['takeover', 'takeover'], ['release', 'release'], ['close-session', 'close'], ['return-to-user', 'return-to-user']]) {
  $(id).addEventListener('click', async () => {
    let changingControl;
    try {
      const s = getActive();
      if (action === 'close' && !confirm('关闭此 SSH 连接？该会话中的 shell 将结束。')) return;
      // Drain local keystrokes before a control operation.
      const t = terminals.get(s.id); if (t.sending || t.input) throw new Error('输入正在发送，请稍后操作');
      if (action === 'takeover' || action === 'release') {
        if (controlPending.has(s.id)) throw new Error('输入权正在变更，请稍候');
        changingControl = s.id; controlPending.add(s.id); renderActive();
      }
      await request(action, { sessionId: s.id }); if (action === 'takeover') fitActive(); t.term.focus();
    } catch (e) { toast(e.message); }
    finally { if (changingControl) { controlPending.delete(changingControl); renderActive(); } }
  });
}
$('interrupt').addEventListener('click', async () => {
  try { const s = getActive(); await request('takeover', { sessionId: s.id }); await request('input', { sessionId: s.id, data: '\x03', revision: sessions.get(s.id).revision }); terminals.get(s.id).term.focus(); } catch (e) { toast(e.message); }
});
$('private').addEventListener('click', async () => {
  try {
    const s = getActive();
    if (s.privateMode && !confirm('关闭私密后，Agent 可看到当前画面和仍保留的滚动历史。若包含敏感内容，请先“清空全部历史”。确认关闭私密？')) return;
    await request('privacy', { sessionId: s.id, privateMode: !s.privateMode });
  } catch (e) { toast(e.message); }
});
$('clear-history').addEventListener('click', async () => {
  try {
    const s = getActive();
    if (!confirm('清空当前画面及全部滚动历史？所有窗口和 Agent 同时生效，远端程序继续运行。已发送到聊天中的内容无法撤回。')) return;
    await request('clear-history', { sessionId: s.id });
  } catch (e) { toast(e.message); }
});
$('copy-session').addEventListener('click', async () => {
  try { const s = getActive(); await navigator.clipboard.writeText(s.id); toast('已复制 sessionId；发给指定 Agent 认领观察。转交运行中的程序，请点击“释放输入权”。'); }
  catch { toast(`请手动复制 sessionId：${activeId}`); }
});
let resizeTimer; window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitActive, 100); });
window.addEventListener('storage', event => {
  if (event.key === dismissedStorageKey && event.newValue) {
    try {
      const ids = JSON.parse(event.newValue);
      if (Array.isArray(ids)) for (const id of ids) {
        if (typeof id !== 'string' || id.length !== 36) continue;
        dismissedTabs.add(id);
        if (sessions.get(id)?.status === 'closed') dismissClosedTab(id, false);
      }
    } catch {}
    return;
  }
  if (event.key !== authStorageKey || !event.newValue || event.newValue === token) return;
  token = event.newValue; clearTimeout(reconnectTimer);
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(); else connect();
});
connect();

let importCandidates = [];
$('import-config').addEventListener('click', async () => {
  try {
    const result = await api('/api/ssh-config'); importCandidates = result.candidates;
    $('import-path').textContent = result.configPath; $('import-candidates').replaceChildren();
    const saved = new Set(profiles.map(p => `${p.host}:${p.port}:${p.username}`));
    for (const [index, candidate] of importCandidates.entries()) {
      const row = element('label', 'import-candidate'), checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.value = String(index);
      const p = candidate.profile, duplicate = saved.has(`${p.host}:${p.port}:${p.username}`);
      checkbox.disabled = !candidate.valid || duplicate;
      const text = element('div'); text.append(element('strong', '', candidate.alias), element('div', 'profile-address', `${p.username || '(未指定用户)'}@${p.host}:${p.port}`));
      if (p.identityFile) text.append(element('div', 'import-key', p.identityFile));
      const notes = [...candidate.notes]; if (duplicate) notes.push('已存在相同连接'); if (!candidate.valid) notes.push('请手动添加并补全字段');
      if (notes.length) text.append(element('div', 'import-warning', notes.join(' · ')));
      row.append(checkbox, text); $('import-candidates').append(row);
    }
    if (!importCandidates.length) $('import-candidates').append(element('p', 'muted', '没有发现可直接添加的 Host 别名。通配符配置不会作为服务器导入。'));
    $('import-notes').textContent = result.notes.join(' · '); $('import-dialog').showModal();
  } catch (e) { toast(e.message); }
});
$('import-close').addEventListener('click', () => $('import-dialog').close());
$('import-save').addEventListener('click', async () => {
  const selected = [...$('import-candidates').querySelectorAll('input:checked')]; if (!selected.length) { toast('请先勾选服务器。'); return; }
  $('import-save').disabled = true; let added = 0;
  try {
    for (const checkbox of selected) { await api('/api/profiles', { method: 'POST', body: JSON.stringify(importCandidates[Number(checkbox.value)].profile) }); added++; checkbox.checked = false; checkbox.disabled = true; }
    $('import-dialog').close(); toast(`已添加 ${added} 个服务器配置，之后独立维护。`);
  } catch (e) { toast(`已添加 ${added} 项；${e.message}`); }
  finally { $('import-save').disabled = false; }
});
