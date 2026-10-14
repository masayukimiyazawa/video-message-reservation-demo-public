/**
 * 予約 DTO 構築 (要件 1.2 / 1.3 / Property 2)
 *
 * Chatbot_Service の完了した会話状態 (ConversationState, step === COMPLETED) から、
 * Reservation_System への登録要求用の予約 DTO を構築する純粋関数。
 * 副作用を持たず、入力を変更しない。
 *
 * 生成される DTO は連絡先・予約時刻・対象サービス・対応言語のすべてを含む
 * (design: ReservationDTO / Property 2)。
 */

import { ConversationStep, SUPPORTED_LANGUAGES } from './constants.js';

/**
 * 完了した会話状態から予約 DTO を構築する。
 *
 * @param {import('./types.js').ConversationState} completedState
 *   予約完了状態の会話 (step === 'completed'、contact / service /
 *   reservationTime / language を保持)。
 * @returns {import('./types.js').ReservationDTO}
 *   連絡先・予約時刻・対象サービス・対応言語を含む予約 DTO。
 * @throws {Error} 会話が未完了、または必須フィールドが欠落/不正な場合。
 */
export function buildReservationDTO(completedState) {
  if (completedState == null || typeof completedState !== 'object') {
    throw new Error('buildReservationDTO: completedState は会話状態オブジェクトである必要があります');
  }

  const { step, contact, reservationTime, service, language } = completedState;

  if (step !== ConversationStep.COMPLETED) {
    throw new Error(
      `buildReservationDTO: 会話が未完了です (step=${String(step)}、期待値=${ConversationStep.COMPLETED})`,
    );
  }

  if (!isNonEmptyString(contact)) {
    throw new Error('buildReservationDTO: contact (連絡先) が欠落しています (要件 1.2)');
  }

  if (!isValidReservationTime(reservationTime)) {
    throw new Error('buildReservationDTO: reservationTime (予約時刻) が欠落または不正です (要件 1.2)');
  }

  if (!isNonEmptyString(service)) {
    throw new Error('buildReservationDTO: service (対象サービス) が欠落しています (要件 1.2)');
  }

  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new Error(
      `buildReservationDTO: language は ${SUPPORTED_LANGUAGES.join('/')} のいずれかである必要があります (要件 6.4)`,
    );
  }

  // 入力を変更せず、DTO に必要な 4 フィールドのみを抽出して返す。
  return {
    contact,
    reservationTime,
    service,
    language,
  };
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
 * 予約時刻として有効か (Date または解析可能な日時文字列) を判定する。
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidReservationTime(value) {
  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return !Number.isNaN(new Date(value).getTime());
  }
  return false;
}
