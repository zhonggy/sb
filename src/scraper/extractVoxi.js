/**
 * Voxi 优惠码提取（基于实测 DOM）：
 *  - 揭示按钮: div[data-testid="offer-issuance-button"] 内的 button/a（每卡片一个，精确定位）
 *  - 卡片标题: 按钮最近的 article 祖先的第一行文本
 *  - 点击后可能: ①弹模态框显示优惠码 ②复制到剪贴板 ③新标签页打开 VOXI 官网
 *  三路都捕获：init script 已劫持 navigator.clipboard.writeText 和 window.open
 */
const config = require('../config');
const { sleep, log, extractCodeFromText } = require('../utils');
const { acceptCookies, forceRemoveOverlays } = require('./login');

// 每张卡片一个 issuance 按钮（section 外层容器不会重复命中）
const BTN_SEL = 'div[data-testid="offer-issuance-button"] button, div[data-testid="offer-issuance-button"] a';

async function readCaptureChannels(page) {
  return page.evaluate(() => ({
    clips: (window.__clips || []).slice(-5),
    opens: (window.__opens || []).slice(-5),
  }));
}

/** 在可见模态框中找优惠码 */
async function findCodeInModals(page) {
  return page.evaluate(() => {
    const out = [];
    const nodes = [...document.querySelectorAll('[role="dialog"], [data-testid*="modal" i], [class*="modal" i], [class*="Modal"]')]
      .filter(el => el.offsetWidth || el.offsetHeight);
    for (const n of nodes) {
      const text = (n.innerText || '').replace(/\s+/g, ' ').trim();
      if (text) out.push(text.slice(0, 500));
    }
    return out;
  });
}

/** 页面中任何显眼的独立"优惠码"文本元素 */
async function findCodeElements(page) {
  return page.evaluate(() => {
    const out = [];
    const all = [...document.querySelectorAll('span, div, p, strong, b')];
    for (const el of all) {
      const t = (el.innerText || '').trim();
      if (/^[A-Z0-9]{4,16}$/.test(t) && (el.offsetWidth || el.offsetHeight) && el.children.length === 0) {
        out.push(t);
      }
    }
    return out.slice(0, 10);
  });
}

async function saveArtifact(job, name, buffer, mime = 'text/plain') {
  if (!buffer) return null;
  const fs = require('fs');
  const path = require('path');
  await fs.promises.mkdir(job.artifactsDir, { recursive: true });
  const file = path.join(job.artifactsDir, name);
  await fs.promises.writeFile(file, buffer);
  if (!Array.isArray(job.artifacts)) job.artifacts = [];
  job.artifacts.push(file);
  return { name, file, mime };
}

async function extractVoxi(page, account, job, opts = {}) {
  const results = [];
  const artifacts = [];
  const maxOffers = opts.maxOffers || config.maxOffersPerRun;
  const stepDelay = opts.stepDelayMs != null ? opts.stepDelayMs : config.stepDelayMs;

  log(job, 'info', `打开 VOXI 优惠页: ${config.voxiPageUrl}`);
  const gotoStart = Date.now();
  await page.goto(config.voxiPageUrl, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
  // 等待揭示按钮出现
  await page.waitForSelector(BTN_SEL, { timeout: 30000 }).catch(() => {});
  await sleep(2500);
  await acceptCookies(page, job);
  log(job, 'info', `页面就绪（${((Date.now() - gotoStart) / 1000).toFixed(1)}s）`);

  // 若被踢回登录页则中止（登录态失效）
  if (/accounts\.studentbeans\.com/.test(page.url())) {
    artifacts.push(await saveArtifact(job, 'redirected-login.png', await page.screenshot().catch(() => null), 'image/png'));
    return { results, artifacts, error: '访问 VOXI 页时被重定向到登录页，会话无效' };
  }

  const btnCount = await page.locator(BTN_SEL).count();
  log(job, 'info', `发现 ${btnCount} 个「Get code」按钮`);
  if (!btnCount) {
    artifacts.push(await saveArtifact(job, 'voxi-page.html', await page.content()));
    return { results, artifacts, error: '未发现优惠按钮（页面结构可能变化，已保存页面快照）' };
  }

  const limit = Math.min(btnCount, maxOffers);
  const seenKeys = new Set();
  const seenTitles = new Set();

  for (let i = 0; i < limit; i++) {
    if (job.cancelRequested) { log(job, 'warn', '任务被取消'); break; }

    // 每轮重新定位（DOM 可能因 React 重渲染变化）
    let btn;
    try {
      btn = page.locator(BTN_SEL).nth(i);
      await btn.waitFor({ state: 'attached', timeout: 5000 });
    } catch (e) {
      log(job, 'warn', `按钮 ${i} 已不可见，跳过`);
      continue;
    }

    // 取卡片标题：就近找 article 祖先，取其第一行非空文本
    let title = '';
    try {
      title = await btn.evaluate(el => {
        let a = el.closest ? el.closest('article') : null;
        if (!a) {
          a = el;
          for (let k = 0; k < 8 && a.parentElement; k++) {
            a = a.parentElement;
            if (a.querySelector && a.querySelectorAll('div[data-testid="offer-issuance-button"]').length === 1 &&
                (a.innerText || '').length > 80) break;
          }
        }
        const line = (a.innerText || '').split('\n').find(l => l.trim());
        return line ? line.trim() : '';
      });
    } catch (e) { /* 保持空 */ }
    if (!title) title = `Offer ${i + 1}`;
    title = title.slice(0, 300);

    if (seenTitles.has(title)) {
      log(job, 'warn', `跳过重复卡片: ${title.slice(0, 50)}`);
      continue;
    }
    seenTitles.add(title);
    log(job, 'info', `[${i + 1}/${limit}] 处理: ${title.slice(0, 70)}`);

    // 记录弹窗基线 + 清空捕获通道
    const pagesBefore = page.context().pages().length;
    await page.evaluate(() => { try { window.__clips = []; window.__opens = []; } catch (e) { /* noop */ } });

    // 点击 Get code
    try {
      await forceRemoveOverlays(page);
      await btn.scrollIntoViewIfNeeded({ timeout: 5000 });
      await btn.click({ timeout: config.clickTimeoutMs });
    } catch (e) {
      log(job, 'warn', `点击"Get code"失败: ${e.message.split('\n')[0]}`);
      // 点击失败也可能是被重定向到登录页导致元素消失 → 检查会话
      if (/accounts\.studentbeans\.com/.test(page.url())) {
        log(job, 'error', '点击后被重定向到登录页，会话已失效，终止本轮');
        artifacts.push(await saveArtifact(job, 'session-lost.png', await page.screenshot().catch(() => null), 'image/png'));
        return { results, artifacts, error: '会话失效：点击后被重定向到登录页' };
      }
      continue;
    }

    await sleep(stepDelay + 1500);

    // ---- 三路捕获优惠码 ----
    let code = null;
    let url = null;
    let source = '';

    const cap = await readCaptureChannels(page);
    if (cap.clips.length) { code = cap.clips[cap.clips.length - 1]; source = 'clipboard'; }
    if (!code) {
      for (const m of await findCodeInModals(page)) {
        const c = extractCodeFromText(m);
        if (c) { code = c; source = 'modal'; break; }
      }
    }
    if (!code) {
      const els = await findCodeElements(page);
      if (els.length) { code = els[0]; source = 'element'; }
    }

    // ---- 捕获跳转链接（open site 新标签页） ----
    const pages = page.context().pages();
    for (let p = pages.length - 1; p >= pagesBefore; p--) {
      const pg = pages[p];
      if (pg === page) continue;
      try {
        await pg.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        const u = pg.url();
        if (u && /^https?:/.test(u)) url = u;
      } catch (e) { /* noop */ }
      await pg.close().catch(() => {});
    }
    if (!url && cap.opens.length) url = cap.opens[cap.opens.length - 1];

    // 兜底：再查一次模态（有些站点延迟弹窗）
    if (!code) {
      for (const m of await findCodeInModals(page)) {
        const c = extractCodeFromText(m);
        if (c) { code = c; source = 'modal-retry'; break; }
      }
    }

    artifacts.push(await saveArtifact(job, `offer-${i + 1}.png`, await page.screenshot().catch(() => null), 'image/png'));

    if (code || url) {
      const row = {
        id: require('../utils').uid('res_'),
        accountId: account.id,
        accountLabel: account.label || account.email,
        jobId: job.id,
        title,
        code: code || null,
        url: url || null,
        codeSource: source || null,
        extractedAt: new Date().toISOString(),
      };
      const key = (code || '') + '|' + (url || '');
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        results.push(row);
      }
      log(job, 'ok', `✓ 优惠码: ${code || '(未取到)'}  |  链接: ${url ? url.slice(0, 80) : '(无)'}`);
    } else {
      log(job, 'warn', `未捕获到优惠码/链接: ${title.slice(0, 60)}`);
    }

    // 点击后被弹去登录页 = 会话失效
    if (/accounts\.studentbeans\.com/.test(page.url())) {
      log(job, 'error', '点击后被重定向到登录页，会话已失效，终止本轮');
      artifacts.push(await saveArtifact(job, 'session-lost.png', await page.screenshot().catch(() => null), 'image/png'));
      return { results, artifacts, error: '会话失效：点击后被重定向到登录页' };
    }

    await sleep(400);
  }

  return { results, artifacts };
}

module.exports = { extractVoxi };
