/** 探测3：处理 cookie 横幅后点击 Get code，捕获 模态框/clipboard/新标签页 */
const path = require('path');
const { chromium } = require('playwright');
const OUT = path.join(__dirname, '..', 'data', 'probe');
const CHANNEL = process.env.PROBE_CHANNEL || undefined;

(async () => {
  const context = await chromium.launchPersistentContext(path.join(OUT, 'profile4'), {
    channel: CHANNEL, headless: true, locale: 'en-GB', timezoneId: 'Europe/London',
    viewport: { width: 1366, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  await context.addInitScript(() => {
    window.__clips = []; window.__opens = [];
    try {
      navigator.clipboard.writeText = t => { window.__clips.push(String(t)); return Promise.resolve(); };
      navigator.clipboard.readText = () => Promise.resolve(window.__clips.at(-1) || '');
    } catch (e) {}
    const oo = window.open;
    window.open = (u, ...r) => { window.__opens.push(String(u)); return oo ? oo.call(window, u, ...r) : null; };
  });
  const page = context.pages()[0] || await context.newPage();
  const popups = [];
  context.on('page', p => { popups.push(p); console.log('NEW POPUP:', p.url()); });

  await page.goto('https://www.studentbeans.com/student-discount/uk/voxi', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // 接受 Cookie
  const accept = page.locator('#onetrust-accept-btn-handler, button:has-text("Accept All Cookies")').first();
  if (await accept.count()) {
    try { await accept.click({ timeout: 5000 }); console.log('cookie banner accepted'); await page.waitForTimeout(1500); }
    catch (e) { console.log('cookie accept fail:', e.message.split('\n')[0]); }
  } else console.log('no cookie banner');

  const cards = page.locator('[data-testid^="native-offer-"]');
  const n = await cards.count();
  console.log('offer cards:', n);

  // 逐个点击前 2 个
  for (let i = 0; i < Math.min(n, 2); i++) {
    const card = cards.nth(i);
    const title = (await card.innerText()).split('\n')[0];
    console.log(`\n=== CLICK card ${i}: ${title}`);
    const popupCountBefore = popups.length;
    try {
      const btn = card.locator('[data-testid="offer-issuance-button"] button, [data-testid="offer-issuance-button"] a').first();
      await btn.scrollIntoViewIfNeeded();
      await btn.click({ timeout: 10000 });
      console.log('clicked');
      await page.waitForTimeout(4000);
      const after = await page.evaluate(() => ({ clips: window.__clips, opens: window.__opens, url: location.href }));
      console.log('clips:', JSON.stringify(after.clips));
      console.log('opens:', JSON.stringify(after.opens));
      if (popups.length > popupCountBefore) {
        const p = popups[popups.length - 1];
        await p.waitForLoadState('domcontentloaded').catch(() => {});
        console.log('popup url:', p.url(), '| title:', await p.title().catch(() => ''));
        await p.screenshot({ path: path.join(OUT, `popup-${i}.png`) }).catch(() => {});
        await p.close().catch(() => {});
      }
      // 页面上的模态/代码展示
      const modal = await page.evaluate(() => {
        const cands = [...document.querySelectorAll('[role="dialog"], [data-testid*="modal" i], [class*="modal" i]')].filter(e => e.offsetWidth || e.offsetHeight);
        return cands.map(m => (m.innerText || '').replace(/\s+/g, ' ').slice(0, 500));
      });
      console.log('visible modal texts:', JSON.stringify(modal, null, 1));
      await page.screenshot({ path: path.join(OUT, `after-click-${i}.png`) });
    } catch (e) {
      console.log('click failed:', e.message.split('\n')[0]);
      await page.screenshot({ path: path.join(OUT, `fail-${i}.png`) });
    }
  }

  await context.close();
  console.log('DONE');
})().catch(e => { console.error('ERR', e); process.exit(1); });
