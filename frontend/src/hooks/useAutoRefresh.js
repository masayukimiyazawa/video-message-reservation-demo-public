import { useEffect, useRef } from 'react';

/**
 * 未完了アイテムが残っている間だけ一定間隔で再取得するフック（GAP 1）。
 *
 * 背景:
 *  Vonage 側で録画アーカイブが `available` になるまでダウンロード URL が
 *  発行されない。従来は管理画面の Refresh を押すまで DL リンクが現れなかった。
 *  このフックは「まだ DL 可能でないアイテム」が存在する間だけ裏で再取得し、
 *  全件そろった時点で自動的に停止する（Refresh 不要化）。
 *
 * 無限ポーリングを避けるための割り切り:
 *  - maxAttempts 回で打ち切る（恒久的に未完了なアイテム対策）
 *  - enabled が false になったらタイマーを破棄し試行回数をリセットする
 *  - onRefresh は ref 経由で最新を呼ぶ（親の再レンダーでタイマーを張り直さない）
 *
 * @param {object} params
 * @param {boolean} params.enabled 未完了アイテムがある間 true
 * @param {() => void} params.onRefresh 再取得処理（通常は loading を出さない silent 版）
 * @param {number} [params.intervalMs] ポーリング間隔（既定 5 秒）
 * @param {number} [params.maxAttempts] 最大試行回数（既定 24 回 = 約 2 分）
 */
export function useAutoRefresh({ enabled, onRefresh, intervalMs = 5000, maxAttempts = 24 }) {
  const attemptsRef = useRef(0);
  const onRefreshRef = useRef(onRefresh);

  // 毎レンダー後に最新のハンドラへ更新する（依存配列に入れて張り直さないため）。
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  });

  useEffect(() => {
    if (!enabled) {
      attemptsRef.current = 0;
      return undefined;
    }

    attemptsRef.current = 0;
    const timer = setInterval(() => {
      if (attemptsRef.current >= maxAttempts) {
        clearInterval(timer);
        return;
      }
      attemptsRef.current += 1;
      onRefreshRef.current?.();
    }, intervalMs);

    return () => clearInterval(timer);
  }, [enabled, intervalMs, maxAttempts]);
}

export default useAutoRefresh;
