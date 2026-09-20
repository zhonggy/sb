/**
 * 探测脚本：实测 studentbeans 登录页和 Voxi 页面的真实 DOM 结构
 * 用法: PROBE_CHANNEL=chrome node scripts/probe.js
 * 产物: data/probe/*.png + 控制台输出结构信息
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, '..', 'data', 'probe');
fs.mkdirSync(OUT, { recursive: true });

const LOGIN_URL = process.env.PROBE_LOGIN_URL || 'https://accounts.studentbeans.com/uk/authorisation/log-in';
const VOXI_URL = process.env.PROBE_VOXI_URL || 'https://www.studentbeans.com/student-discount/uk/voxi';
const CHANNEL = process.env.PROBE_CHANNEL || undefined;

(async () => {
  const context = await chromium.launchPersistentContext(path.join(OUT, 'profile'), {
    headless: true,
    channel: CHANNEL,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 1366, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || await context.newPage();

  const dumpInputs = async (tag) => {
    const inputs = await page.$$eval('input, textarea, select', els => els.map(e => ({
      tag: e.tagName.toLowerCase(),
      type: e.type || '',
      name: e.name || '',
      id: e.id || '',
      placeholder: e.placeholder || '',
      ariaLabel: e.getAttribute('aria-label') || '',
      testid: e.getAttribute('data-testid') || '',
      visible: !!(e.offsetWidth || e.offsetHeight),
    })));
    console.log(`\n[${tag}] INPUTS:`);
    console.log(JSON.stringify(inputs, null, 1));
  };

  const dumpButtons = async (tag) => {
    const btns = await page.$$eval('button, a[role="button"], [role="button"]', els => els
      .filter(e => !!(e.offsetWidth || e.offsetHeight))
      .slice(0, 40)
      .map(e => ({ text: (e.innerText || '').trim().slice(0, 60), type: e.type || '', testid: e.getAttribute('data-testid') || '' })));
    console.log(`\n[${tag}] BUTTONS:`);
    console.log(JSON.stringify(btns, null, 1));
  };

  // ---------- 1. 登录页 ----------
  console.log('=== PROBE LOGIN PAGE:', LOGIN_URL);
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    console.log('final URL:', page.url());
    console.log('title:', await page.title());
    await dumpInputs('login');
    await dumpButtons('login');
    await page.screenshot({ path: path.join(OUT, 'login.png'), fullPage: true });
    console.log('body text (first 800):', (await page.innerText('body')).slice(0, 800));
  } catch (e) {
    console.log('LOGIN PROBE FAILED:', e.message);
  }

  // ---------- 2. 主页（找登录入口 & cookie banner） ----------
  console.log('\n=== PROBE HOME');
  try {
    await page.goto('https://www.studentbeans.com/uk', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    console.log('final URL:', page.url());
    const loginLinks = await page.$$eval('a, button', els => els
      .map(e => ({ text: (e.innerText || '').trim().slice(0, 40), href: e.href || '', testid: e.getAttribute('data-testid') || '' }))
      .filter(x => /log ?in|sign ?in|登录/i.test(x.text) || /log-?in|sign-?in/i.test(x.href) || /log-?in|sign-?in/i.test(x.testid))
      .slice(0, 10));
    console.log('login entry elements:', JSON.stringify(loginLinks, null, 1));
    await page.screenshot({ path: path.join(OUT, 'home.png'), fullPage: false });
  } catch (e) {
    console.log('HOME PROBE FAILED:', e.message);
  }

  // ---------- 3. Voxi 页 ----------
  console.log('\n=== PROBE VOXI PAGE:', VOXI_URL);
  try {
    await page.goto(VOXI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(7000);
    console.log('final URL:', page.url());
    const codeBtns = await page.$$eval('button, a', els => els
      .map((e, i) => ({ i, text: (e.innerText || '').trim().slice(0, 80), href: e.href || '', cls: (e.className || '').toString().slice(0, 80), testid: e.getAttribute('data-testid') || '', visible: !!(e.offsetWidth || e.offsetHeight) }))
      .filter(x => /get (your )?(discount )?code|reveal|show code|unlock/i.test(x.text)));
    console.log('CODE BUTTONS (' + codeBtns.length + '):');
    console.log(JSON.stringify(codeBtns.slice(0, 25), null, 1));
    // 卡片容器线索
    const cards = await page.$$eval('[data-testid], article, [class*="offer" i], [class*="card" i]', els => els
      .map(e => ({ tag: e.tagName.toLowerCase(), testid: e.getAttribute('data-testid') || '', cls: (e.className || '').toString().slice(0, 60) }))
      .filter(x => x.testid || /offer/i.test(x.cls))
      .slice(0, 25));
    console.log('CARD CONTAINERS:', JSON.stringify(cards, null, 1));
    await page.screenshot({ path: path.join(OUT, 'voxi-loggedout.png'), fullPage: true });
  } catch (e) {
    console.log('VOXI PROBE FAILED:', e.message);
  }

  await context.close();
  console.log('\nDONE. screenshots at', OUT);
})().catch(e => { console.error('PROBE ERROR', e); process.exit(1); });
