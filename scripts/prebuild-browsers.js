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
  console.error('[predist] 国内网络按优先级尝试：');
  console.error('  1) 走本地代理（最快）: set HTTPS_PROXY=http://127.0.0.1:7897 && npm run predist');
  console.error('  2) 镜像源（部分版本缺失）: set PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright && npm run predist');
  process.exit(1);
}
void isWin;
