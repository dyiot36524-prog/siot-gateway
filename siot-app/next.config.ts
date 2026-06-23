import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 라즈베리파이/도커/HA 애드온 배포용 최소 산출물(.next/standalone/server.js).
  // npm start(next start)에는 영향 없음.
  output: "standalone",
  // mDNS(bonjour-service)는 instrumentation에서 쓰는데, 파일 트레이서가 자동으로
  // 못 잡아 standalone에서 누락된다 → 외부 패키지로 두고 의존성을 명시 포함시킨다.
  serverExternalPackages: ["bonjour-service"],
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/bonjour-service/**/*",
      "./node_modules/multicast-dns/**/*",
      "./node_modules/dns-packet/**/*",
      "./node_modules/thunky/**/*",
      "./node_modules/fast-deep-equal/**/*",
      "./node_modules/@leichtgewicht/ip-codec/**/*",
    ],
  },
};

export default nextConfig;
