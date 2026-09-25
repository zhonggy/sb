/**
 * Camoufox（打补丁的 Firefox）引擎支持
 * ============================================================
 * 与 CloakBrowser（Chromium）不同的反检测路线：Firefox 152 深度补丁。
 * 针对 Cloudflare Turnstile 的关键能力：disable_coop（见 launchPrefs）。
 *
 * 二进制获取：scripts/prebuild-camoufox.js 从 GitHub releases 下载解压
 *   - 开发版: build/camoufox/extracted/camoufox.exe
 *   - 打包版: Electron 主进程设 CAMOUFOX_EXE_PATH 指向 resources/camoufox/...
 * 指纹配置：仓库内置预设（camoufox-preset.json，来自 camoufox 官方预设库）
 *   → 扁平化为点分键 → JSON 按 2047 字符切片 → CAMOU_CONFIG_* 环境变量
 *
 * 注意：cf-autoclick Chrome 扩展在 Firefox 下不可用（world:MAIN + CDP 均
 * 为 Chrome 专属），但 disable_coop 原生覆盖了该扩展的作用（允许点击跨域
 * iframe 的 Turnstile 复选框），由我们自己的 humanClickCheckbox 执行点击。
 */
const path = require('path');
const fs = require('fs');

let _exeCache;

/** 解析 camoufox 可执行文件路径 */
function getExePath() {
  if (_exeCache !== undefined) return _exeCache;
  const candidates = [];
  if (process.env.CAMOUFOX_EXE_PATH) candidates.push(process.env.CAMOUFOX_EXE_PATH);
  candidates.push(path.join(__dirname, '..', '..', 'build', 'camoufox', 'extracted', 'camoufox.exe'));
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { _exeCache = p; return p; } } catch (e) { /* continue */ }
  }
  _exeCache = null;
  return null;
}

/** 扁平化嵌套对象为点分键（navigator.userAgent 形式，camoufox 配置格式） */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? v.join('|') : v;
  }
  return out;
}

/** 读取内置指纹预设 */
function getPreset() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'camoufox-preset.json'), 'utf8'));
}

/**
 * 生成 CAMOU_CONFIG_* 环境变量（Windows 上 JSON 按 2047 字符切片，
 * 与官方 Python 包装器相同的行为）
 */
function buildConfigEnv() {
  const flat = flatten(getPreset());
  const json = JSON.stringify(flat);
  const CHUNK = 2047;
  const env = {};
  for (let i = 0; i < json.length; i += CHUNK) {
    env[`CAMOU_CONFIG_${i / CHUNK + 1}`] = json.slice(i, i + CHUNK);
  }
  return env;
}

/**
 * Firefox 首选项：
 * - disable_coop：关闭跨域 opener 策略，允许点击 Turnstile 复选框（官方参数）
 */
function launchPrefs() {
  return {
    'browser.tabs.remote.useCrossOriginOpenerPolicy': false,
  };
}

module.exports = { getExePath, buildConfigEnv, launchPrefs, flatten, getPreset };
