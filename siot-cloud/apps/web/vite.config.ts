import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// API 와 같은 origin 에서 서빙한다(HTTPS PWA 는 http://siot-*.local 을 호출할 수 없어 모든 GW 조작은 백엔드 경유).
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    VitePWA({
      // 목 모드(미리보기)는 캐시가 방해되므로 PWA 워커를 끈다
      disable: mode === 'mock',
      registerType: 'autoUpdate',
      manifest: {
        name: '시옷 설치·관리',
        short_name: '시옷',
        description: '시옷 게이트웨이·기기 설치와 세대 관리',
        lang: 'ko',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f6f6f4',
        theme_color: '#111111',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // 오프라인 셸: 앱 파일은 프리캐시, 내비게이션은 index.html 로. 앱 API·릴레이·SSE 는 캐시하지 않는다
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/app\/v1\//, /^\/v1\//, /^\/gateway/, /^\/healthz/, /^\/metrics/],
      },
    }),
  ],
  server: {
    proxy: mode === 'mock' ? undefined : { '/app/v1': 'http://localhost:8080' },
  },
}));
