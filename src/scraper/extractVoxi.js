/**
 * Voxi 优惠码提取（基于实测 DOM）：
 *  - 揭示按钮: div[data-testid="offer-issuance-button"] 内的 button/a（每卡片一个，精确定位）
 *  - 卡片标题: 按钮最近的 article 祖先的第一行文本
 *
 * 点击 "Get code & open site" 后可能发生：
 *   ① 弹模态框显示优惠码   ② 复制到剪贴板   ③ 新标签页打开 VOXI 官网
 *   ④ 当前标签页直接跳转（登录态/未验证学生身份时尤其常见）
 *
 * 捕获手段（七路并取）：
 *   1. navigator.clipboard.writeText 劫持（init script）
 *   2. 模态框文本正则（点击后 3 秒快速轮询，抢在跳转前）
 *   3. 页面独立码元素扫描
 *   4. 新标签页 URL（window.open / popup 事件）
 *   5. 当前标签页 URL 变化（跳转前后对比）
 *   6. 网络响应 JSON 拦截（code/url 字段）
 *   7. 路由拦截：中止跳往外部站点的顶层导航——原页面（含模态框）保留，同时记录目标 URL
 * 每步都保存截图 + 页面全文文本，便于排查。
 */
const config = require('../config');
const { sleep, log, extractCodeFromText } = require('../utils');
const { acceptCookies, forceRemoveOverlays } = require('./login');

// 每张卡片一个 issuance 按钮（section 外层容器不会重复命中）
const BTN_SEL = 'div[data-testid="offer-issuance-button"] button, div[data-testid="offer-issuance-button"] a';
// 站内域名白名单（这些域名的顶层导航放行：登录跳转等）
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

/** 快速捕获：clipboard + 模态框 + 码元素（点击后跳转前的窗口期） */
async function quickCapture(page) {
  const cap = await page.evaluate(() => ({
    clips: (window.__clips || []).slice(-5),
    opens: (window.__opens || []).slice(-5),
    modals: [...document.querySelectorAll('[role="dialog"], [data-testid*="modal" i], [class*="modal" i], [class*="Modal"]')]
      .filter(el => el.offsetWidth || el.offsetHeight)
      .map(m => (m.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500)),
    codeEls: [...document.querySelectorAll('span, div, p, strong, b')]
      .filter(el => el.children.length === 0 && (el.offsetWidth || el.offsetHeight) && /^[A-Z0-9]{4,16}$/.test((el.innerText || '').trim()))
      .map(el => el.innerText.trim()).slice(0, 10),
  })).catch(() => null);
  if (!cap) return {};
  let code = null, source = null;
  if (cap.clips.length) { code = cap.clips[cap.clips.length - 1]; source = 'clipboard'; }
  if (!code) for (const m of cap.modals) { const c = extractCodeFromText(m); if (c) { code = c; source = 'modal'; break; } }
  if (!code && cap.codeEls.length) { code = cap.codeEls[0]; source = 'element'; }
  return { code, source, clips: cap.clips, opens: cap.opens, modals: cap.modals };
}

async function extractVoxi(page, account, job, opts = {}) {
  const results = [];
  const artifacts = [];
  const maxOffers = opts.maxOffers || config.maxOffersPerRun;
  const stepDelay = opts.stepDelayMs != null ? opts.stepDelayMs : config.stepDelayMs;
  const listUrl = config.voxiPageUrl;

  // ---- 网络响应拦截：捕获可能含优惠码/跳转链接的 JSON ----
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

  // ---- 路由拦截：中止跳往外部站点的顶层导航 ----
  // 效果：点击 "open site" 后页面不会真的跳走，模态框（若有）保持可见；
  // 同时把目标 URL 记下来，作为优惠的跳转链接。
  const navUrls = [];
  const onRoute = async route => {
    try {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        const host = new URL(req.url()).hostname;
        if (!INTERNAL_HOST.test(host)) {
          navUrls.push(req.url());
          return route.abort();
        }
      }
    } catch (e) { /* noop */ }
    return route.continue();
  };
  await page.route('**/*', onRoute);

  const cleanup = () => {
    page.off('response', onResponse);
    page.unroute('**/*', onRoute).catch(() => {});
  };

  const gotoList = async () => {
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
    await page.waitForSelector(BTN_SEL, { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    await forceRemoveOverlays(page);
  };

  try {
    log(job, 'info', `打开 VOXI 优惠页: ${listUrl}`);
    await gotoList();

    // 若被踢回登录页则中止（登录态失效）
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

      // 若上一轮发生了当前标签页跳转（路由未拦截成功时），先回到列表页
      if (!page.url().startsWith('https://www.studentbeans.com/student-discount')) {
        log(job, 'info', '返回优惠列表页…');
        await gotoList();
      }

      let btn;
      try {
        btn = page.locator(BTN_SEL).nth(idx);
        await btn.waitFor({ state: 'attached', timeout: 5000 });
      } catch (e) {
        log(job, 'warn', `按钮 ${idx} 已不可见，跳过`);
        continue;
      }

      // 卡片标题：就近找 article 祖先，取其第一行非空文本
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

      const beforeUrl = page.url();
      const pagesBefore = page.context().pages().length;
      const hitsBefore = netHits.length;
      const navsBefore = navUrls.length;
      await page.evaluate(() => { try { window.__clips = []; window.__opens = []; } catch (e) { /* noop */ } });

      // 点击 Get code
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

      // ---- 快速捕获（点击后 3 秒窗口期，抢在跳转/关闭前） ----
      let cap = {};
      for (let t = 0; t < 20; t++) {
        await sleep(150);
        cap = await quickCapture(page);
        if (cap.code) break;
      }
      await sleep(stepDelay);

      let code = cap.code || null;
      let url = null;
      let source = cap.source || null;

      // ---- 新标签页（open site） ----
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
      if (!url && (cap.opens || []).length) url = cap.opens[cap.opens.length - 1];

      // ---- 路由拦截记录的外部导航 URL ----
      const navs = navUrls.slice(navsBefore);
      if (!url && navs.length) { url = navs[navs.length - 1]; source = source || null; }

      // ---- 当前标签页跳转（路由没拦成的情况） ----
      const afterUrl = page.url();
      if (afterUrl !== beforeUrl) {
        if (/accounts\.studentbeans\.com|\/accounts\/authorisation\//.test(afterUrl)) {
          const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
          artifacts.push(await saveArtifact(job, `offer-${idx + 1}.txt`, bodyText));
          artifacts.push(await saveArtifact(job, `offer-${idx + 1}.png`, await page.screenshot().catch(() => null), 'image/png'));
          log(job, 'error', '点击后被重定向到登录页，会话已失效，终止本轮');
          return { results, artifacts, error: '会话失效：点击后被重定向到登录页' };
        }
        url = url || afterUrl;
      }

      // ---- 网络响应兜底 ----
      const hits = netHits.slice(hitsBefore);
      if (!code) for (const h of hits) { if (h.codes.length) { code = h.codes[0]; source = 'network'; break; } }
      if (!url) for (const h of hits) { if (h.urls.length) { url = h.urls[0]; break; } }

      // ---- 页面文本落盘（排查关键：能看到模态框/验证提示的原文） ----
      const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      artifacts.push(await saveArtifact(job, `offer-${idx + 1}.txt`, bodyText));
      artifacts.push(await saveArtifact(job, `offer-${idx + 1}.png`, await page.screenshot().catch(() => null), 'image/png'));

      // 特殊提示：需要学生身份验证
      if (/verify (your )?student|student status|verify.*status/i.test(bodyText)) {
        log(job, 'warn', '该优惠需要先完成学生身份验证（Student Beans 账户未验证时会出现）');
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
        log(job, 'ok', `✓ 优惠码: ${code || '(未取到)'}  |  链接: ${url ? url.slice(0, 80) : '(无)'}`);
      } else {
        log(job, 'warn', `未捕获到优惠码/链接: ${title.slice(0, 60)}（已保存文本快照供排查）`);
      }
    }

    return { results, artifacts };
  } finally {
    cleanup();
  }
}

module.exports = { extractVoxi };
