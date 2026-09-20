/**
 * Voxi 优惠码提取（基于用户实测的正确流程，2026-09 最终版）：
 *
 *  实际流程：
 *   1. 列表页每张卡片有 "Get code & open site" 按钮（真实优惠共 4 个：£10/£12/£15/£20）
 *   2. 点击后弹出新标签页
 *   3. 新标签页里显示该优惠的优惠码（STB 开头，如 STB274EA12TO0）
 *   4. 新标签页里 "Re-open the VOXI mobile website" 按钮的链接才是正确链接，
 *      形如 https://www.awin1.com/cread.php?awinmid=10951&ued=...plans?planId=121296&awinaffid=61664&clickref=<uuid>
 *      （每个优惠的 planId/clickref 不同）
 *   5. 关闭/复用新标签页，重复下一个
 *
 *  关键修复：
 *   - 弹窗 URL 可能不变（网站复用命名窗口），此时「等 STB 文本出现」会被旧内容瞬间满足
 *     → 改为等待【URL 变化】且【优惠码与上一条不同】
 *   - 链接选择优先级：href 含 awin/cread/clickref/planId > re-open 文本 > voxi.co.uk > 弹窗初始 URL
 *   - 过滤非优惠卡片（如 "Expires in 24 days" 倒计时元素）
 *   - 全程记录弹窗 URL 链路和全部候选链接，落盘供排查
 */
const config = require('../config');
const { sleep, log, extractCodeFromText } = require('../utils');
const { acceptCookies, forceRemoveOverlays } = require('./login');

// 每张卡片一个 issuance 按钮
const BTN_SEL = 'div[data-testid="offer-issuance-button"] button, div[data-testid="offer-issuance-button"] a';
// 优惠标题特征（用于过滤倒计时等非优惠元素）
const OFFER_TITLE_RE = /(\d+\s?GB|£\s?\d+|month|SIM|unlimited|endless|data)/i;
// 正确链接特征（awin 跟踪链接，带 planId/clickref）
const TRACKING_LINK_RE = /awin1\.com|cread\.php|clickref|planId|awinaffid/i;

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

/** 从文本中提取优惠码：优先 STB 开头（Student Beans 码格式） */
function extractCode(text) {
  if (!text) return null;
  const m = String(text).match(/\bSTB[A-Z0-9]{6,14}\b/i);
  if (m) return m[0].toUpperCase();
  return null; // 非 STB 格式不猜，避免误报（如 ENGLISH）
}

/** 收集新标签页里所有候选链接（文本 + href），按优先级挑出正确的
 *  urlChain: 弹窗打开过程中的 URL 链路（跟踪链接可能在重定向前） */
async function pickTrackingLink(popup, urlChain = []) {
  const candidates = await popup.evaluate(() => {
    const out = [];
    const els = [...document.querySelectorAll('a, button, [role="button"]')];
    for (const el of els) {
      const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      let href = el.href || el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || '';
      if (!/^https?:/.test(href)) {
        const oc = el.getAttribute('onclick') || '';
        const m = oc.match(/https?:\/\/[^'")\s]+/);
        if (m) href = m[0];
      }
      if (!href) continue;
      const visible = !!(el.offsetWidth || el.offsetHeight || el.getBoundingClientRect().width);
      out.push({ text, href, visible });
    }
    return out;
  }).catch(() => []);

  const rich = /clickref|planId|awinaffid/i;          // 带每个优惠唯一参数
  const tracking = /awin1\.com|cread\.php/i;           // awin 跟踪链接
  const reopen = /re-?open|open the|continue|visit|go to|shop now|get (the )?code/i;

  const find = pred => candidates.find(pred);
  let hit;
  // 1-2. 可见/任意 + 带唯一参数（正确链接的特征）
  hit = find(c => c.visible && rich.test(c.href)) || find(c => rich.test(c.href));
  if (hit) return { url: hit.href, how: 'rich', candidates };
  // 3. 弹窗 URL 链路里带唯一参数的（重定向前的真实跳转）
  const chainRich = urlChain.find(u => rich.test(u));
  if (chainRich) return { url: chainRich, how: 'url-chain-rich', candidates };
  // 4-5. 可见/任意 + awin 跟踪链接
  hit = find(c => c.visible && tracking.test(c.href)) || find(c => tracking.test(c.href));
  if (hit) return { url: hit.href, how: 'tracking', candidates };
  // 6-7. 可见 + re-open 文本 / voxi 官网
  hit = find(c => c.visible && reopen.test(c.text)) || find(c => c.visible && /voxi\.co\.uk/i.test(c.href));
  if (hit) return { url: hit.href, how: 'reopen-voxi', candidates };
  // 8. re-open 文本（含隐藏）
  hit = find(c => reopen.test(c.text));
  if (hit) return { url: hit.href, how: 'reopen-any', candidates };
  // 9. 兜底：弹窗 URL 链路里的跟踪链接
  const chainTrack = urlChain.find(u => tracking.test(u));
  if (chainTrack) return { url: chainTrack, how: 'url-chain-tracking', candidates };
  return { url: null, how: 'none', candidates };
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

  // 跨迭代状态：弹窗引用 / 上一个弹窗 URL / 上一条优惠码
  let livePopup = null;
  let lastPopupUrl = '';
  let lastCode = '';

  try {
    log(job, 'info', `打开 VOXI 优惠页: ${listUrl}`);
    await gotoList();

    if (/accounts\.studentbeans\.com|\/accounts\/authorisation\//.test(page.url())) {
      artifacts.push(await saveArtifact(job, 'redirected-login.png', await page.screenshot().catch(() => null), 'image/png'));
      return { results, artifacts, error: '访问 VOXI 页时被重定向到登录页，会话无效' };
    }

    // 收集所有候选卡片：issuance 按钮 + 就近 article 标题，过滤非优惠元素
    const cards = await page.evaluate(() => {
      const out = [];
      const btns = [...document.querySelectorAll('div[data-testid="offer-issuance-button"] button, div[data-testid="offer-issuance-button"] a')];
      btns.forEach((b, i) => {
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
        out.push({ i, title: line.slice(0, 300) });
      });
      return out;
    });

    const offerCards = cards.filter(c => OFFER_TITLE_RE.test(c.title));
    log(job, 'info', `发现 ${cards.length} 个按钮，其中 ${offerCards.length} 个是有效优惠（${offerCards.map(c => c.title.slice(0, 24)).join(' / ')}）`);
    if (!offerCards.length) {
      artifacts.push(await saveArtifact(job, 'voxi-page.html', await page.content()));
      return { results, artifacts, error: '未发现有效优惠按钮（已保存页面快照）' };
    }

    const limit = Math.min(offerCards.length, maxOffers);
    const seenKeys = new Set();

    for (let n = 0; n < limit; n++) {
      if (job.cancelRequested) { log(job, 'warn', '任务被取消'); break; }
      const card = offerCards[n];
      const idx = card.i; // 在全部按钮中的下标
      const title = card.title || `Offer ${n + 1}`;

      // 每张卡片重新打开列表页，保证状态干净
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

      // ---- 点击并等待新标签页 ----
      let popup = null;
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

      // 没有立刻收到 popup 事件：先轮询等【真正的新页面】（排除上一个已知弹窗）
      if (!popup) {
        for (let t = 0; t < 20 && !popup; t++) {
          await sleep(500);
          const pages = page.context().pages().filter(p => p !== page && !p.isClosed());
          const fresh = pages.find(p => p !== livePopup);
          if (fresh) popup = fresh;
        }
      }
      // 仍没有新页面 → 网站复用了命名窗口：等旧弹窗的 URL 变化
      if (!popup && livePopup && !livePopup.isClosed()) {
        log(job, 'info', '复用已打开的标签页，等待内容更新…');
        await livePopup.waitForFunction(
          prev => location.href !== prev,
          lastPopupUrl,
          { timeout: 15000 }
        ).catch(() => {});
        popup = livePopup;
      }

      let code = null;
      let url = null;
      let source = null;
      let popupInfo = { initialUrl: '', urlChain: [], title: '', text: '', candidates: [] };

      if (popup) {
        livePopup = popup;
        log(job, 'info', '新标签页已就绪，等待优惠码…');
        // 记录 URL 链路（跟踪链接可能在重定向前）
        const urlChain = [];
        const onNav = () => { try { const u = popup.url(); if (u && u !== 'about:blank') urlChain.push(u); } catch (e) {} };
        popup.on('framenavigated', onNav);
        const initialUrl = popup.url();
        if (initialUrl && initialUrl !== 'about:blank') urlChain.push(initialUrl);

        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});

        // 等优惠码：必须是 STB 格式，且与上一条不同（防读到旧内容）
        await popup.waitForFunction(
          prev => {
            const t = (document.body && document.body.innerText) || '';
            const m = t.match(/\bSTB[A-Z0-9]{6,14}\b/i);
            return !!m && (!prev || m[0].toUpperCase() !== prev);
          },
          lastCode,
          { timeout: 15000 }
        ).catch(() => {});
        await sleep(stepDelay > 0 ? Math.min(stepDelay, 2000) : 1000);
        onNav();

        const popupUrl = popup.url();
        const popupText = await popup.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
        const popupTitle = await popup.title().catch(() => '');
        code = extractCode(popupText);
        if (code) source = 'popup-text';

        const picked = await pickTrackingLink(popup, [...new Set(urlChain)]);
        url = picked.url;
        if (url) source = source || `popup-${picked.how}`;

        popupInfo = { initialUrl, urlChain: [...new Set(urlChain)], title: popupTitle, text: popupText, candidates: picked.candidates };
        popup.off('framenavigated', onNav);

        // 关键诊断日志：弹窗 URL 链路
        log(job, 'info', `弹窗URL: ${initialUrl}${popupUrl !== initialUrl ? ' → ' + popupUrl : ''}`);
        if (popupInfo.urlChain.length > 1) {
          log(job, 'info', `URL链路: ${popupInfo.urlChain.join(' → ')}`);
        }

        // 截图 + 全文落盘
        const candLines = (picked.candidates || []).slice(0, 12)
          .map(c => `  [${c.visible ? '可见' : '隐藏'}] ${(c.text || '(无文本)').slice(0, 40)} => ${c.href}`).join('\n');
        artifacts.push(await saveArtifact(job, `offer-${n + 1}.txt`,
          `TITLE: ${title}\n弹窗初始URL: ${initialUrl}\n弹窗URL链路: ${popupInfo.urlChain.join(' -> ')}\n` +
          `当前URL: ${popupUrl}\n页面标题: ${popupTitle}\n优惠码: ${code || '(未取到)'}\n选中链接: ${url || '(无)'} (${picked.how})\n` +
          `候选链接:\n${candLines}\n\n----- 页面全文 -----\n${popupText}`));
        artifacts.push(await saveArtifact(job, `offer-${n + 1}.png`,
          await popup.screenshot({ fullPage: true }).catch(() => null), 'image/png'));

        if (code) lastCode = code;
        if (popupUrl) lastPopupUrl = popupUrl;
      } else {
        log(job, 'warn', '未检测到新标签页（可能被浏览器拦截弹窗）');
        artifacts.push(await saveArtifact(job, `offer-${n + 1}.txt`, await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '')));
        artifacts.push(await saveArtifact(job, `offer-${n + 1}.png`, await page.screenshot().catch(() => null), 'image/png'));
      }

      // ---- 兜底：主页面 clipboard（仅 STB 格式） ----
      if (!code) {
        const clips = await page.evaluate(() => (window.__clips || []).slice(-5)).catch(() => []);
        for (const c of clips) { const x = extractCode(c); if (x) { code = x; source = 'clipboard'; break; } }
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
        log(job, 'ok', `✓ 优惠码: ${code || '(未取到)'}  |  链接: ${url ? url.slice(0, 110) : '(无)'}  [${source || '?'}]`);
      } else {
        log(job, 'warn', `未捕获到优惠码/链接: ${title.slice(0, 60)}（已保存快照供排查）`);
      }

      await sleep(300);
    }

    return { results, artifacts };
  } finally {
    // 清理残留弹窗
    for (const p of page.context().pages()) {
      if (p !== page && !p.isClosed()) await p.close().catch(() => {});
    }
  }
}

module.exports = { extractVoxi, extractCode, pickTrackingLink };
