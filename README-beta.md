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

# 2. 装依赖
npm install
```

### 下载 Electron 和 Chromium（国内网络用镜像）

Electron 主程序和 Chromium 浏览器都要从国外服务器下载，国内直连很慢或失败，设置镜像：

```bash
# Electron 镜像（写入 .npmrc 后重装）
npm config set electron_mirror https://npmmirror.com/mirrors/electron/
npm install

# Chromium 镜像（构建时下载浏览器）
set PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright
npm run dist
```

### 产物

```
dist/VOXI优惠码提取器-portable.exe    ← 绿色单文件便携版（约 200MB）
```

把这个 exe 拷到任何 Windows 电脑上，**双击即用**，无需安装。

> `npm run dist-full` 可构建带安装向导的完整版（dist/ 下会有 setup.exe，默认装在 `%LOCALAPPDATA%\Programs\VOXI优惠码提取器`）。

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
