/**
 * Voxi 优惠码提取（2026-09 按用户实测 + 工件分析最终版）
 *
 *  实测确认的真实流程：
 *   1. 列表页每张卡片有 "Get code & open site" 按钮（真实带码优惠 4 个：£10/£12/£15/£20；
 *      另有 "Get Discount" 的 £150 代金券，无码，跳过）
 *   2. 点击后弹出新标签页——内容就是同一个优惠页（URL 带 ?offer=...&redeem_online=true），
 *      上面一次列出全部优惠；被点那个显示 "Your code has been copied ready to use"
 *   3. 页面显示的码是【掩码】的（13 位中 1 位被 * 藏起，如 STB27*1XN23IX）——
 *      完整码在剪贴板里（站点自动复制），必须从 clipboard 拿
 *   4. 每张卡片下方有自己的 "Re-open the VOXI Mobile website" 按钮，
 *      其 href（含 planId/clickref）才是该优惠对应的正确链接
 *   5. 关闭/复用新标签页，重复下一个
 *
 *  因此：码 = clipboard 优先；链接 = 按卡片标题在弹窗里定位该卡片内的 re-open 链接。
 */
const config = require('../config');
const { sleep, log, resultKey } = require('../utils');
const { acceptCookies, forceRemoveOverlays, clickTurnstileCheckbox } = require('./login');

// 每张卡片一个 issuance 按钮
const BTN_SEL = 'div[data-testid="offer-issuance-button"] button, div[data-testid="offer-issuance-button"] a';
// 只处理 "Get code" 按钮（排除 "Get Discount" 的代金券）
const GET_CODE_RE = /get\s*(your\s*)?(discount\s*)?code/i;
// 优惠标题特征（过滤倒计时等非优惠元素）
const OFFER_TITLE_RE = /(\d+\s?GB|£\s?\d+|month|SIM|unlimited|endless|data)/i;

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

/** 提取优惠码。loose=true 用于剪贴板（权威来源，长度 8-14 均可）；
 *  loose=false 用于页面文本（必须完整 13 位 STB+10，拒绝掩码格式如 STB27*1XN23IX） */
/** 提取优惠码。* 是码本身的合法字符（如 STB27*1XN23IX，共 13 位 = STB + 10 位）。
 *  loose=true 用于剪贴板（权威来源，长度 8-14 均可）；
 *  loose=false 用于页面文本（必须完整 13 位）。
 *  用前后查找而非 \b——码可能以 * 结尾，\b 会漏匹配。 */
function extractCode(text, loose = false) {
  if (!text) return null;
  const len = loose ? '{8,14}' : '{10}';
  const re = new RegExp('(?<![A-Z0-9*])STB[A-Z0-9*]' + len + '(?![A-Z0-9*])', 'i');
  const m = String(text).match(re);
  return m ? m[0].toUpperCase() : null;
}

/** 读取某页 clipboard 劫持记录的最后一条 */
async function lastClip(p) {
  if (!p || p.isClosed()) return null;
  const clips = await p.evaluate(() => (window.__clips || []).slice(-3)).catch(() => []);
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = extractCode(clips[i], true);
    if (c) return c;
  }
  return null;
}

/** 在弹窗里按卡片标题定位该卡片，取卡片内 re-open 按钮的链接 */
async function cardScopedLink(popup, title) {
  return popup.evaluate(t => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const keys = [norm(t).slice(0, 40), norm(t).slice(0, 25), norm(t).slice(0, 15)].filter(k => k.length >= 8);
    const cards = [...document.querySelectorAll('article, div[data-testid^="native-offer-"]')];
    const card = cards.find(c => keys.some(k => norm(c.innerText || '').includes(k)));
    if (!card) return null;
    const rich = /clickref|planId|awinaffid|awin1\.com|cread\.php/i;
    const els = [...card.querySelectorAll('a, button, [role="button"]')];
    const hrefOf = el => {
      let h = el.href || el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || '';
      if (!/^https?:/.test(h)) {
        const m = (el.getAttribute('onclick') || '').match(/https?:\/\/[^'")\s]+/);
        if (m) h = m[0];
      }
      return h || null;
    };
    // 1. 卡片内带唯一参数的链接
    let el = els.find(e => rich.test(hrefOf(e) || ''));
    if (el) return { url: hrefOf(el), how: 'card-rich' };
    // 2. 卡片内 re-open 文本
    el = els.find(e => /re-?open|open the|continue|visit/i.test(e.innerText || ''));
    if (el) return { url: hrefOf(el), how: 'card-reopen' };
    // 3. 卡片内 voxi 链接
    el = els.find(e => /voxi\.co\.uk/i.test(hrefOf(e) || ''));
    if (el) return { url: hrefOf(el), how: 'card-voxi' };
    return null;
  }, title).catch(() => null);
}

/** 在弹窗里按卡片标题定位该卡片，提取该卡片内的优惠码
 *  （弹窗一次列出全部优惠的码，必须取当前卡片那一个） */
async function cardScopedCode(popup, title) {
  return popup.evaluate(t => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const keys = [norm(t).slice(0, 40), norm(t).slice(0, 25), norm(t).slice(0, 15)].filter(k => k.length >= 8);
    const cards = [...document.querySelectorAll('article, div[data-testid^="native-offer-"]')];
    const card = cards.find(c => keys.some(k => norm(c.innerText || '').includes(k)));
    if (!card) return null;
    const m = (card.innerText || '').match(/(?<![A-Z0-9*])STB[A-Z0-9*]{10}(?![A-Z0-9*])/i);
    return m ? m[0].toUpperCase() : null;
  }, title).catch(() => null);
}

/** 在弹窗卡片里找 data 属性中的完整码（clipboard 失败时的兜底） */
async function cardAttrCode(popup, title) {
  return popup.evaluate(t => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const keys = [norm(t).slice(0, 40), norm(t).slice(0, 25), norm(t).slice(0, 15)].filter(k => k.length >= 8);
    const cards = [...document.querySelectorAll('article, div[data-testid^="native-offer-"]')];
    const card = cards.find(c => keys.some(k => norm(c.innerText || '').includes(k)));
    if (!card) return null;
    const els = [...card.querySelectorAll('*')];
    for (const el of els) {
      for (const attr of el.attributes || []) {
        const m = String(attr.value || '').match(/(?<![A-Z0-9*])STB[A-Z0-9*]{10}(?![A-Z0-9*])/i);
        if (m) return m[0].toUpperCase();
      }
    }
    return null;
  }, title).catch(() => null);
}

async function extractVoxi(page, account, job, opts = {}) {
  const results = [];
  const artifacts = [];
  const maxOffers = opts.maxOffers || config.maxOffersPerRun;
  const stepDelay = opts.stepDelayMs != null ? opts.stepDelayMs : config.stepDelayMs;
  const listUrl = config.voxiPageUrl;

  const gotoList = async () => {
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
    await page.waitForSelector(BTN_SEL, { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    await forceRemoveOverlays(page);
  };

  let livePopup = null;
  let lastPopupUrl = '';

  try {
    log(job, 'info', `打开 VOXI 优惠页: ${listUrl}`);
    await gotoList();

    if (/accounts\.studentbeans\.com|\/accounts\/authorisation\//.test(page.url())) {
      artifacts.push(await saveArtifact(job, 'redirected-login.png', await page.screenshot().catch(() => null), 'image/png'));
      return { results, artifacts, error: '访问 VOXI 页时被重定向到登录页，会话无效' };
    }

    // 收集候选卡片：issuance 按钮 + 就近 article 标题；只保留 "Get code" 按钮 + 优惠特征标题
    const cards = await page.evaluate(() => {
      const out = [];
      const btns = [...document.querySelectorAll('div[data-testid="offer-issuance-button"] button, div[data-testid="offer-issuance-button"] a')];
      btns.forEach((b, i) => {
        const btnText = (b.innerText || '').trim();
        let a = b.closest ? b.closest('article') : null;
        if (!a) {
          a = b;
          for (let k = 0; k < 8 && a.parentElement; k++) {
            a = a.parentElement;
            if (a.querySelector && a.querySelectorAll('div[data-testid="offer-issuance-button"]').length === 1 &&
                (a.innerText || '').length > 80) break;
          }
        }
        const line = ((a.innerText || '').split('\n').find(l => l.trim()) || '').trim();
        out.push({ i, btnText: btnText.slice(0, 60), title: line.slice(0, 300) });
      });
      return out;
    });

    let offerCards = cards.filter(c => GET_CODE_RE.test(c.btnText) && OFFER_TITLE_RE.test(c.title));
    if (!offerCards.length) offerCards = cards.filter(c => OFFER_TITLE_RE.test(c.title)); // 兜底
    log(job, 'info', `发现 ${cards.length} 个按钮，其中 ${offerCards.length} 个是带码优惠（${offerCards.map(c => c.title.slice(0, 20)).join(' / ')}）`);
    if (!offerCards.length) {
      artifacts.push(await saveArtifact(job, 'voxi-page.html', await page.content()));
      return { results, artifacts, error: '未发现有效优惠按钮（已保存页面快照）' };
    }

    const limit = Math.min(offerCards.length, maxOffers);
    const seenKeys = new Set();

    for (let n = 0; n < limit; n++) {
      if (job.cancelRequested) { log(job, 'warn', '任务被取消'); break; }
      const card = offerCards[n];
      const idx = card.i;
      const title = card.title || `Offer ${n + 1}`;

      log(job, 'info', `[${n + 1}/${limit}] 打开列表页…`);
      await gotoList();

      if (/accounts\.studentbeans\.com|\/accounts\/authorisation\//.test(page.url())) {
        artifacts.push(await saveArtifact(job, 'session-lost.png', await page.screenshot().catch(() => null), 'image/png'));
        return { results, artifacts, error: '会话失效：访问优惠页被重定向到登录页' };
      }

      log(job, 'info', `[${n + 1}/${limit}] 处理: ${title.slice(0, 70)}`);

      let btn;
      try {
        btn = page.locator(BTN_SEL).nth(idx);
        await btn.waitFor({ state: 'attached', timeout: 5000 });
      } catch (e) {
        log(job, 'warn', `按钮 ${idx} 已不可见，跳过`);
        continue;
      }

      // 点击前清空主页 clipboard 记录，保证拿到的是本次点击产生的复制
      await page.evaluate(() => { try { window.__clips = []; } catch (e) {} });

      let popup = null;
      let popupIsNew = false;
      const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
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
      if (popup) popupIsNew = true;

      if (!popup) {
        // 等真正的新页面（排除上一个已知弹窗）
        for (let t = 0; t < 20 && !popup; t++) {
          await sleep(500);
          const pages = page.context().pages().filter(p => p !== page && !p.isClosed());
          const fresh = pages.find(p => p !== livePopup);
          if (fresh) { popup = fresh; popupIsNew = true; }
        }
      }
      if (!popup && livePopup && !livePopup.isClosed()) {
        log(job, 'info', '复用已打开的标签页，等待内容更新…');
        await livePopup.waitForFunction(
          prev => location.href !== prev,
          lastPopupUrl,
          { timeout: 15000 }
        ).catch(() => {});
        popup = livePopup;
        popupIsNew = false;
      }

      // 仍无弹窗：① 同标签页被弹回登录页 = 会话失效（登录实际未成功）
      //           ② 被内联 Turnstile 挑战拦截 → 自动点复选框，通过后再查一次弹窗
      let sessionLost = false;
      if (!popup) {
        if (/accounts\.studentbeans\.com|\/accounts\/authorisation\//.test(page.url())) {
          sessionLost = true;
        } else {
          log(job, 'warn', '未检测到新标签页，检查是否被内联人机验证拦截…');
          const ts = await clickTurnstileCheckbox(page, job, 3000, 12000);
          if (ts.found) {
            await sleep(4000); // 等验证通过后站点弹出新标签页
            const pages2 = page.context().pages().filter(p => p !== page && !p.isClosed());
            const fresh = pages2.find(p => p !== livePopup);
            if (fresh) { popup = fresh; popupIsNew = true; }
            if (!popup && /accounts\.studentbeans\.com|\/accounts\/authorisation\//.test(page.url())) sessionLost = true;
          }
        }
      }
      if (sessionLost) {
        const bodyText = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
        artifacts.push(await saveArtifact(job, `offer-${n + 1}.txt`, bodyText));
        artifacts.push(await saveArtifact(job, `offer-${n + 1}.png`, await page.screenshot().catch(() => null), 'image/png'));
        log(job, 'error', '点击 Get code 后被重定向到登录页——登录实际未成功，终止本轮');
        return { results, artifacts, error: '会话失效：点击 Get code 后被重定向到登录页（登录未真正成功）' };
      }

      let code = null;
      let url = null;
      let source = null;

      if (popup) {
        livePopup = popup;
        log(job, 'info', '新标签页已就绪，等待优惠码…');
        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        // 等本卡片标题出现在弹窗里
        await popup.waitForFunction(
          t => ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').includes(t.replace(/\s+/g, ' ').slice(0, 40)),
          title,
          { timeout: 12000 }
        ).catch(() => {});
        await sleep(stepDelay > 0 ? Math.min(stepDelay, 2000) : 1000);

        const popupUrl = popup.url();
        const popupText = await popup.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');

        // ---- 优惠码：clipboard 优先 → 本卡片文本 → data 属性 → 全页文本 ----
        if (popupIsNew) {
          code = await lastClip(popup);
          if (code) source = 'clipboard-popup';
        }
        if (!code) {
          code = await lastClip(page);
          if (code) source = 'clipboard-main';
        }
        if (!code && !popupIsNew) {
          code = await lastClip(popup);
          if (code) source = 'clipboard-popup';
        }
        // 本卡片内的码（弹窗列全部优惠，必须取当前卡片那一个）
        if (!code) {
          code = await cardScopedCode(popup, title);
          if (code) source = 'card-text';
        }
        // 兜底：data 属性 → 全页文本（可能抓到别的卡片的码，最后手段）
        if (!code) {
          code = await cardAttrCode(popup, title);
          if (code) source = 'card-attr';
        }
        if (!code) {
          code = extractCode(popupText);
          if (code) source = 'popup-text';
        }

        // ---- 链接：按卡片标题定位该卡片自己的 re-open 按钮 ----
        const scoped = await cardScopedLink(popup, title);
        if (scoped && scoped.url) {
          url = scoped.url;
          source = source || `popup-${scoped.how}`;
        }

        // 诊断日志
        log(job, 'info', `弹窗URL: ${popupUrl}${popupUrl !== lastPopupUrl ? '' : '（与上条相同，属正常：同页不同优惠）'}`);
        log(job, 'info', `本卡链接: ${url ? url.slice(0, 120) : '(未取到)'}${scoped ? ' [' + scoped.how + ']' : ''}`);

        // 截图 + 全文落盘
        artifacts.push(await saveArtifact(job, `offer-${n + 1}.txt`,
          `TITLE: ${title}\n弹窗URL: ${popupUrl}\n优惠码: ${code || '(未取到)'} [${source || '?'}]\n链接: ${url || '(无)'}\n\n----- 页面全文 -----\n${popupText}`));
        artifacts.push(await saveArtifact(job, `offer-${n + 1}.png`,
          await popup.screenshot({ fullPage: true }).catch(() => null), 'image/png'));

        if (popupUrl) lastPopupUrl = popupUrl;
      } else {
        log(job, 'warn', '未检测到新标签页（可能被浏览器拦截弹窗）');
        artifacts.push(await saveArtifact(job, `offer-${n + 1}.txt`, await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '')));
        artifacts.push(await saveArtifact(job, `offer-${n + 1}.png`, await page.screenshot().catch(() => null), 'image/png'));
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
        const key = resultKey(row);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          results.push(row);
        }
        log(job, 'ok', `✓ 优惠码: ${code || '(未取到)'}  |  链接: ${url ? url.slice(0, 110) : '(无)'}  [${source || '?'}]`);
      } else {
        log(job, 'warn', `未捕获到优惠码/链接: ${title.slice(0, 60)}（已保存快照供排查）`);
      }

      await sleep(300);
    }

    return { results, artifacts };
  } finally {
    for (const p of page.context().pages()) {
      if (p !== page && !p.isClosed()) await p.close().catch(() => {});
    }
  }
}

module.exports = { extractVoxi, extractCode, cardScopedCode, cardScopedLink };
