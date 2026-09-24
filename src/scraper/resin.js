/**
 * Resin 粘性代理池接入
 * ============================================================
 * Resin 通过 Platform + Account 识别业务身份，提供基于身份的粘性代理。
 * 本项目所有「涉及具体账号」的网络请求都发生在浏览器里（登录、提取），
 * 因此以【正向代理】为主路径；同时提供【反向代理】工具函数供 Node 直连使用。
 *
 * 账号身份（Account）使用 account.id：
 *   - 账号创建时即生成，登录前就存在（不会出现登录阶段无标识可用）
 *   - 永久稳定不变（不像邮箱可改），保证 Resin 眼里同一账号始终同一网络身份
 *   - 因此无需 TempIdentity + inherit-lease 流程
 *
 * 配置来源（优先级）：控制台保存的设置 > 环境变量（.env）
 *   getResinConfig() 统一读取，保存后下次任务启动浏览器即生效，无需重启。
 *
 * 正向代理（浏览器）：proxy 指向 resin 主机端口，Proxy Auth 用户名 = Platform.Account，
 *   密码 = Token。Chromium 对该 context 的所有请求都会带上认证 → 同账号同一出口 IP。
 *
 * 反向代理（Node 直连）：<resin_url>/Platform/protocol/host/path?query，
 *   请求头 X-Resin-Account: <Account>。
 */
const net = require('net');
const tls = require('tls');
const config = require('../config');

let _store = null;
function store() {
  if (!_store) _store = require('../store');
  return _store;
}

/** 当前生效配置：控制台设置 > 环境变量 */
function getResinConfig() {
  let settings = {};
  try { settings = store().getSettings() || {}; } catch (e) { /* store 未就绪时用 env */ }
  const url = (settings.resinUrl || '').trim() || (config.resinUrl || '').trim();
  const platform = (settings.resinPlatformName || '').trim() || (config.resinPlatformName || 'Default');
  return { url, platform };
}

/** 配置来源：'settings'（控制台保存）| 'env'（环境变量）| ''（未配置） */
function getResinSource() {
  let settings = {};
  try { settings = store().getSettings() || {}; } catch (e) { /* noop */ }
  if ((settings.resinUrl || '').trim()) return 'settings';
  if ((config.resinUrl || '').trim()) return 'env';
  return '';
}

/** 是否启用了 Resin（控制台开关优先：手动停用后即使配了 URL 也不走代理） */
function isEnabled() {
  let settings = {};
  try { settings = store().getSettings() || {}; } catch (e) { /* store 未就绪时用 env */ }
  if (settings.resinEnabled === false) return false;
  return !!getResinConfig().url;
}

/** 控制台开关状态：{ effective, manuallyEnabled, manuallyDisabled, configured } */
function getEnabledState() {
  let settings = {};
  try { settings = store().getSettings() || {}; } catch (e) { /* noop */ }
  const configured = !!getResinConfig().url;
  const manuallyDisabled = settings.resinEnabled === false;
  const manuallyEnabled = settings.resinEnabled === true;
  return {
    effective: !manuallyDisabled && configured,
    manuallyEnabled,
    manuallyDisabled,
    configured,
  };
}

/** 解析 resin_url：http://127.0.0.1:2260/my-token → { origin, token, base } */
function parseResinUrl(resinUrl) {
  const u = new URL(resinUrl);
  const token = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const origin = u.origin;
  return { origin, token, base: token ? `${origin}/${token}` : origin };
}

function _cfg() {
  const { url, platform } = getResinConfig();
  return { ...parseResinUrl(url), platform, url };
}

/**
 * 正向代理配置（Playwright 的 proxy 选项对象）
 * @param {string} accountId 账号稳定标识（account.id）
 */
function forwardProxy(accountId) {
  const { origin, token, platform } = _cfg();
  return {
    server: origin,
    username: `${platform}.${accountId}`,
    password: token,
  };
}

/**
 * 正向代理 URL（CloakBrowser 等需要字符串形式的场景）
 * 形如 http://Platform.Account:Token@host:port
 */
function forwardProxyUrl(accountId) {
  const { origin, token, platform } = _cfg();
  const u = new URL(origin);
  const user = encodeURIComponent(`${platform}.${accountId}`);
  return `http://${user}:${encodeURIComponent(token)}@${u.host}`;
}

/**
 * 反向代理 URL：把目标 URL 改写为 <resin_url>/Platform/protocol/host/path?query
 */
function reverseProxyUrl(targetUrl, accountId) {
  const { base, platform } = _cfg();
  const t = new URL(targetUrl);
  const protocol = t.protocol.replace(':', '');
  return `${base}/${platform}/${protocol}/${t.host}${t.pathname}${t.search}`;
}

/** 反向代理请求头 */
function reverseProxyHeaders(accountId) {
  return { 'X-Resin-Account': String(accountId) };
}

/** 反向代理请求封装（Node 直连场景用；本项目浏览器流量走正代，此函数备用） */
async function reverseProxyFetch(targetUrl, accountId, opts = {}) {
  const url = reverseProxyUrl(targetUrl, accountId);
  const headers = { ...reverseProxyHeaders(accountId), ...(opts.headers || {}) };
  return fetch(url, { ...opts, headers });
}

/** 脱敏显示（把 token 换成 ***，用于日志/界面） */
function maskUrl(resinUrl) {
  try {
    const { origin, token } = parseResinUrl(resinUrl);
    return token ? `${origin}/***` : origin;
  } catch (e) {
    return '(无效的 RESIN_URL)';
  }
}

/* ============================================================
 * 连通性测试（控制台「测试连通」按钮用）
 * ============================================================ */

const IP_ECHO = 'https://api.ipify.org?format=json';

/** 反代测试：经 <resin_url>/Platform/https/api.ipify.org 取出口 IP */
async function testReverse(resinUrl, platform, accountId, timeoutMs = 15000) {
  const t0 = Date.now();
  try {
    const { base } = parseResinUrl(resinUrl);
    const url = `${base}/${platform}/https/api.ipify.org?format=json`;
    const res = await fetch(url, {
      headers: { 'X-Resin-Account': String(accountId) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const m = text.match(/"ip"\s*:\s*"([^"]+)"/);
    return {
      ok: res.ok && !!m,
      ip: m ? m[1] : null,
      status: res.status,
      ms: Date.now() - t0,
      error: res.ok ? (m ? null : '响应中未找到 IP 字段: ' + text.slice(0, 120)) : `HTTP ${res.status}: ${text.slice(0, 120)}`,
    };
  } catch (e) {
    return { ok: false, ip: null, ms: Date.now() - t0, error: (e && e.message || String(e)).split('\n')[0] };
  }
}

/** 正代测试：原生 Node CONNECT 隧道经代理取出口 IP（与浏览器走正代同一条路） */
function testForward(resinUrl, platform, accountId, timeoutMs = 15000) {
  const t0 = Date.now();
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    let parsed;
    try { parsed = parseResinUrl(resinUrl); } catch (e) {
      return finish({ ok: false, ip: null, ms: Date.now() - t0, error: 'RESIN_URL 无效: ' + e.message });
    }
    const u = new URL(parsed.origin);
    const socket = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    socket.setTimeout(timeoutMs);
    const fail = msg => { socket.destroy(); finish({ ok: false, ip: null, ms: Date.now() - t0, error: msg }); };
    socket.on('error', e => fail('代理连接失败: ' + e.message));
    socket.on('timeout', () => fail('代理连接超时'));
    socket.on('connect', () => {
      const auth = 'Basic ' + Buffer.from(`${platform}.${accountId}:${parsed.token}`).toString('base64');
      socket.write(`CONNECT api.ipify.org:443 HTTP/1.1\r\nHost: api.ipify.org:443\r\nProxy-Authorization: ${auth}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    socket.on('data', function onData(chunk) {
      buf += chunk.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.slice(0, idx);
      const status = Number(head.split(' ')[1] || 0);
      if (status !== 200) return fail('代理拒绝 CONNECT: ' + head.split('\r\n')[0]);
      socket.removeListener('data', onData);
      const rest = buf.slice(idx + 4);
      const tlsSock = tls.connect({ socket, servername: 'api.ipify.org' }, () => {
        tlsSock.write('GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\nUser-Agent: resin-test\r\nAccept: */*\r\n\r\n');
      });
      let body = rest;
      tlsSock.on('data', d => { body += d.toString(); });
      tlsSock.on('end', () => {
        const m = body.match(/"ip"\s*:\s*"([^"]+)"/);
        finish({ ok: !!m, ip: m ? m[1] : null, ms: Date.now() - t0, error: m ? null : '响应中未找到 IP: ' + body.slice(-200) });
      });
      tlsSock.on('error', e => fail('TLS 失败: ' + e.message));
    });
  });
}

/**
 * 完整连通性测试（正代 + 反代都测）
 * @param {object} cfg { resinUrl, platform, accountId }
 */
async function testConnectivity({ resinUrl, platform, accountId }) {
  const url = (resinUrl || '').trim();
  if (!url) return { ok: false, error: '请先填写 Resin URL' };
  let parsed;
  try { parsed = parseResinUrl(url); } catch (e) {
    return { ok: false, error: 'RESIN_URL 格式无效: ' + e.message };
  }
  if (!parsed.token) return { ok: false, error: 'RESIN_URL 缺少 Token（路径应形如 /my-token）' };
  if (!accountId) return { ok: false, error: '缺少测试账号身份（Account）' };

  const [reverse, forward] = await Promise.all([
    testReverse(url, platform, accountId),
    testForward(url, platform, accountId),
  ]);
  const ok = reverse.ok || forward.ok;
  return {
    ok,
    reverse,
    forward,
    sameIp: reverse.ok && forward.ok ? reverse.ip === forward.ip : null,
    account: accountId,
    platform,
  };
}

module.exports = {
  getResinConfig,
  getResinSource,
  isEnabled,
  getEnabledState,
  parseResinUrl,
  forwardProxy,
  forwardProxyUrl,
  reverseProxyUrl,
  reverseProxyHeaders,
  reverseProxyFetch,
  maskUrl,
  testConnectivity,
};
