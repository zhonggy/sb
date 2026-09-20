/** 深挖探测：卡片结构、点击行为、clipboard/window.open 劫持、Turnstile */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, '..', 'data', 'probe');
const CHANNEL = process.env.PROBE_CHANNEL || undefined;

(async () => {
  const context = await chromium.launchPersistentContext(path.join(OUT, 'profile3'), {
    channel: CHANNEL, headless: true, locale: 'en-GB', timezoneId: 'Europe/London',
    viewport: { width: 1366, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  // 劫持 clipboard.writeText / window.open 记录调用
  await context.addInitScript(() => {
    window.__clips = [];
    window.__opens = [];
    try {
      navigator.clipboard.writeText = (t) => { window.__clips.push(String(t)); return Promise.resolve(); };
      navigator.clipboard.readText = () => Promise.resolve(window.__clips[window.__clips.length - 1] || '');
    } catch (e) {}
    const origOpen = window.open;
    window.open = (url, ...rest) => { window.__opens.push(String(url)); return origOpen ? origOpen.call(window, url, ...rest) : null; };
  });
  const page = context.pages()[0] || await context.newPage();

  const popups = [];
  context.on('page', p => popups.push(p));

  await page.goto('https://www.studentbeans.com/student-discount/uk/voxi', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  // 卡片结构：找 Get code 按钮的祖先链
  const cardInfo = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a')].filter(e => /get code/i.test(e.innerText || ''));
    if (!btns.length) return 'no buttons';
    const b = btns[0];
    const chain = [];
    let el = b;
    for (let i = 0; i < 6 && el; i++) {
      chain.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 100),
        testid: el.getAttribute('data-testid') || '',
        href: el.href || '',
        text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200),
      });
      el = el.parentElement;
    }
    return chain;
  });
  console.log('=== CARD ANCESTOR CHAIN:');
  console.log(JSON.stringify(cardInfo, null, 1));

  // 所有 offer 卡片的文本（每个含标题+描述+按钮）
  const offers = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a')].filter(e => /get code/i.test(e.innerText || ''));
    return btns.map((b, i) => {
      let card = b;
      for (let k = 0; k < 8 && card; k++) {
        card = card.parentElement;
        if (card && (card.innerText || '').length > 120) break;
      }
      return { i, cardText: (card?.innerText || '').replace(/\s+/g, ' ').slice(0, 300) };
    });
  });
  console.log('\n=== OFFER CARDS:');
  console.log(JSON.stringify(offers, null, 1));

  // 点击第一个按钮，观察行为
  console.log('\n=== CLICK FIRST GET CODE:');
  const before = await page.evaluate(() => ({ clips: window.__clips, opens: window.__opens }));
  await page.evaluate(() => window.__clips.length = 0);
  const first = (await page.$$('button, a')).filter(async () => true); // noop
  const btn = page.locator('button:has-text("Get code"), a:has-text("Get code")').first();
  try {
    await btn.click({ timeout: 8000 });
    await page.waitForTimeout(5000);
    const after = await page.evaluate(() => ({ clips: window.__clips, opens: window.__opens, url: location.href }));
    console.log('clipboard writes:', JSON.stringify(after.clips));
    console.log('window.open calls:', JSON.stringify(after.opens));
    console.log('url now:', after.url);
    console.log('popups opened:', popups.length, popups.map(p => p.url()));
    // 模态框文本
    const modal = await page.evaluate(() => {
      const cands = [...document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="Modal"]')].filter(e => e.offsetWidth || e.offsetHeight);
      return cands.map(m => (m.innerText || '').replace(/\s+/g, ' ').slice(0, 400));
    });
    console.log('modal texts:', JSON.stringify(modal, null, 1));
    await page.screenshot({ path: path.join(OUT, 'after-click.png'), fullPage: false });
  } catch (e) {
    console.log('CLICK FAILED:', e.message.split('\n')[0]);
  }

  // Turnstile 检查（登录页）
  console.log('\n=== TURNSTILE CHECK:');
  const lpage = await context.newPage();
  await lpage.goto('https://accounts.studentbeans.com/uk/authorisation/log-in', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await lpage.waitForTimeout(5000);
  const ts = await lpage.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe')].map(f => ({ src: (f.src || '').slice(0, 120), id: f.id, visible: !!(f.offsetWidth || f.offsetHeight) }));
    return { iframes: ifr, hasCfInput: !!document.querySelector('[name="cf-turnstile-response"]') };
  });
  console.log(JSON.stringify(ts, null, 1));
  await lpage.screenshot({ path: path.join(OUT, 'login2.png'), fullPage: false });

  await context.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
