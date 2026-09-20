/**
 * 浏览器管理：Playwright 持久化上下文（每账号独立 profile，自动复用 Cookie 会话）
 * + 反检测初始化脚本 + clipboard / window.open 劫持（用于捕获优惠码和跳转链接）
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const config = require('../config');

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

async function launchContext(accountId) {
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
  await context.addInitScript(initScript);
  // 授予剪贴板权限（http/https 源）
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'https://www.studentbeans.com',
    });
  } catch (e) { /* 某些渠道不支持则忽略 */ }
  return context;
}

/** 给已存在的 context 追加 init script 的辅助（保持向后兼容） */
module.exports = { launchContext, profileDirFor, initScript };
