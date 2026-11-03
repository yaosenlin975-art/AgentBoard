# AgentBoard 单容器镜像（DOCKER-3）
#
# 设计取舍：
# - 多阶段：构建阶段需要 devDependencies（tsc / vite / tailwind）与全部 workspace 源码；运行阶段只带构建产物。
# - 运行阶段整体复制 /app（含 node_modules）：pnpm workspace 用符号链接，裁剪成「生产依赖」需要额外处理
#   `apps/server/node_modules/@agentboard/*` 的链接与 better-sqlite3 原生模块，本轮优先保证冒烟可跑，
#   裁剪列为后续优化（见 Docs/docker-2026-11-03.md「未做/未证实」）。
# - 监听地址只在运行时用 ENV 放宽到 0.0.0.0：本机默认仍是 127.0.0.1（DOCKER-1）。
# - 只有一个卷 /data：DB（/data/agentboard.db）与附件（/data/attachments）都由 AGENTBOARD_DB 派生（DOCKER-2）。

FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 走 prebuild-install 下载预编译二进制，正常不需要本地工具链（镜像更小、构建更快）。
# 若网络受限导致预编译包下载失败（node-gyp 报缺少 python/make/g++），放开下面一行重试源码编译：
# RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
# 各包 tsconfig.build.json extends 根 tsconfig.base.json（pnpm install 不需要它，故放在 install 之后复用缓存）
COPY tsconfig.base.json ./
RUN pnpm -r build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN corepack enable
COPY --from=build /app ./

# DOCKER-CLI：镜像里已有 packages/cli/dist（build 阶段 pnpm -r build 产物），这里只补一个可执行入口，
# 容器内 agent 可直接用 kb claim/comment/done，不必回到宿主机代为执行。
RUN printf '#!/bin/sh\nexec node /app/packages/cli/dist/index.js "$@"\n' > /usr/local/bin/kb \
 && chmod 0755 /usr/local/bin/kb

ENV NODE_ENV=production \
    AGENTBOARD_HOST=0.0.0.0 \
    AGENTBOARD_PORT=8787 \
    AGENTBOARD_DB=/data/agentboard.db

VOLUME ["/data"]
EXPOSE 8787

# 探活打 /api/version（不依赖 shell，镜像里没有 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/server/dist/index.js"]
