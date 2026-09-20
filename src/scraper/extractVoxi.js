/**
 * Voxi 优惠码提取（基于用户实测的正确流程）：
 *
 *  实际流程（2026-09 用户确认）：
 *   1. 列表页每张卡片有 "Get code & open site" 按钮（共 4 个优惠）
 *   2. 点击后【弹出新标签页】
 *   3. 新标签页里显示优惠码（形如 STB274EA12TO0）
 *   4. 新标签页里有 "Re-open the VOXI mobile website" 按钮——
 *      这个按钮的链接才是要提取的正确链接
 *   5. 关闭新标签页，回列表页，重复下一个
 *
 *  因此本模块以「新标签页」为捕获核心：
 *   - 点击 → waitForEvent('popup') 等新标签页
 *   - 在新标签页内：提取优惠码文本 + 找 re-open 按钮的链接
 *   - 对新标签页截图 + 保存全文（排查证据）
 *   - 关闭新标签页，重新打开列表页，处理下一张卡片
 */
const config = require('../config');
const { sleep, log, extractCodeFromText } = require('../utils');
const { acceptCookies, forceRemoveOverlays } = require('./login');

// 每张卡片一个 issuance 按钮
const BTN_SEL = 'div[data-testid="offer-issuance-button"] button, div[data-testid="offer-issuance-button"] a';
const INTERNAL_HOST = /(^|\.)studentbeans\.com$/;

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

/** 从文本中提取优惠码：优先 STB 开头（Student Beans 码格式），再走通用规则 */
function extractCode(text) {
  if (!text) return null;
  const m = String(text).match(/\bSTB[A-Z0-9]{6,14}\b/i);
  if (m) return m[0].toUpperCase();
  return extractCodeFromText(text);
}

/** 在新标签页里找「Re-open the VOXI mobile website」按钮的链接 */
async function findReopenLink(popup) {
  const link = await popup.evaluate(() => {
    const els = [...document.querySelectorAll('a, button, [role="button"]')]
      .filter(el => el.offsetWidth || el.offsetHeight || el.getBoundingClientRect().width);
    // 1. 文本匹配 re-open / open the ... website / continue / visit
    const byText = els.find(el => /re-?open|open the|continue|visit|go to|shop now|website/i.test((el.innerText || '').trim()));
    const pick = el => {
      if (!el) return null;
      const href = el.href || el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || '';
      if (href && /^https?:/.test(href)) return href;
      const oc = el.getAttribute('onclick') || '';
      const m = oc.match(/https?:\/\/[^'")\s]+/);
      if (m) return m[0];
      return null;
    };
    const t = pick(byText);
    if (t) return t;
    // 2. 兜底：任何指向 voxi.co.uk 的链接
    const voxi = els.find(el => /voxi\.co\.uk/i.test(el.href || ''));
    if (voxi) return voxi.href;
    // 3. 再兜底：页面里任意 voxi.co.uk 链接（含隐藏）
    const anyVoxi = [...document.querySelectorAll('a[href*="voxi.co.uk"]')][0];
    return anyVoxi ? anyVoxi.href : null;
  }).catch(() => null);
  return link;
}

async function extractVoxi(page, account, job, opts = {}) {
  const results = [];
  const artifacts = [];
  const maxOffers = opts.maxOffers || config.maxOffersPerRun;
  const stepDelay = opts.stepDelayMs != null ? opts.stepDelayMs : config.stepDelayMs;
  const listUrl = config.voxiPageUrl;

  // ---- 网络响应拦截（兜底：接口里可能直接带 code/url） ----
  const netHits = [];
  const onResponse = async res => {
    try {
      const url = res.url();
      if (!/offer|voucher|redemption|promo|coupon|code/i.test(url)) return;
      const ct = res.headers()['content-type'] || '';
      if (!/json/.test(ct)) return;
      const text = await res.text();
      if (text.length > 2_000_000) return;
      const codes = [...text.matchAll(/"(?:code|voucher_code|promo_code|discount_code|coupon)"\s*:\s*"([^"]{3,40})"/gi)].map(m => m[1]);
      const urls = [...text.matchAll(/"(?:url|redirect_url|destination|target_url|shop_url|store_url)"\s*:\s*"(https?:[^"]+)"/gi)].map(m => m[1]);
      if (codes.length || urls.length) netHits.push({ url, codes, urls });
    } catch (e) { /* noop */ }
  };
  page.on('response', onResponse);

  const cleanup = () => { page.off('response', onResponse); };

  const gotoList = async () => {
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
    await page.waitForSelector(BTN_SEL, { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    await forceRemoveOverlays(page);
  };

  try {
    log(job, 'info', `打开 VOXI 优惠页: ${listUrl}`);
    await gotoList();

    // 被踢回登录页 = 会话失效
    if (/accounts\.studentbeans\.com|\/accounts\/authorisation\//.test(page.url())) {
      artifacts.push(await saveArtifact(job, 'redirected-login.png', await page.screenshot().catch(() => null), 'image/png'));
      return { results, artifacts, error: '访问 VOXI 页时被重定向到登录页，会话无效' };
    }

    const total = await page.locator(BTN_SEL).count();
    log(job, 'info', `发现 ${total} 个「Get code」按钮`);
    if (!total) {
      artifacts.push(await saveArtifact(job, 'voxi-page.html', await page.content()));
      artifacts.push(await saveArtifact(job, 'voxi-page.txt', await page.evaluate(() => document.body?.innerText || '').catch(() => '')));
      return { results, artifacts, error: '未发现优惠按钮（页面结构可能变化，已保存页面快照）' };
    }

    const limit = Math.min(total, maxOffers);
    const seenKeys = new Set();
    const seenTitles = new Set();

    for (let idx = 0; idx < limit; idx++) {
      if (job.cancelRequested) { log(job, 'warn', '任务被取消'); break; }

      // 每张卡片都重新打开列表页，确保页面状态干净
      log(job, 'info', `[${idx + 1}/${limit}] 打开列表页…`);
      await gotoList();

      if (/accounts\.studentbeans\.com|\/accounts\/authorisation\//.test(page.url())) {
        artifacts.push(await saveArtifact(job, 'session-lost.png', await page.screenshot().catch(() => null), 'image/png'));
        return { results, artifacts, error: '会话失效：访问优惠页被重定向到登录页' };
      }

      let btn;
      try {
        btn = page.locator(BTN_SEL).nth(idx);
        await btn.waitFor({ state: 'attached', timeout: 5000 });
      } catch (e) {
        log(job, 'warn', `按钮 ${idx} 已不可见，跳过`);
        continue;
      }

      // 卡片标题
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
      if (!title) title = `Offer ${idx + 1}`;
      title = title.slice(0, 300);

      if (seenTitles.has(title)) { log(job, 'warn', `跳过重复卡片: ${title.slice(0, 50)}`); continue; }
      seenTitles.add(title);
      log(job, 'info', `[${idx + 1}/${limit}] 处理: ${title.slice(0, 70)}`);

      // ---- 点击并等待新标签页 ----
      let popup = null;
      const popupPromise = page.waitForEvent('popup', { timeout: 20000 }).catch(() => null);
      try {
        await forceRemoveOverlays(page);
        await btn.scrollIntoViewIfNeeded({ timeout: 5000 });
        await btn.click({ timeout: config.clickTimeoutMs });
      } catch (e) {
        log(job, 'warn', `点击"Get code"失败: ${e.message.split('\n')[0]}`);
        if (/accounts\.studentbeans\.com|\/accounts\/authorisation\//.test(page.url())) {
          artifacts.push(await saveArtifact(job, 'session-lost.png', await page.screenshot().catch(() => null), 'image/png'));
          return { results, artifacts, error: '会话失效：点击后被重定向到登录页' };
        }
        continue;
      }

      popup = await popupPromise;
      if (!popup) {
        // 轮询兜底（有些浏览器/popup 事件时序差异）
        for (let t = 0; t < 20 && !popup; t++) {
          await sleep(500);
          const pages = page.context().pages();
          const fresh = pages.find(p => p !== page && !p.isClosed());
          if (fresh && pages.length > 1) popup = fresh;
        }
      }

      let code = null;
      let url = null;
      let source = null;

      if (popup) {
        log(job, 'info', '新标签页已打开，等待内容…');
        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        // 等优惠码文本出现（STB 开头）
        await popup.waitForFunction(
          () => /STB[A-Z0-9]{4,}/i.test((document.body && document.body.innerText) || ''),
          null, { timeout: 12000 }
        ).catch(() => {});
        await sleep(stepDelay > 0 ? Math.min(stepDelay, 2000) : 800);

        const popupUrl = popup.url();
        const popupText = await popup.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
        code = extractCode(popupText);
        if (code) source = 'popup-text';

        // 「Re-open the VOXI mobile website」按钮链接
        url = await findReopenLink(popup);
        if (url) source = source || 'popup-button';

        // 新标签页截图 + 全文（排查证据）
        artifacts.push(await saveArtifact(job, `offer-${idx + 1}.txt`,
          `URL: ${popupUrl}\nTITLE: ${await popup.title().catch(() => '')}\n\n${popupText}`));
        artifacts.push(await saveArtifact(job, `offer-${idx + 1}.png`,
          await popup.screenshot({ fullPage: true }).catch(() => null), 'image/png'));

        await popup.close().catch(() => {});
      } else {
        log(job, 'warn', '未检测到新标签页（可能被浏览器拦截弹窗）');
        artifacts.push(await saveArtifact(job, `offer-${idx + 1}.txt`,
          await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '')));
        artifacts.push(await saveArtifact(job, `offer-${idx + 1}.png`,
          await page.screenshot().catch(() => null), 'image/png'));
      }

      // ---- 兜底：主页面 clipboard / 模态框 ----
      if (!code) {
        const cap = await page.evaluate(() => ({
          clips: (window.__clips || []).slice(-5),
          modals: [...document.querySelectorAll('[role="dialog"], [data-testid*="modal" i], [class*="modal" i]')]
            .filter(el => el.offsetWidth || el.offsetHeight)
            .map(m => (m.innerText || '').replace(/\s+/g, ' ')),
        })).catch(() => ({}));
        if (cap.clips && cap.clips.length) { code = extractCode(cap.clips[cap.clips.length - 1]); source = 'clipboard'; }
        if (!code && cap.modals) {
          for (const m of cap.modals) { const c = extractCode(m); if (c) { code = c; source = 'modal'; break; } }
        }
      }

      // ---- 兜底：网络响应 ----
      if (!code || !url) {
        const hits = netHits.slice(-10);
        if (!code) for (const h of hits) { if (h.codes.length) { code = extractCode(h.codes[0]); source = 'network'; break; } }
        if (!url) for (const h of hits) { if (h.urls.length) { url = h.urls[0]; break; } }
      }

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
        log(job, 'ok', `✓ 优惠码: ${code || '(未取到)'}  |  链接: ${url ? url.slice(0, 90) : '(无)'}`);
      } else {
        log(job, 'warn', `未捕获到优惠码/链接: ${title.slice(0, 60)}（已保存快照供排查）`);
      }

      // 清理可能残留的弹窗
      for (const p of page.context().pages()) {
        if (p !== page && !p.isClosed()) await p.close().catch(() => {});
      }
      await sleep(300);
    }

    return { results, artifacts };
  } finally {
    cleanup();
  }
}

module.exports = { extractVoxi, extractCode, findReopenLink };
