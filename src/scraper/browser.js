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
const { log, sleep } = require('../utils');
const resin = require('./resin');

const PROFILES_DIR = path.join(config.dataDir, 'profiles');

/** 杀掉仍占用该 profile 的僵尸 Chromium 进程（上次异常退出/容器重启的残留）。
 *  调用时机在启动新浏览器之前，此时命中的进程必然是残留（串行队列不会有正常运行的）。 */
function killZombieBrowsers(dir) {
  try {
    if (!fs.existsSync('/proc')) return 0; // 非 Linux
    const pids = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p));
    let killed = 0;
    for (const pid of pids) {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmd.includes(dir) && /chrome|chromium/i.test(cmd)) {
          process.kill(Number(pid), 'SIGKILL');
          killed++;
        }
      } catch (e) { /* 进程已消失或无权限 */ }
    }
    if (killed > 0) {
      log(null, 'warn', `杀死了 ${killed} 个占用该 profile 的残留浏览器进程（${dir}）`);
    }
    return killed;
  } catch (e) {
    return 0;
  }
}

/** Chromium profile 锁文件（上次异常退出会残留，导致新启动报
 *  "The profile appears to be in use by another Chromium process" / exitCode=21）。
 *  任务队列是串行的、每账号同时只有一个浏览器，启动前清理是安全的。 */
function cleanProfileLocks(dir) {
  const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  let removed = 0;
  const details = [];
  for (const f of locks) {
    const p = path.join(dir, f);
    try {
      if (fs.existsSync(p)) {
        let target = '';
        try { target = ' -> ' + fs.readlinkSync(p); } catch (e) { /* 不是 symlink */ }
        fs.unlinkSync(p);
        removed++;
        details.push(`已删 ${f}${target}`);
      }
    } catch (e) {
      details.push(`${f} 删除失败: ${e.message}`);
    }
  }
  // 无论有没有删到都打日志——「无锁文件但 Chrome 仍报占用」是重要诊断线索
  // （说明锁被活进程瞬间重建，或有外部容器/机器在占用同一数据卷）
  log(null, removed > 0 ? 'warn' : 'info',
    `profile 锁检查（${dir}）: ${details.length ? details.join('；') : '未发现锁文件'}`);
  return removed;
}

function profileDirFor(accountId) {
  const dir = path.join(PROFILES_DIR, accountId);
  fs.mkdirSync(dir, { recursive: true });
  killZombieBrowsers(dir);
  cleanProfileLocks(dir);
  return dir;
}

/** 在页面加载前注入：掩盖自动化特征 + 劫持 clipboard / window.open */
const initScript = () => {
  // 所有补丁都防御式执行：CloakBrowser 在 C++ 层已处理多数指纹（webdriver 等），
  // 重复 defineProperty 会和它的补丁冲突甚至导致浏览器崩溃（实测踩坑）——
  // 因此只在属性「可配置」时才打补丁，且全部包 try/catch。
  const safe = fn => { try { fn(); } catch (e) { /* 补丁浏览器可能锁定了该属性，跳过 */ } };
  const defineIfConfigurable = (obj, key, descriptor) => {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (d && d.configurable === false) return; // 被锁定（如 CloakBrowser 的补丁），不碰
    Object.defineProperty(obj, key, { ...descriptor, configurable: true });
  };

  // webdriver 标志
  safe(() => defineIfConfigurable(navigator, 'webdriver', { get: () => undefined }));
  // chrome 对象
  safe(() => { if (!window.chrome) window.chrome = { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} }; });
  // 权限查询
  safe(() => {
    const origQuery = navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = p =>
        p && p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(p);
    }
  });
  // 语言
  safe(() => defineIfConfigurable(navigator, 'languages', { get: () => ['en-GB', 'en'] }));
  // 插件数量
  safe(() => defineIfConfigurable(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }));

  // ---- 捕获通道（优惠码提取的核心功能）----
  safe(() => {
    window.__clips = [];
    window.__opens = [];
    navigator.clipboard.writeText = t => { window.__clips.push(String(t)); return Promise.resolve(); };
    navigator.clipboard.readText = () => Promise.resolve(window.__clips[window.__clips.length - 1] || '');
  });
  // copy 事件兜底（有些站点用 execCommand 复制）
  document.addEventListener('copy', e => {
    try {
      const t = e.clipboardData && e.clipboardData.getData('text/plain');
      if (t) window.__clips.push(String(t));
    } catch (err) { /* noop */ }
  }, true);
  safe(() => {
    const origOpen = window.open;
    window.open = (url, ...rest) => {
      try { window.__opens.push(String(url)); } catch (e) { /* noop */ }
      return origOpen ? origOpen.call(window, url, ...rest) : null;
    };
  });
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
  // 代理优先级：Resin 粘性代理池（按账号）> 传统 PROXY_URL
  if (resin.isEnabled()) {
    launchOpts.proxy = resin.forwardProxy(accountId);
  } else if (config.proxyUrl) {
    launchOpts.proxy = { server: config.proxyUrl };
  }

  // 启动；撞到 profile 锁残留（上次异常退出）时，清锁+杀残留进程后重试一次
  let context = null;
  try {
    context = await chromium.launchPersistentContext(profileDirFor(accountId), launchOpts);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/profile.*in use|SingletonLock|process_singleton|has been closed/i.test(msg)) {
      log(null, 'warn', `浏览器启动撞到 profile 锁（${msg.split('\n')[0].slice(0, 120)}），清理残留后重试一次…`);
      const dir = profileDirFor(accountId);
      killZombieBrowsers(dir);
      cleanProfileLocks(dir);
      await sleep(500);
      context = await chromium.launchPersistentContext(dir, launchOpts);
    } else {
      throw e;
    }
  }
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
  // 代理优先级：Resin 粘性代理池（按账号）> 传统 PROXY_URL
  if (resin.isEnabled()) {
    // CloakBrowser 的 proxy 是字符串形式 http://user:pass@host:port
    opts.proxy = resin.forwardProxyUrl(accountId);
  } else if (config.proxyUrl) {
    opts.proxy = config.proxyUrl;
  }
  if (config.cloakLicenseKey) opts.licenseKey = config.cloakLicenseKey;
  // 启动；撞到 profile 锁残留时同样清锁重试一次
  let context = null;
  try {
    context = await launchPersistentContext({ ...opts, userDataDir: profileDirFor(accountId) });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/profile.*in use|SingletonLock|process_singleton|has been closed/i.test(msg)) {
      log(null, 'warn', `CloakBrowser 启动撞到 profile 锁，清理残留后重试一次…`);
      const dir = profileDirFor(accountId);
      killZombieBrowsers(dir);
      cleanProfileLocks(dir);
      await sleep(500);
      context = await launchPersistentContext({ ...opts, userDataDir: dir });
    } else {
      throw e;
    }
  }
  await afterLaunch(context);
  // 预热导航：CloakBrowser 的 license 校验是惰性的（启动时不查，首次导航才触发），
  // 这里做一次真实导航把 license/会话限制类错误暴露出来——失败则关掉并抛出，
  // 让上层 launchContext 的回退逻辑切到 Playwright 引擎。
  try {
    const warm = context.pages()[0] || await context.newPage();
    await warm.goto(config.siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await warm.close().catch(() => {});
  } catch (e) {
    await context.close().catch(() => {});
    throw e;
  }
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

/**
 * 启动浏览器上下文
 * @param {string} accountId 账号 ID（同时作为 Resin Account 身份）
 * @param {string} [engineOverride] 引擎覆盖：'playwright' | 'cloak'（任务级回退重试时用）
 */
async function launchContext(accountId, engineOverride) {
  const engine = (engineOverride || config.browserEngine || '').toLowerCase();
  if (resin.isEnabled()) {
    const cfg = resin.getResinConfig();
    log(null, 'info', `Resin 粘性代理: Platform=${cfg.platform} Account=${accountId}（${resin.maskUrl(cfg.url)}）`);
  } else if (resin.getResinConfig().url) {
    log(null, 'info', 'Resin 代理已停用（本次任务直连，不走代理）');
  }
  if (engine === 'cloak') {
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
module.exports = { launchContext, profileDirFor, initScript, resin };
