/**
 * 到来予約選択（純粋関数） — Notification_Service ドメインロジック
 *
 * 設計: Notification_Service / Property 6
 * 要件: 3.1, 3.2
 *
 * 副作用を持たない純粋関数。入力配列は変更せず、条件に一致する
 * 予約のみを含む新しい配列を返す。
 */

/**
 * 予約時刻(reservationTime)を比較可能なミリ秒数へ正規化する。
 * Date / ISO 文字列 / エポック数値を受け付ける。
 *
 * @param {Date|string|number} value
 * @returns {number} エポックミリ秒。解釈不能な場合は NaN。
 */
function toEpochMillis(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return new Date(value).getTime();
  }
  return NaN;
}

/**
 * 到来済みかつ未通知の予約を厳密に抽出する。
 *
 * `reservationTime <= now` かつ `notified === false`（未設定は false 扱い）の
 * 予約と厳密に一致する集合を返す純粋関数。並び順は入力順を保持する。
 *
 * @param {import('./types.js').Reservation[]} reservations - 予約集合
 * @param {Date|string|number} now - 現在時刻
 * @returns {import('./types.js').Reservation[]} 条件に一致する予約の配列
 */
export function selectDueReservations(reservations, now) {
  if (!Array.isArray(reservations)) {
    return [];
  }

  const nowMillis = toEpochMillis(now);
  if (Number.isNaN(nowMillis)) {
    return [];
  }

  return reservations.filter((reservation) => {
    if (reservation == null) {
      return false;
    }

    // 未通知のみ対象。notified が未設定/false のときのみ通過。
    if (reservation.notified === true) {
      return false;
    }

    // 予約時刻が現在時刻以前（到来済み）のもののみ通過。
    const reservationMillis = toEpochMillis(reservation.reservationTime);
    if (Number.isNaN(reservationMillis)) {
      return false;
    }

    return reservationMillis <= nowMillis;
  });
}
