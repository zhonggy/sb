/**
 * Resin 粘性代理池接入
 * ============================================================
 * Resin 通过 Platform + Account 识别业务身份，提供基于身份的粘性代理。
 * 本项目所有「涉及具体账号」的网络请求都发生在浏览器里（登录、提取），
 * 因此以【正向代理】为主路径；同时提供【反向代理】工具函数供 Node 直连使用。
 *
 * 账号身份（Account）使用 account.id：
 *   - 账号创建时即生成，登录前就存在（不会出现登录阶段无标识可用）
 *   - 永久稳定不变（不像邮箱可改），保证 Resin 眼里同一个账号始终同一个网络身份
 *   - 因此无需 TempIdentity + inherit-lease 流程
 *
 * 正向代理（浏览器）：proxy 指向 resin 主机端口，Proxy Auth 用户名 = Platform.Account，
 *   密码 = Token（RESIN_TOKEN）。Chromium 对该 context 的所有请求（含 iframe/子资源）
 *   都会带上认证 → 同一账号始终拿到同一出口 IP。
 *
 * 反向代理（Node 直连）：<resin_url>/Platform/protocol/host/path?query，
 *   请求头 X-Resin-Account: <Account>。
 */
const config = require('../config');

/** 解析 resin_url：http://127.0.0.1:2260/my-token → { origin, token, base } */
function parseResinUrl(resinUrl) {
  const u = new URL(resinUrl);
  const token = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const origin = u.origin;
  return { origin, token, base: token ? `${origin}/${token}` : origin };
}

/** 是否启用了 Resin */
function isEnabled() {
  return !!config.resinUrl;
}

/**
 * 正向代理配置（Playwright 的 proxy 选项对象）
 * @param {string} accountId 账号稳定标识（account.id）
 */
function forwardProxy(accountId) {
  const { origin, token } = parseResinUrl(config.resinUrl);
  return {
    server: origin,
    username: `${config.resinPlatformName}.${accountId}`,
    password: token,
  };
}

/**
 * 正向代理 URL（CloakBrowser 等需要字符串形式的场景）
 * 形如 http://Platform.Account:Token@host:port
 */
function forwardProxyUrl(accountId) {
  const { origin, token } = parseResinUrl(config.resinUrl);
  const u = new URL(origin);
  const user = encodeURIComponent(`${config.resinPlatformName}.${accountId}`);
  return `http://${user}:${encodeURIComponent(token)}@${u.host}`;
}

/**
 * 反向代理 URL：把目标 URL 改写为 <resin_url>/Platform/protocol/host/path?query
 * @param {string} targetUrl 目标地址，如 https://api.example.com/healthz
 * @param {string} accountId 账号稳定标识
 */
function reverseProxyUrl(targetUrl, accountId) {
  const { base } = parseResinUrl(config.resinUrl);
  const t = new URL(targetUrl);
  const protocol = t.protocol.replace(':', ''); // http / https
  return `${base}/${config.resinPlatformName}/${protocol}/${t.host}${t.pathname}${t.search}`;
}

/** 反向代理请求头 */
function reverseProxyHeaders(accountId) {
  return { 'X-Resin-Account': String(accountId) };
}

/**
 * 反向代理请求封装（Node 直连场景用；本项目目前浏览器流量走正代，此函数备用）
 */
async function reverseProxyFetch(targetUrl, accountId, opts = {}) {
  const url = reverseProxyUrl(targetUrl, accountId);
  const headers = { ...reverseProxyHeaders(accountId), ...(opts.headers || {}) };
  const res = await fetch(url, { ...opts, headers });
  return res;
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

module.exports = {
  parseResinUrl,
  isEnabled,
  forwardProxy,
  forwardProxyUrl,
  reverseProxyUrl,
  reverseProxyHeaders,
  reverseProxyFetch,
  maskUrl,
};
