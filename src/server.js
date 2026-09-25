/**
 * Express 服务器：REST API + SSE 实时日志 + 静态控制台
 */
const path = require('path');
const express = require('express');
const config = require('./config');
const store = require('./store');
const jobRunner = require('./jobRunner');
const scheduler = require('./scheduler');
const { bus, maskAccount, toCsv, log, shortTitle, sortByPrice } = require('./utils');
const { parseCookies } = require('./cookieParser');
const resin = require('./scraper/resin');

const app = express();
app.use(express.json({ limit: '2mb' }));

// cookie 解析中间件（手写，免依赖）——须在鉴权之前
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie;
  if (raw) {
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  next();
});

// ---------- 会话（简单 token cookie） ----------
const SESSION_COOKIE = 'voxi_session';
let sessions = new Set();

function sessionAuth(req, res, next) {
  if (!config.adminPassword) return next(); // 未设置密码则完全开放
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (token && sessions.has(token)) return next();
  return res.status(401).json({ error: '未登录或会话已过期' });
}

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!config.adminPassword) return res.json({ ok: true, authRequired: false });
  if (password === config.adminPassword) {
    const token = require('./utils').uid('sess_');
    sessions.add(token);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 864e5 });
    return res.json({ ok: true, authRequired: true });
  }
  res.status(401).json({ ok: false, error: '密码错误' });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res.json({ authRequired: !!config.adminPassword, version: '1.0.0' });
});

// ---------- 以下接口全部需要登录 ----------
app.use('/api', sessionAuth);

app.get('/api/bootstrap', (req, res) => {
  const jobs = store.listJobs().slice(0, 50);
  const artDir = path.join(config.dataDir, 'artifacts');
  res.json({
    accounts: store.listAccounts().map(maskAccount),
    jobs: jobs.map(j => ({
      ...j,
      logs: (j.logs || []).slice(-30),
      artifacts: (j.artifacts || []).map(f => {
        try { return path.relative(artDir, f).split(path.sep).join('/'); } catch (e) { return null; }
      }).filter(Boolean),
    })),
    results: store.listResults(null, 200),
    settings: store.getSettings(),
    scheduler: { enabled: !!store.getSettings().scheduleEnabled, cron: store.getSettings().scheduleCron },
    resin: resin.isEnabled()
      ? { enabled: true, platform: resin.getResinConfig().platform, url: resin.maskUrl(resin.getResinConfig().url) }
      : { enabled: false },
    queue: { pending: jobRunner.activeJobs.size },
  });
});

// ---------- 账号管理 ----------
app.post('/api/accounts', (req, res) => {
  const { label, email, password } = req.body || {};
  if (!email || (!password && !(req.body || {}).cookies)) {
    return res.status(400).json({ error: '邮箱和密码必填（或提供 Cookie）' });
  }
  const acc = store.addAccount({ label, email, password, cookies: Array.isArray(req.body.cookies) ? req.body.cookies : null });
  res.json({ ok: true, account: maskAccount(acc) });
});

app.put('/api/accounts/:id', (req, res) => {
  const acc = store.getAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: '账号不存在' });
  const patch = {};
  for (const k of ['label', 'email', 'password']) {
    if (req.body[k] != null && req.body[k] !== '') patch[k] = req.body[k];
  }
  store.updateAccount(acc.id, patch);
  res.json({ ok: true, account: maskAccount(store.getAccount(acc.id)) });
});

app.delete('/api/accounts/:id', (req, res) => {
  store.removeAccount(req.params.id);
  res.json({ ok: true });
});

/** 解析预览（不保存）：前端粘贴后先调这个验证格式 */
app.post('/api/accounts/:id/cookies/parse', (req, res) => {
  const input = req.body && (req.body.text != null ? req.body.text : req.body.cookies);
  const parsed = parseCookies(input);
  res.json({
    ok: parsed.count > 0,
    format: parsed.format,
    count: parsed.count,
    names: parsed.names,
    warnings: parsed.warnings,
    sessionLikeCount: parsed.sessionLikeCount,
    sessionLikeNames: parsed.sessionLikeNames,
  });
});

/** 导入 Cookie（跳过密码登录，兜底 Turnstile/邮箱验证场景）
 *  支持：DevTools Cookie 请求头字符串 / Cookie 编辑器 JSON / cookies.txt / JSON 数组
 */
app.post('/api/accounts/:id/cookies', (req, res) => {
  const acc = store.getAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: '账号不存在' });
  const input = req.body && (req.body.text != null ? req.body.text : req.body.cookies);
  const parsed = parseCookies(input);
  if (!parsed.count) {
    return res.status(400).json({ error: '未解析到有效 Cookie', warnings: parsed.warnings });
  }
  store.updateAccount(acc.id, { cookies: parsed.cookies });
  res.json({
    ok: true,
    count: parsed.count,
    format: parsed.format,
    warnings: parsed.warnings,
    sessionLikeCount: parsed.sessionLikeCount,
  });
});

app.delete('/api/accounts/:id/cookies', (req, res) => {
  const acc = store.getAccount(req.params.id);
  if (!acc) return res.status(404).json({ error: '账号不存在' });
  store.updateAccount(acc.id, { cookies: null });
  res.json({ ok: true });
});

// ---------- 任务 ----------
app.post('/api/jobs', (req, res) => {
  const { accountId } = req.body || {};
  try {
    const r = jobRunner.enqueue(accountId);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/jobs/run-all', (req, res) => {
  const r = jobRunner.runAll();
  res.json({ ok: true, results: r });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  res.json({ ok: jobRunner.cancelJob(req.params.id) });
});

// ---------- 结果 ----------
app.get('/api/results', (req, res) => {
  res.json({ results: store.listResults(req.query.accountId, parseInt(req.query.limit || '500', 10)) });
});

/** 清空提取结果（?accountId= 只清该账号，否则全部） */
app.delete('/api/results', (req, res) => {
  const removed = store.clearResults(req.query.accountId);
  log(null, 'info', `清空提取结果 ${removed} 条${req.query.accountId ? '（账号: ' + req.query.accountId + '）' : ''}`);
  res.json({ ok: true, removed });
});

/** 清空任务记录（运行中/排队中的保留） */
app.delete('/api/jobs', (req, res) => {
  const removed = store.clearJobs();
  log(null, 'info', `清空任务记录 ${removed} 条`);
  res.json({ ok: true, removed });
});

/** 导出文件名：<账号邮箱>_<日期>.<ext>
 *  单账号筛选 → 该账号邮箱；全部导出且结果只属于一个账号 → 该邮箱；
 *  多账号混合 → voxi-results_<日期> */
function buildExportName(rows, accountId, ext) {
  const ids = accountId ? [String(accountId)] : [...new Set(rows.map(r => r.accountId).filter(Boolean))];
  const emails = [...new Set(ids.map(id => {
    const a = store.getAccount(id);
    return a && a.email ? a.email : '';
  }).filter(Boolean))];
  const safe = s => String(s).replace(/[^a-zA-Z0-9._@+-]+/g, '_');
  const day = new Date().toISOString().slice(0, 10);
  const base = emails.length === 1 ? safe(emails[0]) : 'voxi-results';
  return `${base}_${day}.${ext}`;
}

app.get('/api/export', (req, res) => {
  const rows = store.listResults(req.query.accountId, 5000);
  const fmt = (req.query.format || 'csv').toLowerCase();
  if (fmt === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${buildExportName(rows, req.query.accountId, 'json')}"`);
    res.json(rows);
  } else if (fmt === 'txt') {
    // 每行: 优惠----优惠码----链接（优惠只保留到 a month，按价格升序 10→12→15→20）
    const txt = sortByPrice(rows)
      .map(r => `${shortTitle(r.title)}----${r.code || ''}----${r.url || ''}`)
      .join('\n');
    res.setHeader('Content-Disposition', `attachment; filename="${buildExportName(rows, req.query.accountId, 'txt')}"`);
    res.type('text/plain; charset=utf-8').send(txt);
  } else {
    const csv = toCsv(rows.map(r => ({
      时间: r.extractedAt, 账号: r.accountLabel, 优惠: r.title, 优惠码: r.code || '', 链接: r.url || '',
    })), ['时间', '账号', '优惠', '优惠码', '链接']);
    res.setHeader('Content-Disposition', `attachment; filename="${buildExportName(rows, req.query.accountId, 'csv')}"`);
    res.type('text/csv; charset=utf-8').send('\ufeff' + csv);
  }
});

// ---------- Resin 代理 ----------
// 当前生效配置（脱敏）+ 来源；测试/保存/清除
app.get('/api/resin', (req, res) => {
  const cfg = resin.getResinConfig();
  const source = resin.getResinSource();
  const en = resin.getEnabledState();
  res.json({
    enabled: en.effective,
    manuallyDisabled: en.manuallyDisabled,
    manuallyEnabled: en.manuallyEnabled,
    configured: en.configured,
    source, // settings=控制台保存 env=.env ''=未配置
    platform: cfg.platform,
    url: cfg.url ? resin.maskUrl(cfg.url) : '',
    // 控制台保存过的值原样返回供编辑（env 提供的不返回明文）
    savedUrl: source === 'settings' ? cfg.url : '',
    savedPlatform: source === 'settings' ? cfg.platform : '',
  });
});

/** 启用开关（卡片勾选框，只改开关不动 URL） */
app.post('/api/resin/toggle', (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  store.updateSettings({ resinEnabled: enabled });
  const en = resin.getEnabledState();
  log(null, 'info', enabled ? 'Resin 代理已手动启用' : 'Resin 代理已手动停用（任务将不走代理）');
  res.json({ ok: true, enabled: en.effective, manuallyDisabled: en.manuallyDisabled, configured: en.configured });
});

app.put('/api/resin', (req, res) => {
  const url = (req.body && req.body.resinUrl != null ? String(req.body.resinUrl) : '').trim();
  const platform = (req.body && req.body.resinPlatformName != null ? String(req.body.resinPlatformName) : '').trim();
  if (url) {
    // 基本校验
    let u;
    try { u = new URL(url); } catch (e) {
      return res.status(400).json({ error: 'RESIN_URL 格式无效（应形如 http://host:port/token）' });
    }
    if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'RESIN_URL 只支持 http/https' });
    if (!u.pathname.replace(/^\/+/, '')) return res.status(400).json({ error: 'RESIN_URL 路径需包含 Token（形如 /my-token）' });
  }
  store.updateSettings({
    resinUrl: url,
    resinPlatformName: platform || 'Default',
    resinEnabled: url ? true : null, // 保存新配置时自动启用；清空时回到跟随状态
  });
  log(null, 'info', url ? `Resin 代理配置已保存（${resin.maskUrl(url)}, Platform=${platform || 'Default'}）` : 'Resin 代理配置已清除（回退 .env）');
  const cfg = resin.getResinConfig();
  res.json({ ok: true, enabled: !!cfg.url, platform: cfg.platform, url: cfg.url ? resin.maskUrl(cfg.url) : '', source: resin.getResinSource() });
});

app.delete('/api/resin', (req, res) => {
  store.updateSettings({ resinUrl: '', resinPlatformName: '', resinEnabled: null });
  log(null, 'info', 'Resin 代理配置已清除（回退 .env）');
  const cfg = resin.getResinConfig();
  res.json({ ok: true, enabled: !!cfg.url, platform: cfg.platform, url: cfg.url ? resin.maskUrl(cfg.url) : '', source: resin.getResinSource() });
});

// 连通性测试：可传表单值（未保存也能测），也可用已生效配置
app.post('/api/resin/test', async (req, res) => {
  const body = req.body || {};
  const cfg = resin.getResinConfig();
  const resinUrl = (body.resinUrl != null && String(body.resinUrl).trim()) ? String(body.resinUrl).trim() : cfg.url;
  const platform = (body.platformName != null && String(body.platformName).trim()) ? String(body.platformName).trim() : cfg.platform;
  // 测试身份：指定账号 > 第一个账号 > acc_test
  let accountId = (body.accountId || '').trim();
  if (!accountId) {
    const first = store.listAccounts()[0];
    accountId = first ? first.id : 'acc_connectivity_test';
  }
  try {
    const r = await resin.testConnectivity({ resinUrl, platform, accountId });
    log(null, r.ok ? 'info' : 'warn', `Resin 连通性测试[${accountId}]: ${r.ok ? '成功' : '失败'}${r.reverse && r.reverse.ok ? ' 反代IP=' + r.reverse.ip : ''}${r.forward && r.forward.ok ? ' 正代IP=' + r.forward.ip : ''}${r.ok ? '' : ' ' + (r.error || (r.reverse && r.reverse.error) || (r.forward && r.forward.error))}`);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message || String(e)) });
  }
});

// ---------- 设置 ----------
app.get('/api/settings', (req, res) => res.json(store.getSettings()));

app.put('/api/settings', (req, res) => {
  const patch = {};
  if (typeof req.body.headless === 'boolean') patch.headless = req.body.headless;
  if (typeof req.body.scheduleEnabled === 'boolean') patch.scheduleEnabled = req.body.scheduleEnabled;
  if (typeof req.body.scheduleCron === 'string') patch.scheduleCron = req.body.scheduleCron;
  if (req.body.maxOffersPerRun != null) patch.maxOffersPerRun = Math.max(1, parseInt(req.body.maxOffersPerRun, 10) || 10);
  if (req.body.stepDelayMs != null) patch.stepDelayMs = Math.max(0, parseInt(req.body.stepDelayMs, 10) || 1500);
  // CloakBrowser（桌面版默认引擎）：license key（留空=用免费版）
  if (req.body.cloakLicenseKey != null) patch.cloakLicenseKey = String(req.body.cloakLicenseKey).trim();
  if (typeof req.body.cloakHumanize === 'boolean') patch.cloakHumanize = req.body.cloakHumanize;
  store.updateSettings(patch);
  if ('scheduleEnabled' in patch || 'scheduleCron' in patch) scheduler.restartScheduler();
  res.json(store.getSettings());
});

// ---------- SSE 实时日志 ----------
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const onLog = line => {
    try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch (e) { /* noop */ }
  };
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
  bus.on('log', onLog);
  req.on('close', () => { bus.removeListener('log', onLog); clearInterval(ping); });
});

// ---------- 截图等工件 ----------
app.use('/artifacts', sessionAuth, express.static(path.join(config.dataDir, 'artifacts'), { maxAge: '5m' }));

// ---------- 静态控制台 ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', sessionAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[server] error:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`\n  VOXI Student Beans 优惠码提取器`);
  console.log(`  控制台: http://localhost:${config.port}`);
  console.log(`  访问密码: ${config.adminPassword ? '已启用' : '未设置（任何人可访问）'}\n`);
  scheduler.startScheduler();
});

server.requestTimeout = 0;
server.headersTimeout = 300000;

module.exports = app;
