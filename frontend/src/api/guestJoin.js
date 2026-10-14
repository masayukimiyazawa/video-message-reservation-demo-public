/**
 * ゲスト入室（WhatsApp 入室リンク経由の参加）の記録
 *
 * 入室リンクを開いた利用者には、管理画面・ログインへの導線（ナビゲーション）を
 * 見せない。通話は画面いっぱい（フルスクリーン）で享受する。
 *
 * 判定材料は「WhatsApp の入室リンクから入ったか」だけ。管理者としてログインしている
 * 場合も、WhatsApp リンク経由で参加しているならゲストとして扱う。
 *
 * 保持先は sessionStorage（タブ単位・閉じたら消える）。JWT とは別物で、
 * 「どこから来たか」という UI 表示の都合でしかないため、サーバーは関知しない。
 *
 * @module api/guestJoin
 */

/** sessionStorage のキー。JoinPage が書き、CallPage / Layout が読む。 */
export const GUEST_JOIN_STORAGE_KEY = 'vvr.guestJoin';

/**
 * WhatsApp 入室リンク経由で参加したことを記録する。
 *
 * @param {object} [info]
 * @param {string} [info.reservationId]
 * @param {string} [info.sessionId]
 * @returns {void}
 */
export function markGuestJoin({ reservationId, sessionId } = {}) {
  try {
    sessionStorage.setItem(
      GUEST_JOIN_STORAGE_KEY,
      JSON.stringify({
        reservationId: reservationId ?? '',
        sessionId: sessionId ?? '',
      }),
    );
  } catch {
    /* sessionStorage 不可環境（プライベートモード等）では記録しない */
  }
}

/**
 * ゲスト入室として参加中かどうか。
 *
 * 通話終了（ハングアップ）時は false へ戻す。管理者ログインを同じタブで行っても
 * ナビゲーションが復活するようにするため。
 *
 * @returns {boolean}
 */
export function isGuestJoin() {
  try {
    return Boolean(sessionStorage.getItem(GUEST_JOIN_STORAGE_KEY));
  } catch {
    return false;
  }
}

/**
 * ゲスト入室の記録を消す（通話終了時など）。
 * @returns {void}
 */
export function clearGuestJoin() {
  try {
    sessionStorage.removeItem(GUEST_JOIN_STORAGE_KEY);
  } catch {
    /* 何もしない */
  }
}
