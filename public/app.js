/* ============ 控制台前端逻辑 ============ */
'use strict';

const $ = s => document.querySelector(s);
const state = { accounts: [], jobs: [], results: [], settings: {}, authRequired: false };

/* ---------- 工具 ---------- */
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !state.authRequired) { showAuthGate(); throw new Error('未授权'); }
  if (res.status === 401) { showAuthGate(); throw new Error('未授权'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function statusBadge(s) {
  const map = { success: '成功', failed: '失败', needs_verify: '待验证', running: '运行中', queued: '排队中', cancelled: '已取消' };
  return `<span class="badge ${s || 'muted'}">${map[s] || s || '—'}</span>`;
}

/* ---------- 鉴权 ---------- */
function showAuthGate() { $('#auth-gate').classList.remove('hidden'); }
function hideAuthGate() { $('#auth-gate').classList.add('hidden'); }

$('#auth-submit').addEventListener('click', doLogin);
$('#auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('#btn-logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

async function doLogin() {
  try {
    const r = await api('/api/login', { method: 'POST', body: { password: $('#auth-password').value } });
    if (r.ok) { hideAuthGate(); toast('登录成功', 'ok'); bootstrap(); }
  } catch (e) {
    $('#auth-error').textContent = e.message || '密码错误';
  }
}

/* ---------- 渲染 ---------- */
function renderAccounts() {
  const box = $('#account-list');
  box.innerHTML = '';
  if (!state.accounts.length) {
    box.innerHTML = '<p class="empty">还没有账号，先在上方添加。</p>';
    return;
  }
  for (const a of state.accounts) {
    const item = document.createElement('div');
    item.className = 'account-item';
    item.innerHTML = `
      <div class="top">
        <span class="email">${a.label || a.email}</span>
        ${statusBadge(a.lastStatus)}
      </div>
      <div class="meta">${a.email} · ${a.hasCookies ? '已导入Cookie(' + (a.cookieCount || 0) + '条)' : (a.passwordSet ? '密码登录' : '无凭据')} · 最近: ${fmtTime(a.lastRunAt)}</div>
      ${a.lastError ? `<div class="meta" style="color:var(--red)">${a.lastError}</div>` : ''}
      <div class="ops">
        <button class="btn small primary" data-act="run">▶ 运行</button>
        <button class="btn small" data-act="cookies">导入Cookie</button>
        <button class="btn small" data-act="edit">编辑</button>
        <button class="btn small danger" data-act="del">删除</button>
      </div>`;
    item.querySelector('[data-act="run"]').addEventListener('click', () => runAccount(a.id));
    item.querySelector('[data-act="cookies"]').addEventListener('click', () => importCookies(a));
    item.querySelector('[data-act="edit"]').addEventListener('click', () => editAccount(a));
    item.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`确定删除账号「${a.label || a.email}」？其历史结果会保留。`)) return;
      await api('/api/accounts/' + a.id, { method: 'DELETE' });
      toast('已删除');
      bootstrap();
    });
    box.appendChild(item);
  }
}

function renderFilterOptions() {
  const sel = $('#filter-account');
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部账号</option>' +
    state.accounts.map(a => `<option value="${a.id}">${a.label || a.email}</option>`).join('');
  sel.value = state.accounts.some(a => a.id === cur) ? cur : '';
}

function renderResults() {
  const f = $('#filter-account').value;
  const rows = state.results.filter(r => !f || r.accountId === f);
  const tbody = $('#results-table tbody');
  tbody.innerHTML = '';
  $('#results-empty').classList.toggle('hidden', rows.length > 0);
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtTime(r.extractedAt)}</td>
      <td>${r.accountLabel || '—'}</td>
      <td>${escapeHtml(r.title || '')}</td>
      <td class="code-cell">${r.code ? escapeHtml(r.code) : '<span style="color:var(--muted)">未取到</span>'}
        ${r.code ? `<button class="btn ghost small copy" data-copy="${escapeHtml(r.code)}">复制</button>` : ''}</td>
      <td>${r.url ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" style="color:var(--accent-2)">打开链接 ↗</a>
        <button class="btn ghost small copy" data-copy="${escapeHtml(r.url)}">复制</button>` : '—'}</td>`;
    tr.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.copy).then(() => toast('已复制', 'ok'));
    }));
    tbody.appendChild(tr);
  }
}

function renderJobs() {
  const box = $('#job-list');
  box.innerHTML = '';
  if (!state.jobs.length) { box.innerHTML = '<p class="empty">暂无任务</p>'; return; }
  for (const j of state.jobs.slice(0, 30)) {
    const div = document.createElement('div');
    div.className = 'job-item';
    div.innerHTML = `
      <span>${j.accountLabel || j.accountId}</span>
      ${statusBadge(j.status)}
      <span style="color:var(--muted)">${fmtTime(j.startedAt)}</span>
      <span>${(j.resultIds || []).length ? j.resultIds.length + '条' : ''}</span>
      ${j.status === 'running' || j.status === 'queued' ? `<button class="btn ghost small" data-cancel="${j.id}">取消</button>` : ''}
      ${j.error ? `<span style="color:var(--red);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(j.error)}">${escapeHtml(j.error)}</span>` : ''}`;
    if (j.artifacts && j.artifacts.length) {
      const arts = document.createElement('div');
      arts.className = 'arts';
      arts.innerHTML = '📸 ' + j.artifacts.map(a =>
        `<a href="/artifacts/${a}" target="_blank" rel="noopener">${escapeHtml(a.split('/').pop())}</a>`).join(' ');
      div.appendChild(arts);
    }
    const c = div.querySelector('[data-cancel]');
    if (c) c.addEventListener('click', () => api('/api/jobs/' + j.id + '/cancel', { method: 'POST' }).then(bootstrap));
    box.appendChild(div);
  }
}

function renderSettings() {
  $('#set-schedule-enabled').checked = !!state.settings.scheduleEnabled;
  $('#set-schedule-cron').value = state.settings.scheduleCron || '';
  $('#set-max-offers').value = state.settings.maxOffersPerRun || 10;
  $('#set-delay').value = state.settings.stepDelayMs != null ? state.settings.stepDelayMs : 1500;
  $('#scheduler-status').textContent = state.settings.scheduleEnabled
    ? `定时: ${state.settings.scheduleCron}` : '定时: 未启用';
  $('#scheduler-status').className = 'badge ' + (state.settings.scheduleEnabled ? 'ok' : 'muted');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 操作 ---------- */
async function runAccount(id) {
  try {
    const r = await api('/api/jobs', { method: 'POST', body: { accountId: id } });
    toast(r.queued ? '任务已入队' : (r.reason || '未入队'), r.queued ? 'ok' : 'error');
    bootstrap();
  } catch (e) { toast(e.message, 'error'); }
}

/* ---------- Cookie 导入弹窗 ---------- */
let cookieAccId = null;

function openCookieModal(a) {
  cookieAccId = a.id;
  $('#cookie-modal-acc').textContent = `（${a.label || a.email}）`;
  $('#cookie-input').value = '';
  $('#cookie-preview').innerHTML = a.cookieCount
    ? `<span class="warn">当前已导入 ${a.cookieCount} 条 Cookie（重新粘贴保存可覆盖）</span>` : '';
  $('#cookie-modal').classList.remove('hidden');
}
function closeCookieModal() {
  $('#cookie-modal').classList.add('hidden');
  cookieAccId = null;
}

$('#cookie-cancel').addEventListener('click', closeCookieModal);

$('#cookie-parse').addEventListener('click', async () => {
  const text = $('#cookie-input').value.trim();
  if (!text) return toast('请先粘贴 Cookie', 'error');
  try {
    const r = await api(`/api/accounts/${cookieAccId}/cookies/parse`, { method: 'POST', body: { text } });
    const fmtName = { header: 'Cookie 请求头', json: 'JSON', netscape: 'cookies.txt' }[r.format] || r.format;
    const p = $('#cookie-preview');
    if (r.ok) {
      p.innerHTML = `<span class="ok">✓ 识别为${fmtName}，共 ${r.count} 条` +
        (r.sessionLikeCount
          ? `，其中 <b>${r.sessionLikeCount} 条疑似会话 Cookie</b>（${r.sessionLikeNames.slice(0, 3).join(', ')}）`
          : '') + '</span>' +
        (r.warnings && r.warnings.length ? `<br><span class="warn">⚠ ${r.warnings.join('；')}</span>` : '');
    } else {
      p.innerHTML = `<span class="err">✗ ${(r.warnings || []).join('；') || '未解析到 Cookie'}</span>`;
    }
  } catch (e) { toast(e.message, 'error'); }
});

$('#cookie-save').addEventListener('click', async () => {
  const text = $('#cookie-input').value.trim();
  if (!text) return toast('请先粘贴 Cookie', 'error');
  try {
    const r = await api(`/api/accounts/${cookieAccId}/cookies`, { method: 'POST', body: { text } });
    toast(`已导入 ${r.count} 条 Cookie${r.sessionLikeCount ? `（含 ${r.sessionLikeCount} 条会话 Cookie）` : ''}，下次运行将优先使用`, 'ok');
    closeCookieModal();
    bootstrap();
  } catch (e) { toast('导入失败: ' + e.message, 'error'); }
});

$('#cookie-clear').addEventListener('click', async () => {
  if (!cookieAccId) return;
  try {
    await api(`/api/accounts/${cookieAccId}/cookies`, { method: 'DELETE' });
    toast('已清除导入的 Cookie', 'ok');
    closeCookieModal();
    bootstrap();
  } catch (e) { toast(e.message, 'error'); }
});

async function importCookies(a) {
  openCookieModal(a);
}

async function editAccount(a) {
  const pwd = prompt(`修改「${a.label || a.email}」的密码（留空保持不变）：`, '');
  if (pwd) await api('/api/accounts/' + a.id, { method: 'PUT', body: { password: pwd } });
  const label = prompt('修改备注名（留空不变）：', a.label || '');
  if (label && label !== a.label) await api('/api/accounts/' + a.id, { method: 'PUT', body: { label } });
  bootstrap();
}

$('#account-form').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    label: $('#acc-label').value.trim(),
    email: $('#acc-email').value.trim(),
    password: $('#acc-password').value,
  };
  if (!body.email) return toast('请输入邮箱', 'error');
  if (!body.password) return toast('请输入密码', 'error');
  try {
    await api('/api/accounts', { method: 'POST', body });
    toast('账号已添加', 'ok');
    $('#acc-label').value = ''; $('#acc-email').value = ''; $('#acc-password').value = '';
    bootstrap();
  } catch (err) { toast(err.message, 'error'); }
});

$('#btn-run-all').addEventListener('click', async () => {
  try {
    const r = await api('/api/jobs/run-all', { method: 'POST' });
    const ok = r.results.filter(x => x.queued).length;
    toast(`已入队 ${ok} 个账号`, 'ok');
    bootstrap();
  } catch (e) { toast(e.message, 'error'); }
});

$('#btn-save-settings').addEventListener('click', async () => {
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: {
        scheduleEnabled: $('#set-schedule-enabled').checked,
        scheduleCron: $('#set-schedule-cron').value.trim() || '0 8 * * *',
        maxOffersPerRun: parseInt($('#set-max-offers').value, 10) || 10,
        stepDelayMs: parseInt($('#set-delay').value, 10) || 1500,
      },
    });
    toast('设置已保存', 'ok');
    bootstrap();
  } catch (e) { toast(e.message, 'error'); }
});

$('#filter-account').addEventListener('change', renderResults);
$('#btn-refresh-results').addEventListener('click', () => api('/api/results').then(d => { state.results = d.results; renderResults(); }));
$('#btn-clear-log').addEventListener('click', () => { $('#log-console').innerHTML = ''; });

/* ---------- 日志（SSE） ---------- */
function logLine(line) {
  const box = $('#log-console');
  const div = document.createElement('div');
  div.className = 'log-line ' + (line.level || 'info');
  const d = new Date(line.ts);
  const p = n => String(n).padStart(2, '0');
  div.innerHTML = `<span class="ts">${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}</span><span class="msg">${escapeHtml(line.msg)}</span>`;
  box.appendChild(div);
  while (box.children.length > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function connectEvents() {
  const es = new EventSource('/api/events');
  const dot = $('#conn-status');
  es.onopen = () => { dot.textContent = '● 已连接'; dot.className = 'badge ok'; };
  es.onerror = () => { dot.textContent = '● 已断开，重连中'; dot.className = 'badge failed'; };
  es.onmessage = ev => {
    try { logLine(JSON.parse(ev.data)); } catch (e) { /* noop */ }
  };
}

/* ---------- 启动 ---------- */
async function bootstrap() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    state.authRequired = cfg.authRequired;
    if (cfg.authRequired) { $('#btn-logout').classList.remove('hidden'); }
    const data = await api('/api/bootstrap');
    state.accounts = data.accounts;
    state.jobs = data.jobs;
    state.results = data.results;
    state.settings = data.settings;
    hideAuthGate();
    renderAccounts(); renderFilterOptions(); renderResults(); renderJobs(); renderSettings();
  } catch (e) {
    if (!state.authRequired) toast('加载失败: ' + e.message, 'error');
  }
}

bootstrap();
connectEvents();
setInterval(() => {
  // 轻量轮询：任务运行时每 5s 刷新状态
  const busy = state.jobs.some(j => j.status === 'running' || j.status === 'queued');
  if (busy && document.visibilityState === 'visible') {
    api('/api/bootstrap').then(data => {
      state.jobs = data.jobs; state.accounts = data.accounts;
      renderJobs(); renderAccounts();
    }).catch(() => {});
  }
}, 5000);
