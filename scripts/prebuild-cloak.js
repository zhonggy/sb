/**
 * 打包前下载 CloakBrowser 隐身 Chromium 到 build/cloak-browser
 * 桌面版默认用它跑任务（免 license key 的免费版 v146；要最新版需在控制台填 key）
 *
 * 下载源是 cloakbrowser.dev，国内直连慢/失败时走代理：
 *   set HTTPS_PROXY=http://127.0.0.1:7897 && npm run precloak
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'build', 'cloak-browser');
const EXE = path.join(DIR, 'chrome.exe');

// 已存在则跳过（避免重复下 560MB）
if (fs.existsSync(EXE)) {
  console.log('[precloak] 已存在，跳过下载:', EXE);
  process.exit(0);
}

(async () => {
  // 用 cloakbrowser 包自身查询免费版的下载地址
  const { binaryInfo } = await import('cloakbrowser');
  const info = binaryInfo();
  console.log(`[precloak] 目标版本: ${info.version} (${info.tier}) ${info.platform}`);
  console.log(`[precloak] 下载地址: ${info.downloadUrl}`);

  fs.mkdirSync(DIR, { recursive: true });
  const zip = path.join(DIR, 'cloak.zip');
  try {
    execSync(`curl -sL --retry 2 --max-time 900 -o "${zip}" "${info.downloadUrl}"`, { stdio: 'inherit', cwd: ROOT });
    const size = fs.statSync(zip).size;
    if (size < 10_000_000) throw new Error('下载文件过小 (' + size + ' bytes)，可能是错误响应');
    console.log(`[precloak] 下载完成 ${(size / 1048576).toFixed(0)}MB，解压中…`);
    execSync(`powershell -Command "Expand-Archive -Path '${zip}' -DestinationPath '${DIR}' -Force"`, { stdio: 'inherit', cwd: ROOT });
    fs.unlinkSync(zip);
    if (!fs.existsSync(EXE)) throw new Error('解压后未找到 chrome.exe');
    console.log('[precloak] 完成:', EXE);
  } catch (e) {
    console.error('[precloak] 失败:', e.message.split('\n')[0]);
    console.error('[precloak] 国内网络请走代理重试:');
    console.error('  set HTTPS_PROXY=http://127.0.0.1:7897 && npm run precloak');
    process.exit(1);
  }
})();
