# VOXI 优惠码自动提取器（Student Beans）

自动登录 [Student Beans](https://www.studentbeans.com) 学生账号 → 打开 [VOXI 优惠页](https://www.studentbeans.com/student-discount/uk/voxi) → 逐个点击 **"Get code & open site"** 揭示优惠码 → 在 Web 控制台展示 **优惠码 + 对应跳转链接**。

![技术栈](https://img.shields.io/badge/Node.js-20%2B-green) ![Playwright](https://img.shields.io/badge/Playwright-Chromium-blue) ![Docker](https://img.shields.io/badge/Docker-Compose-informational)

---

## ✨ 功能

| 功能 | 说明 |
|---|---|
| 👤 多账号管理 | Web 控制台添加/编辑/删除账号，密码加密存储于本地 JSON |
| 🤖 自动登录 | OAuth 流程（nav-login → accounts 域）自动填写账号密码，处理 Turnstile 等待与 Cookie 横幅 |
| 🎫 优惠码提取 | 遍历全部优惠卡片，点击揭示按钮，**三路捕获**：clipboard 劫持 / 模态框解析 / 页面码元素 |
| 🔗 链接捕获 | "open site" 新标签页的最终跳转链接（指向 voxi.co.uk） |
| 🖥️ 实时日志 | SSE 推送，浏览器无需刷新即可看到每一步 |
| 💾 会话复用 | 每账号独立浏览器 profile，登录成功后 Cookie 持久化，下次免登录 |
| 🍪 Cookie 导入 | 手动登录一次拿 Cookie 导入，彻底绕过 Turnstile 人机验证（支持 DevTools 请求头/JSON/cookies.txt 自动识别） |
| ⏰ 定时任务 | Cron 表达式自动跑全部账号 |
| 📤 导出 | 结果导出 CSV（Excel 兼容）/ JSON |
| 📸 失败截图 | 关键步骤自动截图存档，便于排查 |

## 🚀 快速开始（Docker，推荐）

```bash
# 1. 准备配置
cp .env.example .env
# 编辑 .env，至少修改 ADMIN_PASSWORD

# 2. 启动
docker compose up -d --build

# 3. 打开控制台
#    http://<服务器IP>:3920   输入 .env 里设置的 ADMIN_PASSWORD
```

日志：`docker compose logs -f`

## 🖥️ 本地开发/运行（无 Docker）

```bash
node >= 20

npm install
npx playwright install chromium --with-deps   # Linux 需加 --with-deps
npm start                                      # 默认 http://localhost:3920
```

> Windows 若无法下载 Playwright Chromium，可设 `PW_CHANNEL=chrome` 复用本机 Chrome。

## 📖 使用流程

1. **添加账号**：控制台左侧填 `备注名 / 邮箱 / 密码` → 添加
2. **运行提取**：点账号卡片上的 `▶ 运行`（或右上 `▶ 运行全部账号`）
3. **查看结果**：右侧表格显示 时间 / 账号 / 优惠内容 / 优惠码 / 链接，一键复制
4. （可选）开启定时：设置里勾选 `定时自动提取`，填 Cron（默认每天 08:00 跑全部账号）

### 首次登录注意事项 ⚠️

- **新 IP / 新设备首次登录**，Student Beans 可能要求点击**邮件验证链接**。此时任务状态会显示 `待验证`：
  1. 去邮箱点击验证链接完成验证；
  2. 回到控制台重新点 `▶ 运行` 即可（会话 profile 已保留现场）。
- 如长期卡在验证，可在自己电脑浏览器登录后，用 「导入Cookie」 按钮粘贴 Cookie 跳过登录。

### 🍪 手动登录一次，导入 Cookie（推荐，彻底绕过人机验证）

自动登录会被 Cloudflare Turnstile 拦截时，用手动登录拿到的 Cookie 最稳。三种方法任选其一：

#### 方法 A：`document.cookie` 一行代码（最简单，10 秒）

1. 在**自己电脑的浏览器**登录 `www.studentbeans.com`
2. 按 `F12` 打开开发者工具 → 点 **Console**（控制台）标签
3. 在输入框粘贴下面这行代码，按**回车**：

   ```javascript
   document.cookie
   ```

4. 复制输出的一整串（类似 `"sb_session=eyJhbG...; _ga=GA1.2..."`，带不带两边引号都行，程序会自动处理）
5. 控制台账号卡片点 「导入Cookie」→ 粘贴 → **解析预览** → **保存并启用**

> 若输出是空的 `""`，说明会话 Cookie 是 httpOnly（JS 读不到），用方法 B。

#### 方法 B：Copy as cURL（方法 A 输出为空时用）

1. `F12` → **Network**（网络）→ 按 `F5` 刷新页面
2. 在请求列表里**右键**点任意一条 `studentbeans.com` 的请求
3. 菜单选 **Copy** → **Copy as cURL (bash)**
4. 回到控制台「导入Cookie」框，**整段粘贴**（很长不用管，程序会自动提取其中的 `cookie:` 部分）

#### 方法 C：Request Headers 手动复制

1. `F12` → **Network** → `F5` 刷新 → 点任意一条 `studentbeans.com` 请求
2. 右侧面板找到 **Request Headers**（请求标头，不是 Response Headers）
3. 找到 `cookie:` 开头的行，复制冒号后**整串**

粘贴后程序自动识别格式（请求头字符串 / cURL 命令 / JSON / cookies.txt）。保存后点「▶ 运行」——有 Cookie 时优先走 Cookie，无效才回退密码登录。

## 🏗️ 架构

```
┌──────────────────────── Docker 容器 ────────────────────────┐
│  Express API (3920)  ── SSE 实时日志                        │
│      │                                                     │
│      ├── store.js        JSON 文件持久化(data/db.json)      │
│      ├── jobRunner.js    串行任务队列                        │
│      ├── scheduler.js    node-cron 定时                     │
│      └── scraper/                                            │
│           ├── browser.js     Playwright 持久化上下文+反检测   │
│           ├── login.js       OAuth 登录流                    │
│           └── extractVoxi.js 优惠码提取(3路捕获)              │
│                                                              │
│  public/  Web 控制台（原生 JS，无需构建）                     │
│  data/    {db.json, profiles/<账号>, artifacts/<任务>}        │
└──────────────────────────────────────────────────────────────┘
```

## ⚙️ 配置项（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3920` | 服务端口 |
| `ADMIN_PASSWORD` | 空 | 控制台访问密码，**强烈建议设置** |
| `HEADLESS` | `true` | 无头模式。调试时可设 `false`（容器内需接 VNC） |
| `PW_CHANNEL` | 空 | 指定系统浏览器渠道 `chrome` / `msedge` |
| `PROXY_URL` | 空 | 代理，如 `http://user:pass@host:port` |
| `BROWSER_LOCALE` / `BROWSER_TZ` | `en-GB` / `Europe/London` | 建议保持英国，价格/优惠以英镑展示 |
| `STEP_DELAY_MS` | `1500` | 每次点击间隔，太短易触发风控 |
| `MAX_OFFERS_PER_RUN` | `20` | 单轮最多处理卡片数 |
| `SCHEDULE_ENABLED` / `SCHEDULE_CRON` | `false` / `0 8 * * *` | 定时任务 |

## 🔍 工作原理（基于 2026-09 实测的站点结构）

- **登录**：打开主页 → 接受 OneTrust Cookie 横幅 → 点击 `a[data-testid="nav-login"]`（失败则回退到其完整 OAuth 链接）→ 跳转 `accounts.studentbeans.com` → 填写 `#email` / `#password` → 等待 `input[name=cf-turnstile-response]` 出 token（提交按钮在此之前是 disabled）→ 等待跳回主站
- **登录态判断**：导航栏 `[data-testid="nav-login"]` 链接消失即为已登录（注意：未登录页也存在 profile-img，不能作判断依据）
- **优惠卡片**：每张卡片对应一个 `div[data-testid="offer-issuance-button"]`，按钮文本 "Get code & open site"，标题取按钮最近的 `article` 祖先首行
- **提取流程**（2026-09 实测确认）：列表页每张卡片一个「Get code & open site」按钮（共 4 个优惠）→ 点击后**弹出新标签页** → 新标签页内显示优惠码（`STB` 开头，如 `STB274EA12TO0`）→ 新标签页内「Re-open the VOXI mobile website」**按钮的链接**才是正确跳转链接 → 对新标签页截图留证 → 关闭 → 回列表页处理下一张
- **码的捕获**：优先在新标签页文本匹配 `STB[A-Z0-9]{6,14}`（Student Beans 码格式），兜底 clipboard / 模态框 / 网络响应 JSON
- **链接的捕获**：新标签页内文本匹配 re-open/open/continue/visit 的按钮取 href（onclick 里的 URL 也能提取），兜底页面内任意 `voxi.co.uk` 链接
- **排查工件**：每张卡片保存 `offer-N.txt`（页面全文）+ `offer-N.png`（截图）到 `data/artifacts/<任务ID>/`，控制台「任务记录」里也有链接可直接点开

> 站点前端改版时选择器可能变化：所有选择器集中在 `src/scraper/login.js` 与 `src/scraper/extractVoxi.js`；失败时 `data/artifacts/<任务>/` 里有现场截图和 HTML。可用 `npm run probe`（需先 `PROBE_CHANNEL=chrome`）重新探测结构。

## ⚠️ 版本匹配规则（重要）

容器内的 `playwright` npm 包版本**必须**与 Docker 镜像 tag 一致，否则会报：

```
Executable doesn't exist at /ms-playwright/chromium_headless_shell-xxxx/...
Looks like Playwright was just updated to X. Please update docker image as well.
```

当前约定：`package.json` 里 `playwright` 为**精确版本**（无 `^`），`Dockerfile` 的 `FROM` tag 与其一致。
升级步骤：本地 `npm install playwright@<版本>` → 提交新的 `package.json` + `package-lock.json` → 同步改 Dockerfile 镜像 tag。
Dockerfile 里用 `npm ci`（不用 `npm install` 回退），lock 不同步时构建会直接失败以提醒你。

## 🧰 开发脚本

| 命令 | 说明 |
|---|---|
| `npm start` | 启动服务 |
| `npm run probe` | 探测登录页/优惠页 DOM 结构（改版后用它重新确认选择器） |
| `npm run smoke` | 全流程自测：起服务 → 加测试账号 → 跑任务 → 轮询状态 → 导出校验 |

## ⚠️ 合规与风险提示

- 本工具为**个人技术研究**用途。自动化登录可能违反 Student Beans 服务条款，账号存在被限制的风险，请自行评估
- 账号密码仅保存在**你自己的服务器**（`data/db.json`），请勿使用不信任的主机，并设置 `ADMIN_PASSWORD`
- 建议控制频率（默认 1.5s 间隔、每天最多几次），并对代理 IP 友好使用
- 「待验证」状态请通过官方邮件完成验证，**不要**尝试绕过验证机制

## 🛠️ 常见问题

**Q: 任务卡在登录，日志提示「提交按钮仍处于禁用状态」？**
A: 这是 **Cloudflare Turnstile 人机验证**未通过（国内 IP + 无头环境高发）。按优先级尝试：
1. 把服务器放在**英国/海外**（Student Beans 对地区敏感，且 Turnstile 对住宅 IP 通过率高）
2. 设 `PROXY_URL` 走住宅代理
3. `HEADLESS=false` 接 VNC 手动过一次验证，profile 会记住会话
4. 终极方案（最稳）：在自己电脑浏览器登录后，用「导入Cookie」粘贴 Cookie（见上文手动登录教程），完全不走自动登录

**Q: 日志显示「登录成功」但点击优惠码又被弹回登录页？**
A: 旧版本曾因 OAuth 回调中间页（无导航栏）误判登录态。新版已加「功能校验」：登录后会真实访问一次优惠页确认会话有效，无效则明确报错并保存 `session-verify-fail.png` + Cookie 诊断日志。若遇到此报错，请把日志里「诊断 Cookie」那几行发给我。
**Q: 任务状态是「待验证」？**
A: Student Beans 对新 IP/新设备要求邮件验证。去邮箱点链接后重跑即可；或直接导入 Cookie。

**Q: 提示"未发现优惠卡片/按钮"？**
A: 站点改版或地区不对。确认服务器 IP 在**英国**，查看 artifacts 里的截图，必要时 `npm run probe` 重新确认选择器。

**Q: 跑完了但没抓到优惠码，去哪看现场？**
A: 两个地方：① 控制台左侧「任务记录」里每条任务下方有 `offer-N.png / offer-N.txt` 链接，点开就是点击当时的截图和页面全文（能看到是弹了验证页、跳了 voxi 官网还是要求验证学生身份）；② 服务器上 `data/artifacts/<任务ID>/` 目录。把 `offer-N.txt` 的内容发给我即可精准定位。

**Q: 想抓别的品牌？**
A: 把 `.env` 里 `VOXI_PAGE_URL` 换成目标品牌页即可，提取逻辑是通用的。

**Q: 数据备份？**
A: 打包 `data/` 目录即可（含全部账号、结果、会话、截图）。
