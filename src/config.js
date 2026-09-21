/**
 * 全局配置：全部支持环境变量覆盖（方便 Docker 部署）
 */
const path = require('path');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

const config = {
  port: parseInt(env('PORT', '3920'), 10),
  dataDir: path.resolve(env('DATA_DIR', path.join(__dirname, '..', 'data'))),

  // Web 控制台访问密码：为空则不加锁（建议设置）
  adminPassword: env('ADMIN_PASSWORD', ''),

  // 站点常量（Student Beans UK）
  siteUrl: env('SITE_URL', 'https://www.studentbeans.com/uk'),
  voxiPageUrl: env('VOXI_PAGE_URL', 'https://www.studentbeans.com/student-discount/uk/voxi'),
  loginUrl: env('LOGIN_URL', 'https://accounts.studentbeans.com/uk/authorisation/log-in'),

  // 浏览器
  headless: env('HEADLESS', 'true') !== 'false',
  channel: env('PW_CHANNEL', '') || undefined,        // 例如 'chrome' / 'msedge'，默认用 Playwright 自带 Chromium
  locale: env('BROWSER_LOCALE', 'en-GB'),
  timezoneId: env('BROWSER_TZ', 'Europe/London'),
  proxyUrl: env('PROXY_URL', '') || undefined,
  userAgent: env(
    'USER_AGENT',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  ),

  // 浏览器引擎：playwright（默认）| cloak（CloakBrowser 源码级隐身 Chromium）
  // cloak 对 Cloudflare Turnstile 通过率更高；启动失败会自动回退到 playwright
  browserEngine: env('BROWSER_ENGINE', 'playwright').toLowerCase(),
  cloakLicenseKey: env('CLOAKBROWSER_LICENSE_KEY', ''),
  cloakHumanize: env('CLOAKBROWSER_HUMANIZE', 'true') === 'true',
  cloakGeoip: env('CLOAKBROWSER_GEOIP', 'false') === 'true',

  // 超时与节奏（毫秒）
  navTimeoutMs: parseInt(env('NAV_TIMEOUT_MS', '60000'), 10),
  loginTimeoutMs: parseInt(env('LOGIN_TIMEOUT_MS', '90000'), 10),
  clickTimeoutMs: parseInt(env('CLICK_TIMEOUT_MS', '15000'), 10),
  stepDelayMs: parseInt(env('STEP_DELAY_MS', '1500'), 10),
  maxOffersPerRun: parseInt(env('MAX_OFFERS_PER_RUN', '20'), 10),

  // 定时任务
  scheduleEnabled: env('SCHEDULE_ENABLED', 'false') === 'true',
  scheduleCron: env('SCHEDULE_CRON', '0 8 * * *'),
  scheduleTimezone: env('SCHEDULE_TZ', 'Europe/London'),
};

// 去掉无效的 require（若未安装 dotenv-flow，require 会抛错）
module.exports = config;
