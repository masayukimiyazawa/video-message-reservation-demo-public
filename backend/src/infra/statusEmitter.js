/**
 * Socket.IO ステータスエミッタ (要件 7.4・7.5・8.5)
 *
 * Recording_Service / Transcription_Service が録画・文字起こしの状態変化・
 * 失敗を Admin_UI へリアルタイム通知するための薄いラッパー。
 *
 * 設計方針:
 *  - Socket.IO サーバー本体（`io`）はアプリ起動時（index.js / Task 13）に生成・
 *    注入される。ここでは import 時に副作用（サーバー生成・接続）を起こさない。
 *  - サービスからはインターフェース `{ emit(event, payload) }` として注入され、
 *    テスト時にはモックへ差し替えられる（injectable / mockable）。
 *  - `io` が未設定（未配線）の場合でも例外を投げず黙って no-op とし、
 *    ドメイン/サービスのロジックがトランスポートの有無に依存しないようにする。
 */

/** Admin_UI へ録画状態変化を通知するイベント名 (要件 7.4・7.5・8.5)。 */
export const RECORDING_STATUS_EVENT = 'recording:status';

/**
 * Socket.IO サーバーをラップしたステータスエミッタを生成する。
 *
 * @param {object} [deps]
 * @param {{ emit: Function } | null} [deps.io] Socket.IO Server（または互換の emit を持つ対象）。
 *   未指定/null の場合、emit は no-op になる。
 * @param {{ warn?: Function, error?: Function }} [deps.logger] ログ出力先（既定 console）。
 * @returns {{ emit: (event: string, payload: object) => void, emitRecordingStatus: (payload: object) => void }}
 */
export function createStatusEmitter({ io = null, logger = console } = {}) {
  /**
   * 任意のイベントを送出する。io 未設定時は no-op。
   * 送出自体の失敗はログに記録するに留め、呼び出し元へは伝播しない
   * （通知の失敗が録画処理そのものを壊さないようにするため）。
   *
   * @param {string} event イベント名
   * @param {object} payload 送出ペイロード
   */
  function emit(event, payload) {
    if (!io || typeof io.emit !== 'function') {
      return;
    }
    try {
      io.emit(event, payload);
    } catch (err) {
      logger.warn?.(`[StatusEmitter] ${event} の送出に失敗しました:`, err);
    }
  }

  /**
   * 録画状態変化イベント（recording:status）を送出する。
   * @param {object} payload
   */
  function emitRecordingStatus(payload) {
    emit(RECORDING_STATUS_EVENT, payload);
  }

  return Object.freeze({ emit, emitRecordingStatus });
}

/**
 * 既定のステータスエミッタ（io 未配線）。
 *
 * アプリ起動時に Socket.IO サーバーを注入する構成（Task 13）では
 * `createStatusEmitter({ io })` を用いる。既定インスタンスは io を持たないため
 * emit は no-op であり、import 時に副作用を起こさない。
 */
export const statusEmitter = createStatusEmitter();

export default statusEmitter;
