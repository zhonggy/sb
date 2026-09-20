# 基于 Playwright 官方镜像（已内置 Chromium 及全部系统依赖，无需下载浏览器）
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    TZ=Europe/London

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 拷贝源码
COPY src ./src
COPY public ./public

# 数据卷：账号、任务、结果、浏览器 profile、截图都持久化在这里
RUN mkdir -p /app/data && chmod -R 777 /app/data
VOLUME ["/app/data"]

EXPOSE 3920

# 健康检查
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3920)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
