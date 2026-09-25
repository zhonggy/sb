# VOXI 优惠码提取器 — 桌面版（beta）

把项目打包成 **Windows 桌面程序**：双击即用，**不需要安装 Node、不需要配置环境变量、不需要 Docker**。浏览器以**有头模式**运行——自动化过程看得见，遇到 Cloudflare 人机验证时**可以直接用鼠标手动点**，点完自动继续。

> 服务器部署请用 `master` 分支（Docker 版本）。本分支（`beta`）是桌面版构建分支。

---

## 一、构建（在 Windows 电脑上做一次）

需要：**Node.js 20+**（只在这一步需要，做出来的程序本身不需要）

```bash
# 1. 拉代码
git clone -b beta https://github.com/zhonggy/sb.git
cd sb

# 2. 装依赖（网络失败就多重试几次，npm 有时会抽风）
npm install
```

### 下载 Electron 二进制（如 npm install 没自动下全）

Electron 主程序约 110MB。若 `node_modules/electron/dist/electron.exe` 不存在，手动补：

```bash
# 镜像下载（如失败，把 https://npmmirror.com 换成你的代理出口）
curl -L -o electron.zip "https://npmmirror.com/mirrors/electron/33.4.11/electron-v33.4.11-win32-x64.zip"
# 用资源管理器解压，或 PowerShell：
#   Expand-Archive -Path electron.zip -DestinationPath node_modules\electron\dist -Force
```

### 下载 Chromium + 构建

```bash
# Chromium（约 170MB，走本地代理最快；没有代理再用镜像，或重试）
set HTTPS_PROXY=http://127.0.0.1:7897
set HTTP_PROXY=http://127.0.0.1:7897
npm run dist
```

```bash
# 备用：镜像源（部分版本镜像缺失，失败就走上面的代理）
set PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright
npm run predist
npx electron-builder --win portable
```

### 产物

```
dist/VOXI优惠码提取器-portable.exe    ← 绿色单文件便携版（约 270MB）
```

双击即用，无需安装任何环境。> `npm run dist-full` 可构建带安装向导的完整版（dist/ 下会有 setup.exe，默认装在 `%LOCALAPPDATA%\Programs\VOXI优惠码提取器`）。

### 已验证的构建记录（2026-09-25，Windows x64）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | `npm install` | ✅ Electron 33.4.11 |
| Electron 二进制 | 镜像下载 + `Expand-Archive` 解压到 `node_modules/electron/dist` | ✅ |
| Chromium（Playwright 兜底引擎） | `HTTPS_PROXY=127.0.0.1:7897 npm run predist` | ✅ chromium-1243（153.0.8010.12） |
| CloakBrowser（桌面版默认引擎） | `HTTPS_PROXY=127.0.0.1:7897 npm run precloak` | ✅ v146.0.7680.177（免费版免 key） |
| 打包 | `npx electron-builder --win portable` | ✅ 402MB 单文件 |
| 运行验证 | win-unpacked 直接运行 + 任务实测 | ✅ **任务浏览器来自 resources\cloak-browser\chrome.exe（CloakBrowser 生效）** |

### ⚠️ 首次运行 portable.exe 的可能提示

程序未做数字签名，Windows SmartScreen 可能提示「Windows 已保护你的电脑」：点 **更多信息 → 仍要运行** 即可（只出现一次）。

嫌麻烦也可以直接运行免安装版：`dist/win-unpacked/VOXI优惠码提取器.exe`（双击即用，内容与 portable 完全一致）。

### 桌面版默认引擎：CloakBrowser

- 任务日志出现 `浏览器引擎: CloakBrowser（humanize=true，无 key 使用免费版）` 即在用隐身浏览器
- CloakBrowser 启动失败会**自动回退 Playwright 引擎**（日志有说明）
- 「运行设置」里可填 License Key 升级最新版（留空用免费版 v146，免 key）
- 有头模式下浏览器窗口可见，**遇到人机验证可直接用鼠标手动点**，程序自动继续
| 运行 exe | 双击 + 端口扫描 + API 验证 | ✅ 服务/页面/浏览器启动全部正常 |

---

## 二、使用

1. 双击 `VOXI优惠码提取器-portable.exe`
2. 弹出两个窗口：
   - **控制台窗口**（程序主界面）：添加账号、导入 Cookie、运行、看结果
   - **Chromium 浏览器窗口**（运行时出现）：自动化操作全程可见
3. 遇到人机验证（Turnstile 复选框）时，**直接用鼠标在浏览器窗口里点掉**，程序会自动继续
4. 结果在控制台里查看/导出（TXT 文件名自动带账号邮箱+日期）

## 三、数据放在哪

| 内容 | 位置 |
|---|---|
| 账号、结果、任务记录 | `%APPDATA%\voxi-extractor\data\db.json` |
| 浏览器配置（会话） | `%APPDATA%\voxi-extractor\data\profiles\` |
| 失败截图等工件 | `%APPDATA%\voxi-extractor\data\artifacts\` |

换电脑/备份：拷走 `%APPDATA%\voxi-extractor\data` 整个目录即可。

## 四、和服务器版的区别

| | 桌面版（beta） | 服务器版（master） |
|---|---|---|
| 运行方式 | 双击 exe | Docker Compose |
| 环境要求 | 无（Node 已打进包） | Docker |
| 浏览器 | **有头（可见，可手动过人机验证）** | 无头 |
| 服务监听 | 仅 127.0.0.1（本机） | 0.0.0.0（局域网可访问） |
| 访问密码 | 不需要（单机） | 建议设 `ADMIN_PASSWORD` |
| 数据 | `%APPDATA%\voxi-extractor\data` | `./data`（卷挂载） |
| Resin 代理 / CloakBrowser / Cookie 导入 | ✅ 全部支持 | ✅ |

## 五、常见问题

**Q: 双击没反应/闪退？**
A: 看 `%APPDATA%\voxi-extractor\` 下有没有日志；确认不是从压缩包内直接运行（先解压）。

**Q: 提示找不到浏览器？**
A: 构建时 `npm run predist` 没成功（国内网络常见）。重新执行：

```bash
set PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright
npm run predist
npm run dist
```

**Q: 端口被占用？**
A: 程序会自动从 3920 开始找空闲端口，一般无需干预。

**Q: 浏览器窗口可以最小化吗？会影响运行吗？**
A: 可以最小化，程序继续跑；但**不要关闭**浏览器窗口（会导致任务中断）。

**Q: 人机验证出现了但我没来得及点？**
A: 程序有 120 秒自动监视+自动点击；超过时间会任务失败，重跑一次即可，浏览器窗口留着随时可以手动介入。

**Q: 想同时跑多个账号？**
A: 任务队列是串行的（同一时间一个浏览器），多个账号会排队依次跑——有头模式下你也看不过来，建议逐个跑。

## 六、开发调试（不打包直接跑）

```bash
npm install
npm run predist          # 下载 Chromium 到 build/
npm run electron         # 源码模式启动 Electron
```
