/**
 * FlareSolverr 客户端（可选，默认禁用）
 *
 * FlareSolverr 是一个用 undetected-chromedriver 过 Cloudflare 质询的服务
 * （官方仓库 2026 年仍在活跃维护，v3.5+ 甚至支持 Turnstile）。
 * 本项目把它作为「登录被 Cloudflare/Turnstile 拦截时的兜底」：
 *   1. 先让 FlareSolverr 打开 studentbeans.com 过质询，拿到 cf_clearance 等
 *      Cookie + 它所用浏览器的 userAgent；
 *   2. 用同一 userAgent 启动 Playwright 浏览器并注入这些 Cookie 重试登录。
 *   （cf_clearance 绑定 UA + 出口 IP，所以两边必须一致：开了 Resin/代理时，
 *    FlareSolverr 也会走同一代理。）
 *
 * 配置（环境变量）：
 *   FLARESOLVERR_URL           服务地址，如 http://flaresolverr:8191/v1（空 = 禁用；
 *                              Docker Compose 已内置默认值，设 off/false/disabled 也可禁用）
 *   FLARESOLVERR_TIMEOUT_MS    整体 HTTP 请求超时，默认 90000
 *   FLARESOLVERR_MAX_TIMEOUT   传给 FlareSolverr 的质询求解超时，默认 60000
 */
const config = require('../config');
const { log } = require('../utils');
const resin = require('./resin');

/** 归一化服务地址：接受 http://host:8191 / http://host:8191/v1（尾斜杠随意） */
function baseUrl() {
  let base = String(config.flaresolverrUrl || '').trim().replace(/\/+$/, '');
  if (/\/v1$/i.test(base)) base = base.replace(/\/v1$/i, '');
  return base;
}

function isEnabled() {
  return !!config.flaresolverrUrl;
}

/** 健康检查（GET /health），失败抛错 */
async function health() {
  const res = await fetch(`${baseUrl()}/health`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data.status !== 'ok') throw new Error(`状态异常: ${JSON.stringify(data).slice(0, 120)}`);
  return true;
}

/** Selenium cookie 格式 → Playwright addCookies 格式 */
function toPlaywrightCookies(cookies) {
  const SAME_SITE = { no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' };
  return (cookies || [])
    .filter(c => c && c.name && c.domain)
    .map(c => {
      const out = { name: c.name, value: String(c.value), domain: c.domain, path: c.path || '/' };
      // Selenium 用 expiry（unix 秒），个别版本用 expires；负值/缺省 = 会话 Cookie
      const exp = (typeof c.expiry === 'number' && c.expiry > 0) ? c.expiry
        : (typeof c.expires === 'number' && c.expires > 0) ? c.expires : null;
      if (exp) out.expires = exp;
      if (typeof c.secure === 'boolean') out.secure = c.secure;
      if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
      const ss = SAME_SITE[String(c.sameSite || '').toLowerCase()];
      if (ss) out.sameSite = ss;
      return out;
    });
}

/**
 * 让 FlareSolverr 打开 url 过 Cloudflare 质询
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.proxyUrl]  代理（含认证则形如 http://user:pass@host:port）
 * @param {number} [opts.maxTimeout]
 * @returns {Promise<{cookies: Array, userAgent: string|null, finalUrl: string}>} Playwright 格式
 */
async function solve(url, opts = {}) {
  const body = {
    cmd: 'request.get',
    url,
    maxTimeout: opts.maxTimeout || config.flaresolverrMaxTimeout,
    returnOnlyCookies: true, // 只要 Cookie + UA，不传整页 HTML
  };
  if (opts.proxyUrl) {
    // FlareSolverr 的 proxy 支持 {url, username, password}；把内联认证拆出来更稳
    try {
      const u = new URL(opts.proxyUrl);
      if (u.username) {
        body.proxy = {
          url: `${u.protocol}//${u.host}`,
          username: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password || ''),
        };
      } else {
        body.proxy = { url: opts.proxyUrl };
      }
    } catch (e) {
      body.proxy = { url: opts.proxyUrl };
    }
  }
  const res = await fetch(`${baseUrl()}/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.flaresolverrTimeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json().catch(() => { throw new Error('响应不是有效 JSON'); });
  if (data.status !== 'ok') {
    throw new Error(String(data.message || '未知错误').slice(0, 200));
  }
  const sol = data.solution || {};
  return {
    cookies: toPlaywrightCookies(sol.cookies),
    userAgent: sol.userAgent || null,
    turnstileToken: sol.turnstile_token || null,
    finalUrl: sol.url || url,
  };
}

/**
 * 为某个账号做「预热」：健康检查 → 按浏览器同款代理让 FlareSolverr 过质询
 * 先解主站（主路径），再解登录域（best-effort：登录表单的 Turnstile 挂在 accounts
 * 子域，预热它的 cf_clearance/__cf_bm 能提高 widget 在我们浏览器里的加载成功率）
 * @returns {Promise<{cookies, userAgent}|null>} 失败/不可用返回 null（不抛错，不阻断主流程）
 */
async function warm(job, accountId) {
  if (!isEnabled()) return null;
  try {
    await health();
  } catch (e) {
    log(job, 'warn', `FlareSolverr 不可达（${baseUrl()}，${e.message}），跳过预热`);
    return null;
  }
  // 代理优先级与 browser.js 保持一致：Resin（按账号粘性）> PROXY_URL。
  // 必须与浏览器同一出口 IP，否则 cf_clearance 无效。
  const proxyUrl = resin.isEnabled() ? resin.forwardProxyUrl(accountId) : (config.proxyUrl || null);
  log(job, 'info', `FlareSolverr 预热中: ${config.siteUrl}${proxyUrl ? '（与浏览器同代理出口）' : '（直连）'}…`);
  let sol;
  try {
    sol = await solve(config.siteUrl, { proxyUrl });
  } catch (e) {
    log(job, 'warn', `FlareSolverr 预热失败: ${String(e.message || e).slice(0, 200)}`);
    return null;
  }
  if (!sol.cookies.length) {
    log(job, 'warn', 'FlareSolverr 预热完成但未返回 Cookie，放弃注入');
    return null;
  }

  // best-effort：再解一次登录域（失败不影响主站 Cookie 注入）
  try {
    const loginSol = await solve(config.loginUrl, { proxyUrl });
    if (loginSol.cookies.length) {
      const merged = new Map(sol.cookies.map(c => [`${c.name}|${c.domain}`, c]));
      for (const c of loginSol.cookies) merged.set(`${c.name}|${c.domain}`, c);
      const before = sol.cookies.length;
      sol.cookies = [...merged.values()];
      log(job, 'info', `登录域预热完成：合并后共 ${sol.cookies.length} 条 Cookie（主站 ${before} + 登录域增量）`);
    }
  } catch (e) {
    log(job, 'info', `登录域预热未成功（不影响主站 Cookie 注入）: ${String(e.message || e).slice(0, 150)}`);
  }

  log(job, 'info', `FlareSolverr 预热完成: ${sol.cookies.length} 条 Cookie（${sol.cookies.map(c => c.name).slice(0, 12).join(', ')}）`);
  if (!sol.userAgent) {
    log(job, 'warn', 'FlareSolverr 未返回 userAgent，cf_clearance 可能因 UA 不匹配而失效');
  } else {
    log(job, 'info', `浏览器将复用 FlareSolverr 的 UA: ${sol.userAgent}`);
  }
  return sol;
}

module.exports = { isEnabled, health, solve, warm, toPlaywrightCookies };
