// Vitest グローバルセットアップ。
// @testing-library/jest-dom の DOM マッチャ（toBeInTheDocument など）を有効化し、
// 各テスト後に描画済みコンポーネントを破棄する。
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// localStorage モック（jsdom には localStorage がないため）
const localStorageMock = {
  getItem: vi.fn((key) => {
    return localStorageMock.store[key] || null;
  }),
  setItem: vi.fn((key, value) => {
    localStorageMock.store[key] = value;
  }),
  removeItem: vi.fn((key) => {
    delete localStorageMock.store[key];
  }),
  clear: vi.fn(() => {
    localStorageMock.store = {};
  }),
  store: {},
};

// グローバルに localStorage をモック
Object.defineProperty(global, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

afterEach(() => {
  cleanup();
  localStorageMock.clear();
});
