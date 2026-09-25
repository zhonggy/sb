/**
 * Electron 主进程：把 VOXI 提取器包装成桌面程序
 * - 数据目录：%APPDATA%/<产品名>/data（持久化，可写）
 * - 服务只监听 127.0.0.1（桌面端安全）
 * - 默认有头模式（浏览器窗口可见，可随时手动过人机验证）
 * - 自动挑选空闲端口（避免和别的程序冲突）
 */
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const PRODUCT_DIR = 'voxi-extractor';

/** 找一个空闲端口 */
function findFreePort(start) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.on('error', () => resolve(findFreePort(start + 1)));
    srv.listen(start, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** playwright 浏览器目录：打包版在 resources 下，开发版在 build/ 下 */
function setupBrowsersPath() {
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'playwright-browsers');
    if (fs.existsSync(p)) { process.env.PLAYWRIGHT_BROWSERS_PATH = p; return p; }
  } else {
    const p = path.join(__dirname, '..', 'build', 'playwright-browsers');
    if (fs.existsSync(p)) { process.env.PLAYWRIGHT_BROWSERS_PATH = p; return p; }
  }
  return null;
}

/** CloakBrowser 二进制（打包版在 resources/cloak-browser，开发版在 build/cloak-browser）
 *  桌面版默认用它跑任务（源码级隐身补丁，过 Cloudflare 通过率更高） */
function setupCloakPath() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'cloak-browser', 'chrome.exe')]
    : [path.join(__dirname, '..', 'build', 'cloak-browser', 'chrome.exe')];
  for (const p of candidates) {
    if (fs.existsSync(p)) { process.env.CLOAKBROWSER_BINARY_PATH = p; return p; }
  }
  return null;
}

(async () => {
  // ---- 环境准备（必须在 require server 之前） ----
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;                 // 数据落盘位置（可写）
  process.env.HOST = '127.0.0.1';                 // 只监听本机，安全性
  if (!process.env.HEADLESS) process.env.HEADLESS = 'false'; // 桌面端默认有头
  if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = ''; // 本机单机使用，免密
  // 桌面版默认用系统 Chrome（实测：CF 信任真 Chrome 二进制，Turnstile 无感通过；
  // PW 自带 Chromium / 补丁浏览器会被识别）。找不到 Chrome 则回退 PW 自带。
  if (!process.env.PW_CHANNEL) {
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    ].filter(Boolean);
    if (chromePaths.some(p => fs.existsSync(p))) {
      process.env.PW_CHANNEL = 'chrome';
      console.log('[main] 检测到系统 Chrome，桌面版默认使用系统 Chrome 跑任务（过 Turnstile 率最高）');
    }
  }
  if (!process.env.BROWSER_ENGINE) process.env.BROWSER_ENGINE = 'playwright'; // 桌面版默认引擎（配合 PW_CHANNEL=chrome 即系统 Chrome）

  const browsersPath = setupBrowsersPath();
  const cloakPath = setupCloakPath();
  // Camoufox 二进制路径（resources/camoufox/extracted/camoufox.exe）
  const camoufoxExe = app.isPackaged
    ? path.join(process.resourcesPath, 'camoufox', 'extracted', 'camoufox.exe')
    : path.join(__dirname, '..', 'build', 'camoufox', 'extracted', 'camoufox.exe');
  if (fs.existsSync(camoufoxExe)) {
    process.env.CAMOUFOX_EXE_PATH = camoufoxExe;
  }
  // Turnstile 自动点击扩展（cf-autoclick）路径
  const extDir = app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, '..', 'extension');
  if (fs.existsSync(path.join(extDir, 'manifest.json'))) {
    process.env.TURNSTILE_EXTENSION_DIR = extDir;
  }
  const PORT = await findFreePort(3920);
  process.env.PORT = String(PORT);

  let mainWin = null;
  let serverStarted = false;

  async function startServer() {
    if (serverStarted) return;
    require('../src/server.js');
    serverStarted = true;
    // 等端口就绪
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/config`);
        if (r.ok) return true;
      } catch (e) { /* 继续等 */ }
      await new Promise(r => setTimeout(r, 400));
    }
    return false;
  }

  function createWindow() {
    mainWin = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1100,
      minHeight: 700,
      title: 'VOXI 优惠码提取器',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWin.setMenuBarVisibility(false);
    mainWin.loadURL(`http://127.0.0.1:${PORT}/`);
    // 外链用系统浏览器打开
    mainWin.webContents.setWindowOpenHandler(({ url }) => {
      require('electron').shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWin.on('closed', () => { mainWin = null; });
  }

  await app.whenReady();

  const ok = await startServer();
  if (!ok) {
    dialog.showErrorBox('启动失败', '本地服务未能启动，请重启程序。');
    app.quit();
    return;
  }
  createWindow();

  // CloakBrowser 未随包附带时提示（不影响 Playwright 引擎兜底）
  if (!cloakPath) {
    dialog.showMessageBox({
      type: 'warning',
      title: '提示',
      message: '未找到内置 CloakBrowser 二进制，任务将回退到 Playwright 引擎。如需 CloakBrowser，请执行 npm run precloak 后重新打包。',
    });
  }

  // 浏览器未随包附带时给出一次性提示
  if (!browsersPath) {
    dialog.showMessageBox({
      type: 'warning',
      title: '提示',
      message: '未找到内置浏览器（Playwright Chromium）。\\n首次运行任务时会尝试自动下载；如失败，请执行 npm run predist 后重新打包。',
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
})();

app.on('window-all-closed', () => {
  app.quit();
});

// 数据目录名（Electron 默认用 productName；保持一致即可）
app.setName(PRODUCT_DIR);
app.setPath('userData', path.join(app.getPath('appData'), PRODUCT_DIR));
