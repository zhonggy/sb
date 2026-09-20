/* 定位 nav-login 点击失败原因 */
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '..', 'data', 'probe', 'navprofile'), {
    channel: process.env.PROBE_CHANNEL || undefined, headless: true, locale: 'en-GB', timezoneId: 'Europe/London',
    viewport: { width: 1366, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.studentbeans.com/uk', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid="nav-login"]')];
    return {
      count: els.length,
      els: els.map(e => ({
        tag: e.tagName, text: (e.innerText || '').trim(), href: (e.href || '').slice(0, 130),
        visible: !!(e.offsetWidth || e.offsetHeight),
        rect: e.getBoundingClientRect().toJSON(),
      })),
      banners: [...document.querySelectorAll('#onetrust-consent-sdk, [class*="onetrust" i], [id*="onetrust" i]')].map(b => ({ id: b.id, visible: !!(b.offsetWidth || b.offsetHeight) })),
    };
  });
  console.log('nav-login info:', JSON.stringify(info, null, 1));

  const el = page.locator('a[data-testid="nav-login"]').first();
  try {
    const box = await el.boundingBox();
    if (box) {
      const at = await page.evaluate(({ x, y }) => {
        const e = document.elementFromPoint(x, y);
        return e ? (e.tagName + '.' + (e.className || '').toString().slice(0, 60) + ' testid=' + (e.getAttribute('data-testid') || '')) : 'null';
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      console.log('element at button center:', at);
    }
    await el.click({ timeout: 8000 });
    console.log('CLICK OK, url now:', page.url());
  } catch (e) {
    console.log('CLICK FAILED full:\n', e.message);
  }
  await ctx.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
