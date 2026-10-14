/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// フロントエンド開発サーバーは 5173、API は backend の 4000 を想定。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/webhooks': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/sessions': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/webhooks': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/recordings': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/transcriptions': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/webhooks': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/sessions': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  test: {
    // jsdom で React コンポーネントを描画してユニットテストを実行する。
    environment: 'jsdom',
    // describe/it/expect などをグローバルに公開する。
    globals: true,
    // 各テスト前に jest-dom マッチャを読み込む共通セットアップ。
    setupFiles: ['./src/test/setup.js'],
    // テスト対象は src 配下の *.test.{js,jsx} のみ。
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
  },
});
