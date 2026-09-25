/**
 * 打包前下载 Camoufox（打补丁的 Firefox）到 build/camoufox/
 * 与 prebuild-cloak.js 同款模式；GitHub releases 直连，国内走代理：
 *   set HTTPS_PROXY=http://127.0.0.1:7897 && npm run precamoufox
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'build', 'camoufox');
const EXE = path.join(DIR, 'extracted', 'camoufox.exe');
const RELEASE = process.env.CAMOUFOX_RELEASE || 'font-bundle-v1';
const VERSION = process.env.CAMOUFOX_VERSION || 'camoufox-152.0.4-beta.31-win.x86_64.zip';
const URL = `https://github.com/daijro/camoufox/releases/download/${RELEASE}/${VERSION}`;

(async () => {
  if (fs.existsSync(EXE)) {
    console.log('[precamoufox] 已存在，跳过:', EXE);
    process.exit(0);
  }
  fs.mkdirSync(path.join(DIR, 'extracted'), { recursive: true });
  const zip = path.join(DIR, 'camoufox.zip');
  try {
    console.log(`[precamoufox] 下载: ${URL}`);
    execSync(`curl -sL --retry 3 --max-time 1800 -o "${zip}" "${URL}"`, { stdio: 'inherit', cwd: ROOT });
    const size = fs.statSync(zip).size;
    if (size < 10_000_000) throw new Error('下载文件过小，可能是错误页面');
    console.log(`[precamoufox] 下载完成 ${(size / 1048576).toFixed(0)}MB，解压中…`);
    execSync(`powershell -Command "Expand-Archive -Path '${zip}' -DestinationPath '${DIR}\\extracted' -Force"`, { stdio: 'inherit', cwd: ROOT });
    fs.unlinkSync(zip);
    if (!fs.existsSync(EXE)) throw new Error('解压后未找到 camoufox.exe');
    console.log('[precamoufox] 完成:', EXE);
  } catch (e) {
    console.error('[precamoufox] 失败:', e.message.split('\n')[0]);
    console.error('[precamoufox] 国内网络请走代理重试:');
    console.error('  set HTTPS_PROXY=http://127.0.0.1:7897 && npm run precamoufox');
    process.exit(1);
  }
})();
