# =============================================================
#  广州公积金买房贷款测算器 —— 单容器镜像
#  静态前端 + Node 后端 + SQLite，支持 linux/amd64 与 linux/arm64
# =============================================================

# ---------- 阶段 1：安装依赖（better-sqlite3 优先用预编译包，兜底本地编译） ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# ---------- 阶段 2：运行时（不含编译工具链，镜像更小） ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=8888 \
    DATA_DIR=/app/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY config/ ./config/
COPY public/ ./public/

# 版本号：优先用发布时传入的 APP_VERSION（= 发布时间），否则回退到构建时刻
ARG APP_VERSION=""
RUN echo "${APP_VERSION:-v$(date +%y%m%d-%H%M)}" > /app/VERSION \
 && mkdir -p /app/data

EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8888)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
