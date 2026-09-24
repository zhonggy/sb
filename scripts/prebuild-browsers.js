/**
 * 打包前预下载 Playwright Chromium 到 build/playwright-browsers
 * （electron-builder 通过 extraResources 把它打进程序，实现零环境配置）
 *
 * 国内网络下载慢/失败时，用镜像源：
 *   PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright \
 *     npm run predist
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const dir = path.join(__dirname, '..', 'build', 'playwright-browsers');

fs.mkdirSync(dir, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH = dir;

const isWin = process.platform === 'win32';
console.log(`[predist] 下载 Playwright Chromium → ${dir}`);
console.log(`[predist] 平台: ${process.platform}-${process.arch}`);

try {
  execSync('npx playwright install chromium', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  console.log(`[predist] 完成，已安装: ${entries.join(', ') || '(空)'}`);
  if (!entries.length) {
    console.error('[predist] 警告: 目录为空，打包出的程序可能不带浏览器');
    process.exit(1);
  }
} catch (e) {
  console.error('[predist] 下载失败:', e.message.split('\n')[0]);
  console.error('[predist] 国内网络请设置镜像源后重试:');
  console.error('  PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright npm run predist');
  process.exit(1);
}
void isWin;
