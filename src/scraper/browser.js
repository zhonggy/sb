/**
 * 浏览器管理：Playwright 持久化上下文（每账号独立 profile，自动复用 Cookie 会话）
 * + 反检测初始化脚本 + clipboard / window.open 劫持（用于捕获优惠码和跳转链接）
 *
 * 两种引擎（BROWSER_ENGINE 环境变量切换）：
 *   playwright（默认）——Playwright 自带/完整 Chromium
 *   cloak——CloakBrowser 源码级隐身 Chromium（87 个 C++ 补丁，过 Cloudflare
 *           Turnstile 通过率更高；免费版无需 key，最新版需 license key；
 *           启动失败自动回退到 playwright，不影响主流程）
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const config = require('../config');
const { log } = require('../utils');

const PROFILES_DIR = path.join(config.dataDir, 'profiles');

function profileDirFor(accountId) {
  const dir = path.join(PROFILES_DIR, accountId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 在页面加载前注入：掩盖自动化特征 + 劫持 clipboard / window.open */
const initScript = () => {
  // webdriver 标志
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  // chrome 对象
  if (!window.chrome) window.chrome = { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };
  // 权限查询
  const origQuery = navigator.permissions && navigator.permissions.query;
  if (origQuery) {
    navigator.permissions.query = p =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(p);
  }
  // 语言
  Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
  // 插件数量
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });

  // ---- 捕获通道 ----
  window.__clips = [];
  window.__opens = [];
  try {
    navigator.clipboard.writeText = t => { window.__clips.push(String(t)); return Promise.resolve(); };
    navigator.clipboard.readText = () => Promise.resolve(window.__clips[window.__clips.length - 1] || '');
  } catch (e) { /* noop */ }
  // copy 事件兜底（有些站点用 execCommand 复制）
  document.addEventListener('copy', e => {
    try {
      const t = e.clipboardData && e.clipboardData.getData('text/plain');
      if (t) window.__clips.push(String(t));
    } catch (err) { /* noop */ }
  }, true);
  const origOpen = window.open;
  window.open = (url, ...rest) => {
    try { window.__opens.push(String(url)); } catch (e) { /* noop */ }
    return origOpen ? origOpen.call(window, url, ...rest) : null;
  };
};

async function launchPlaywrightContext(accountId) {
  const launchOpts = {
    headless: config.headless,
    channel: config.channel,
    locale: config.locale,
    timezoneId: config.timezoneId,
    viewport: { width: 1366, height: 900 },
    userAgent: config.userAgent,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--window-size=1366,900',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (config.proxyUrl) launchOpts.proxy = { server: config.proxyUrl };

  const context = await chromium.launchPersistentContext(profileDirFor(accountId), launchOpts);
  await afterLaunch(context);
  return context;
}

/** CloakBrowser 引擎（ESM 包，CJS 用动态 import） */
async function launchCloakContext(accountId) {
  const { launchPersistentContext } = await import('cloakbrowser');
  const opts = {
    userDataDir: profileDirFor(accountId),
    headless: config.headless,
    locale: config.locale,
    timezone: config.timezoneId,
    userAgent: config.userAgent,
    viewport: { width: 1366, height: 900 },
    humanize: config.cloakHumanize,
    geoip: config.cloakGeoip,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  };
  if (config.proxyUrl) opts.proxy = config.proxyUrl;
  if (config.cloakLicenseKey) opts.licenseKey = config.cloakLicenseKey;
  const context = await launchPersistentContext(opts);
  await afterLaunch(context);
  return context;
}

/** 启动后的通用处理：注入捕获脚本 + 剪贴板权限 */
async function afterLaunch(context) {
  await context.addInitScript(initScript);
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'https://www.studentbeans.com',
    });
  } catch (e) { /* 某些渠道不支持则忽略 */ }
  return context;
}

async function launchContext(accountId) {
  if (config.browserEngine === 'cloak') {
    try {
      log(null, 'info', `浏览器引擎: CloakBrowser（humanize=${config.cloakHumanize}${config.cloakLicenseKey ? '，已配置 license key' : '，无 key 使用免费版'}）`);
      return await launchCloakContext(accountId);
    } catch (e) {
      log(null, 'warn', `CloakBrowser 启动失败，回退到 Playwright 引擎: ${String(e && e.message || e).split('\n')[0]}`);
    }
  }
  return launchPlaywrightContext(accountId);
}

/** 给已存在的 context 追加 init script 的辅助（保持向后兼容） */
module.exports = { launchContext, profileDirFor, initScript };
