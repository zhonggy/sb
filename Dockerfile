# 基于 Playwright 官方镜像（已内置 Chromium 及全部系统依赖，无需下载浏览器）
# ⚠️ 镜像 tag 必须与 package.json 中 playwright 的精确版本一致！
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    TZ=Europe/London \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# 先装依赖（利用层缓存）
# 注意：必须用 npm ci（按 lock 精确安装）；若 lock 与 package.json 不同步，
# 构建会直接失败——这是故意的，防止装成其他版本导致与镜像内置浏览器不匹配。
# 若需升级 playwright：本地 npm install 重新生成 lock，并同步修改上面的镜像 tag。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 拷贝源码
COPY src ./src
COPY public ./public

# CloakBrowser 隐身 Chromium 二进制预下载
# - 传了 CLOAKBROWSER_LICENSE_KEY（build-arg）→ 下载对应 license 的最新版
# - PRELOAD_CLOAK=1 → 无 key 也预下载免费版（v146）
# - 都没传 → 跳过，首次使用 cloak 引擎时运行时下载（约 200MB，可能较慢）
# 下载失败不阻断构建，运行时会重试。
ARG CLOAKBROWSER_LICENSE_KEY=
ARG PRELOAD_CLOAK=0
RUN if [ -n "$CLOAKBROWSER_LICENSE_KEY" ] || [ "$PRELOAD_CLOAK" = "1" ]; then \
      node -e "import('cloakbrowser').then(({ensureBinary})=>ensureBinary().then(i=>console.log('cloakbrowser 就绪:',(i&&i.version)||i)).catch(e=>console.log('cloakbrowser 预下载失败（运行时重试）:',e.message)))"; \
    else echo 'skip cloak preload（构建时加 --build-arg PRELOAD_CLOAK=1 可启用）'; fi

# 数据卷：账号、任务、结果、浏览器 profile、截图都持久化在这里
RUN mkdir -p /app/data && chmod -R 777 /app/data
VOLUME ["/app/data"]

EXPOSE 3920

# 健康检查
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3920)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
