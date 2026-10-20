import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// API 와 같은 origin 에서 서빙한다(HTTPS PWA 는 http://siot-*.local 을 호출할 수 없어 모든 GW 조작은 백엔드 경유).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '시옷 설치·관리',
        short_name: '시옷',
        lang: 'ko',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#111111',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // 앱 API·릴레이·SSE 는 캐시하지 않는다
        navigateFallbackDenylist: [/^\/app\/v1\//, /^\/v1\//, /^\/gateway/, /^\/healthz/, /^\/metrics/],
      },
    }),
  ],
  server: {
    proxy: { '/app/v1': 'http://localhost:8080' },
  },
});
