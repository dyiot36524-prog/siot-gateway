# syntax=docker/dockerfile:1.7
# 시옷 클라우드(Fly 앱 1개: API·릴레이·웹훅 워커·PWA). 빌드 컨텍스트 = siot-cloud/
#   fly deploy            (fly.toml 의 [build] dockerfile)
#   docker build -t siot-cloud .
# 실행 방식: tsx 로 TS 소스를 그대로 실행한다(@siot/protocol 이 빌드 없이 src/index.ts 를 export 하므로 번들 단계 없음).
#   ↳ README "배포" 절. tsx 는 @siot/api 의 dependencies(런타임)다.

ARG NODE_VERSION=22

# ---- 1) 전체 의존성 + PWA 빌드 ----
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY tools/partner-sim/package.json tools/partner-sim/
COPY tools/slo/package.json tools/slo/
RUN npm ci --no-audit --no-fund
COPY packages/protocol packages/protocol
COPY apps/web apps/web
RUN npm -w apps/web run build

# ---- 2) 런타임 의존성만(api + protocol) ----
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY tools/partner-sim/package.json tools/partner-sim/
COPY tools/slo/package.json tools/slo/
RUN npm ci --omit=dev --no-audit --no-fund -w apps/api -w packages/protocol --include-workspace-root=false

# ---- 3) 실행 이미지 ----
FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY --from=prod-deps /app/node_modules node_modules
COPY package.json tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
COPY apps/api/src apps/api/src
COPY apps/api/drizzle apps/api/drizzle
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
WORKDIR /app/apps/api
EXPOSE 8080
# 마이그레이션은 fly.toml [deploy] release_command 가 먼저 돌린다
CMD ["node", "--import", "tsx", "src/server.ts"]
