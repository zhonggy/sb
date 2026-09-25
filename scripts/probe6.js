/**
 * Spike 测试2：带指纹预设启动 camoufox
 * 验证 CAMOU_CONFIG_* 环境变量方案在 Node 侧是否可行
 */
const path = require('path');
const fs = require('fs');
const { firefox } = require('playwright');

const EXE = path.join(__dirname, '..', 'build', 'camoufox', 'extracted', 'camoufox.exe');
const PROFILE = path.join(__dirname, '..', 'data', 'profiles', 'camoufox_fp');
const PRESETS = 'D:/github/camoufox-main/pythonlib/camoufox/fingerprint-presets.json';

/** 扁平化嵌套对象为点分键 */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? v.join('|') : v;
  }
  return out;
}

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });

  // 1. 读预设，选一个 windows 的
  const data = JSON.parse(fs.readFileSync(PRESETS, 'utf8'));
  const osList = data.presets.windows || [];
  console.log('windows 预设数:', osList.length);
  if (!osList.length) { console.log('FAIL 无 windows 预设'); process.exit(1); }
  const preset = osList[0];
  console.log('预设 UA:', preset.navigator.userAgent);

  // 2. 扁平化 → 分片 → env vars
  const flat = flatten(preset);
  console.log('扁平化后键数:', Object.keys(flat).length, '| 示例:', Object.keys(flat).slice(0, 8).join(', '));
  const json = JSON.stringify(flat);
  const CHUNK = 2047; // Windows 环境变量分片大小（Python 代码同款）
  const env = {};
  for (let i = 0; i < json.length; i += CHUNK) {
    env[`CAMOU_CONFIG_${i / CHUNK + 1}`] = json.slice(i, i + CHUNK);
  }
  console.log('CAMOU_CONFIG 分片数:', Object.keys(env).length);

  // 3. 带配置启动
  console.log('\\n=== 带指纹配置启动 ===');
  let ctx = null;
  try {
    ctx = await firefox.launchPersistentContext(PROFILE, {
      executablePath: EXE,
      headless: false,
      env: { ...env, ...process.env },
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      viewport: { width: 1366, height: 900 },
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://accounts.studentbeans.com/uk/authorisation/log-in', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });
    await page.waitForTimeout(5000);

    const info = await page.evaluate(() => ({
      ua: navigator.userAgent,
      platform: navigator.platform,
      cores: navigator.hardwareConcurrency,
      webdriver: navigator.webdriver,
      screen: `${screen.width}x${screen.height}`,
    }));
    console.log('页面内指纹:');
    console.log('  UA:', info.ua);
    console.log('  platform:', info.platform, '| cores:', info.cores, '| screen:', info.screen);
    console.log('  webdriver:', info.webdriver);
    const uaOk = /Firefox.148/.test(info.ua);
    console.log(uaOk ? '✅ 指纹配置生效（UA 已变成预设的 Firefox 148）' : '⚠️ UA 未变为预设值（配置可能未生效，需调 key 格式）');
    await page.screenshot({ path: path.join(__dirname, '..', 'data', 'camoufox-fp.png') });
    console.log('SPIKE2:', uaOk ? 'PASS' : 'PARTIAL');
  } catch (e) {
    console.log('FAIL:', e.message.split('\\n').slice(0, 3).join(' | '));
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
