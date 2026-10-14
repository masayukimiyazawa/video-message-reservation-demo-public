/**
 * リマインダー対象予約選択（純粋関数） — Notification_Service ドメインロジック
 *
 * 設計: Notification_Service / リマインダー通知
 * 要件: 3.1 (リマインダー通知)
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
 * リマインダー送信対象の予約を厳密に抽出する。
 *
 * 条件:
 *  - 予約時刻が将来である (`reservationTime > now`)
 *  - 予約時刻までの残り時間がリマインダーウィンドウ内である (`reservationTime - now <= windowMs`)
 *  - リマインダー未送信である (`reminderSent !== true`)
 *  - 予約状態が確定済みである (`status === 'confirmed'`)
 *
 * @param {import('./types.js').Reservation[]} reservations - 予約集合
 * @param {Date|string|number} now - 現在時刻
 * @param {number} [windowMs=24*60*60*1000] - リマインダーウィンドウ（ミリ秒）。既定は 24 時間前
 * @param {string} [sentField='reminderSent'] - 送信済みフラグのフィールド名。
 *   24時間前リマインダーと10分前リマインダーは独立したフラグで判定する。
 * @returns {import('./types.js').Reservation[]} 条件に一致する予約の配列
 */
export function selectReminderReservations(
  reservations,
  now,
  windowMs = 24 * 60 * 60 * 1000,
  sentField = 'reminderSent',
) {
  if (!Array.isArray(reservations)) {
    return [];
  }

  const nowMillis = toEpochMillis(now);
  if (Number.isNaN(nowMillis)) {
    return [];
  }

  const windowMillis = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 24 * 60 * 60 * 1000;

  return reservations.filter((reservation) => {
    if (reservation == null) {
      return false;
    }

    // 送信済みフラグが立っていれば除外（フィールドは呼び出し側で切替可能）
    if (reservation[sentField] === true) {
      return false;
    }

    // 確定済み予約のみ対象
    if (reservation.status !== 'confirmed') {
      return false;
    }

    // 予約時刻をミリ秒に変換
    const reservationMillis = toEpochMillis(reservation.reservationTime);
    if (Number.isNaN(reservationMillis)) {
      return false;
    }

    // 予約時刻が過去（到来済み）なら除外（到来通知の対象になるため）
    if (reservationMillis <= nowMillis) {
      return false;
    }

    // リマインダーウィンドウ内か判定（予約時刻 - 現在時刻 <= ウィンドウ）
    const timeUntilReservation = reservationMillis - nowMillis;
    return timeUntilReservation <= windowMillis;
  });
}