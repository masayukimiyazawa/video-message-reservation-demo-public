import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoRefresh } from './useAutoRefresh.js';

/**
 * useAutoRefresh の単体テスト（GAP 1: 管理画面の自動更新）。
 *
 * Vonage 側でアーカイブが available になるまで DL リンクが出ないため、
 * 未完了アイテムが残る間だけポーリングし、完了・打ち切りで停止することを検証する。
 */

describe('useAutoRefresh (GAP 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('enabled の間だけ一定間隔で onRefresh を呼ぶ', () => {
    const onRefresh = vi.fn();
    renderHook(() =>
      useAutoRefresh({ enabled: true, onRefresh, intervalMs: 1000, maxAttempts: 3 }),
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('maxAttempts に達したら打ち切る（無限ポーリング防止）', () => {
    const onRefresh = vi.fn();
    renderHook(() =>
      useAutoRefresh({ enabled: true, onRefresh, intervalMs: 1000, maxAttempts: 2 }),
    );

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('enabled が false の間は呼ばない', () => {
    const onRefresh = vi.fn();
    renderHook(() =>
      useAutoRefresh({ enabled: false, onRefresh, intervalMs: 1000, maxAttempts: 5 }),
    );

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('enabled が true→false になると停止する（全件完了で自動停止）', () => {
    const onRefresh = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useAutoRefresh({ enabled, onRefresh, intervalMs: 1000, maxAttempts: 5 }),
      { initialProps: { enabled: true } },
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('アンマウントでタイマーを破棄する', () => {
    const onRefresh = vi.fn();
    const { unmount } = renderHook(() =>
      useAutoRefresh({ enabled: true, onRefresh, intervalMs: 1000, maxAttempts: 5 }),
    );

    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('再レンダー後は最新の onRefresh を呼ぶ', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ onRefresh }) => useAutoRefresh({ enabled: true, onRefresh, intervalMs: 1000, maxAttempts: 5 }),
      { initialProps: { onRefresh: first } },
    );

    rerender({ onRefresh: second });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
