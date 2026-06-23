# 시옷앱 게이트웨이 — HA 애드온/도커 배포용 이미지.
# 멀티스테이지: 빌드 → Next standalone 최소 런타임.
# (HA 애드온은 라즈베리파이(arm64/armv7)에서 이 Dockerfile을 온디바이스 빌드한다.)

# ── 빌드 스테이지 ─────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
# 의존성 먼저 설치(레이어 캐시).
COPY package.json package-lock.json ./
RUN npm ci
# 소스 복사 후 빌드 (output: "standalone" → .next/standalone/server.js).
COPY . .
RUN npm run build

# ── 런타임 스테이지 ───────────────────────────
FROM node:20-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
# standalone 산출물 + 정적 자원/공개 파일 복사(standalone은 이 둘을 자동 포함 안 함).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY run.sh /run.sh
RUN chmod +x /run.sh
EXPOSE 3000
CMD ["/run.sh"]
