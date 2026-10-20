FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
# 규칙 최초 복사 원본(RULES_FILE=/app/data/rules.json 이 없을 때)
COPY rules.example.json ./rules.example.json
# OTA 적용 훅 자리(호스트 고정 스크립트가 추출). manifest 는 CI 가 버전·해시로 채운다. 서명(.sig)은 M4
COPY siot/ /siot/
RUN chmod 0755 /siot/ota.sh \
 && mkdir -p /app/data /app/state/health /app/state/requests /app/state/out
# CI 가 태그 버전을 굽는다(health.json version = OTA 대상 버전 판정)
ARG AGENT_VERSION=""
ENV SIOT_AGENT_VERSION=${AGENT_VERSION}
ENV RULES_SEED_FILE=/app/rules.example.json HEALTH_DIR=/app/state/health
CMD ["node", "src/index.js"]
