import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 라즈베리파이/도커/HA 애드온 배포용 최소 산출물(.next/standalone/server.js).
  // npm start(next start)에는 영향 없음.
  output: "standalone",
};

export default nextConfig;
