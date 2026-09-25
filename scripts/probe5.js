/**
 * Spike 测试：playwright 1.63 的 firefox launcher 能否启动 camoufox
 * 用法: node scripts/probe5.js
 */
const path = require('path');
const fs = require('fs');
const { firefox } = require('playwright');

const BIN_DIR = path.join(__dirname, '..', 'build', 'camoufox');
const PROFILE = path.join(__dirname, '..', 'data', 'profiles', 'camoufox_spike');

(async () => {
  // 1. 找到 camoufox 可执行文件（解压后结构探测）
  fs.mkdirSync(PROFILE, { recursive: true });
  const entries = fs.existsSync(BIN_DIR) ? fs.readdirSync(BIN_DIR) : [];
  console.log('build/camoufox 内容:', entries.join(', ') || '(空)');

  let exe = null;
  for (const e of entries) {
    if (/^camoufox(\.exe)?$/.test(e)) { exe = path.join(BIN_DIR, e); break; }
  }
  if (!exe) {
    // 可能在子目录里
    for (const e of entries) {
      const sub = path.join(BIN_DIR, e);
      if (fs.statSync(sub).isDirectory()) {
        const subs = fs.readdirSync(sub);
        const hit = subs.find(s => /^camoufox(\.exe)?$/.test(s));
        if (hit) { exe = path.join(sub, hit); break; }
      }
    }
  }
  if (!exe) { console.log('FAIL 找不到 camoufox 可执行文件'); process.exit(1); }
  console.log('可执行文件:', exe);

  // 2. 裸启动（不带 CAMOU_CONFIG）
  console.log('\\n=== 裸启动测试（无指纹配置）===');
  let ctx = null;
  const t0 = Date.now();
  try {
    ctx = await firefox.launchPersistentContext(PROFILE, {
      executablePath: exe,
      headless: false,
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      viewport: { width: 1366, height: 900 },
    });
    console.log(`启动成功（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    console.log('浏览器版本:', ctx.browser().version());

    const page = ctx.pages()[0] || await ctx.newPage();
    console.log('导航到 studentbeans 登录页…');
    await page.goto('https://accounts.studentbeans.com/uk/authorisation/log-in', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });
    await page.waitForTimeout(5000);
    console.log('页面标题:', await page.title());
    const ua = await page.evaluate(() => navigator.userAgent);
    console.log('UA:', ua);
    const webdriver = await page.evaluate(() => navigator.webdriver);
    console.log('navigator.webdriver:', webdriver, webdriver === undefined ? '✅ 已伪装' : '⚠️ 暴露');
    await page.screenshot({ path: path.join(__dirname, '..', 'data', 'camoufox-login.png') });
    console.log('PASS 裸启动 + 页面加载成功');
  } catch (e) {
    console.log('FAIL 裸启动失败:', e.message.split('\\n').slice(0, 4).join(' | '));
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
  process.exit(0);
})().catch(e => { console.error('SPIKE ERROR:', e); process.exit(1); });
