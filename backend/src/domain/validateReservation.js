/**
 * 予約バリデーション（純粋関数 / 要件 2.2・6.4 / Property 5）
 *
 * 予約レコードが永続化・処理に足る妥当性を持つかを検証する。
 * 副作用を持たない純粋関数として実装し、入力レコードを変更しない。
 *
 * 検証内容:
 *  - 必須フィールドの存在: 予約 ID (reservationId)・連絡先 (contact)・
 *    予約時刻 (reservationTime)・対象サービス (service)・状態 (status)・
 *    対応言語 (language)
 *  - 対応言語が {en, ja} のいずれかであること
 *
 * すべての必須フィールドが存在し language が正当なときのみ valid: true を返し、
 * いずれかが欠落または言語が不正な場合は valid: false と理由 (errors) を返す。
 */

import { SUPPORTED_LANGUAGES } from './constants.js';

/**
 * @typedef {import('./types.js').Reservation} Reservation
 * @typedef {import('./types.js').ValidationResult} ValidationResult
 */

/** 予約レコードで存在が必須のフィールド (要件 2.2) */
export const REQUIRED_RESERVATION_FIELDS = Object.freeze([
  'reservationId',
  'contact',
  'reservationTime',
  'service',
  'status',
  'language',
]);

/**
 * 値が「存在する」とみなせるか（必須フィールドの充足判定）。
 * null / undefined、および空文字・空白のみの文字列を欠落として扱う。
 * @param {*} value
 * @returns {boolean}
 */
function isPresent(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return true;
}

/**
 * 予約レコードを検証する。
 * @param {Reservation} record - 検証対象の予約レコード
 * @returns {ValidationResult} valid フラグと失敗理由（フィールド名等）
 */
export function validateReservation(record) {
  /** @type {string[]} */
  const errors = [];

  if (record === null || typeof record !== 'object') {
    return { valid: false, errors: ['record'] };
  }

  for (const field of REQUIRED_RESERVATION_FIELDS) {
    if (!isPresent(record[field])) {
      errors.push(field);
    }
  }

  // 言語は存在する場合のみ値域を検証する（欠落は上のループで検出済み）。
  if (isPresent(record.language) && !SUPPORTED_LANGUAGES.includes(record.language)) {
    errors.push('language:invalid');
  }

  return { valid: errors.length === 0, errors };
}
