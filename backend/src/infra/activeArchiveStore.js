/**
 * 進行中アーカイブ（録画）ストア（インフラ層）
 *
 * sessionId → archiveId の対応をプロセス内メモリで保持する。
 *
 * なぜ必要か（要件 7・10）:
 *  録画は (a) ゲスト入室時の自動開始、(b) 管理画面からの手動開始 の 2 経路で
 *  始まる。会議終了（ユーザと管理者の全員退室）時に「進行中の録画を確実に停止する」
 *  には、開始経路に依らず archiveId を参照できる必要がある。
 *  従来は roomLifecycleService 内のローカル Map に自動録画しか登録されておらず、
 *  管理画面から手動開始した録画が全員退室時に停止されない不具合があった。
 *
 * 役割分担:
 *  - recordingService.startRecording 成功時に set する（自動・手動の両経路）
 *  - recordingService.stopRecording 成功時に deleteByArchiveId する
 *  - roomLifecycleService は会議終了時に get して停止し、delete する
 *
 * 割り切り:
 *  プロセス内メモリのため再起動で消える。停止漏れは Vonage の Archive Monitoring
 *  Webhook（status=stopped）でも回復できるため、永続化は必須としない。
 *
 * @module infra/activeArchiveStore
 */

/**
 * 進行中アーカイブストアを生成する。
 *
 * @returns {{
 *   set: (sessionId: string, archiveId: string) => void,
 *   get: (sessionId: string) => (string|null),
 *   delete: (sessionId: string) => boolean,
 *   deleteByArchiveId: (archiveId: string) => boolean,
 *   clear: () => void,
 * }}
 */
export function createActiveArchiveStore() {
  /** @type {Map<string, string>} */
  const bySession = new Map();

  return Object.freeze({
    /**
     * 進行中アーカイブを登録する。空値は無視する。
     * @param {string} sessionId
     * @param {string} archiveId
     */
    set(sessionId, archiveId) {
      if (isNonEmptyString(sessionId) && isNonEmptyString(archiveId)) {
        bySession.set(sessionId, archiveId);
      }
    },

    /**
     * セッションに紐づく進行中アーカイブ ID を返す（無ければ null）。
     * @param {string} sessionId
     * @returns {string|null}
     */
    get(sessionId) {
      return bySession.get(sessionId) ?? null;
    },

    /**
     * セッションの登録を削除する。
     * @param {string} sessionId
     * @returns {boolean} 削除できたら true
     */
    delete(sessionId) {
      return bySession.delete(sessionId);
    },

    /**
     * アーカイブ ID から登録を削除する（停止成功時に使用）。
     * @param {string} archiveId
     * @returns {boolean} 削除できたら true
     */
    deleteByArchiveId(archiveId) {
      if (!isNonEmptyString(archiveId)) {
        return false;
      }
      let removed = false;
      for (const [sessionId, id] of bySession.entries()) {
        if (id === archiveId) {
          bySession.delete(sessionId);
          removed = true;
        }
      }
      return removed;
    },

    /** 全登録を消去する（テスト用）。 */
    clear() {
      bySession.clear();
    },
  });
}

/**
 * 空でない文字列かどうかを判定する。
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 既定の進行中アーカイブストア。recordingService と roomLifecycleService が
 * 同一インスタンスを共有することで、開始経路に依らない停止を可能にする。
 */
export const activeArchiveStore = createActiveArchiveStore();

export default activeArchiveStore;
