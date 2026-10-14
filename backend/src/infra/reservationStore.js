/**
 * Reservation_Store リポジトリ (インフラ層 / 要件 2.1・2.3・2.4)
 *
 * MongoDB Atlas 上の予約データ永続化層。設計書 Components の Reservation_Store に対応し、
 * Mongoose の ReservationModel を用いた Repository として実装する。
 *
 * 公開 API:
 *  - save(record)          予約レコードの新規作成 / 更新（upsert）
 *  - findById(id)          予約 ID による単一取得
 *  - find(filter)          フィルタ条件による一覧取得（Admin_UI 用 / 要件 2.4）
 *  - updateStatus(id, status) 予約状態の更新
 *  - deleteById(id)        予約 ID による削除
 *
 * エラー方針 (要件 2.3):
 *  - 接続・書込・読込の失敗はいずれも例外として送出し、握りつぶさない。
 *    呼び出し元（Reservation_System）がエラーを記録し、失敗応答へ変換する。
 *  - 副作用（DB 接続）は mongoConnection.js の connectToDatabase に集約し、
 *    各操作の前に接続を保証する。接続失敗はそのまま伝播する。
 */

import { RESERVATION_STATUSES } from '../domain/constants.js';
import { connectToDatabase } from './mongoConnection.js';
import { ReservationModel } from './reservationModel.js';

/**
 * DB 接続を保証する。未接続なら接続を試み、失敗時は例外を送出する。
 * @returns {Promise<void>}
 */
async function ensureConnected() {
  await connectToDatabase();
}

/**
 * 予約レコードを保存する（新規作成または更新）。
 *
 * `reservationId` を一意キーとした upsert を行う。同一 ID が存在すれば更新し、
 * 存在しなければ新規作成する（要件 2.1）。
 *
 * @param {object} record 保存する予約レコード（reservationId を含む）
 * @returns {Promise<object>} 保存後のプレーンオブジェクト表現
 * @throws {Error} reservationId 欠落・接続失敗・書込失敗時
 */
export async function save(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('save には予約レコードオブジェクトが必要です。');
  }
  if (!record.reservationId) {
    throw new Error('予約レコードには reservationId が必要です。');
  }

  await ensureConnected();

  try {
    const saved = await ReservationModel.findOneAndUpdate(
      { reservationId: record.reservationId },
      { $set: record },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
    return saved;
  } catch (err) {
    // 書込失敗を呼び出し元へ伝播（要件 2.3）。
    throw new Error(`予約レコードの保存に失敗しました: ${err.message}`, { cause: err });
  }
}

/**
 * 予約 ID で単一の予約レコードを取得する。
 *
 * @param {string} id 予約 ID（reservationId）
 * @returns {Promise<object|null>} 見つかったレコード、なければ null
 * @throws {Error} id 欠落・接続失敗・読込失敗時
 */
export async function findById(id) {
  if (!id) {
    throw new Error('findById には予約 ID が必要です。');
  }

  await ensureConnected();

  try {
    return await ReservationModel.findOne({ reservationId: id }).lean();
  } catch (err) {
    throw new Error(`予約レコードの取得に失敗しました: ${err.message}`, { cause: err });
  }
}

/**
 * フィルタ条件に一致する予約レコードの一覧を取得する（要件 2.4）。
 *
 * @param {object} [filter] Mongoose クエリフィルタ（省略時は全件）
 * @returns {Promise<object[]>} 一致したレコード配列（プレーンオブジェクト）
 * @throws {Error} 接続失敗・読込失敗時
 */
export async function find(filter = {}) {
  await ensureConnected();

  try {
    return await ReservationModel.find(filter).lean();
  } catch (err) {
    throw new Error(`予約レコード一覧の取得に失敗しました: ${err.message}`, { cause: err });
  }
}

/**
 * 指定セッション ID に紐づく予約レコードの一覧を取得する。
 *
 * ビデオ通話への参加可否判定（Session トークン発行）で用いる。sessionId は
 * 予約に紐づけられたビデオセッション ID であり、複数レコードが該当し得るため
 * 配列で返す（`find` と同じエラー方針で失敗を伝播する / 要件 2.3）。
 *
 * @param {string} sessionId 対象セッション ID
 * @returns {Promise<object[]>} 一致したレコード配列（プレーンオブジェクト）
 * @throws {Error} sessionId 欠落・接続失敗・読込失敗時
 */
export async function findBySessionId(sessionId) {
  if (!sessionId) {
    throw new Error('findBySessionId にはセッション ID が必要です。');
  }

  await ensureConnected();

  try {
    return await ReservationModel.find({ sessionId }).lean();
  } catch (err) {
    throw new Error(
      `セッション ID による予約レコードの取得に失敗しました: ${err.message}`,
      { cause: err },
    );
  }
}

/**
 * 予約状態を更新する。
 *
 * @param {string} id 予約 ID（reservationId）
 * @param {string} status 新しい予約状態（pending/confirmed/cancelled/completed）
 * @returns {Promise<object|null>} 更新後のレコード、対象が無ければ null
 * @throws {Error} id 欠落・不正な状態値・接続失敗・書込失敗時
 */
export async function updateStatus(id, status) {
  if (!id) {
    throw new Error('updateStatus には予約 ID が必要です。');
  }
  if (!RESERVATION_STATUSES.includes(status)) {
    throw new Error(
      `不正な予約状態です: ${status}. 有効な値: ${RESERVATION_STATUSES.join(', ')}`,
    );
  }

  await ensureConnected();

  try {
    return await ReservationModel.findOneAndUpdate(
      { reservationId: id },
      { $set: { status } },
      { new: true, runValidators: true },
    ).lean();
  } catch (err) {
    throw new Error(`予約状態の更新に失敗しました: ${err.message}`, { cause: err });
  }
}

/**
 * 予約 ID を指定して予約レコードを削除する。
 *
 * 対象が存在しない場合は null を返す（呼び出し元が not_found へ変換する）。
 * 接続・削除の失敗は他操作と同じく例外として送出する（要件 2.3）。
 *
 * @param {string} id 予約 ID（reservationId）
 * @returns {Promise<object|null>} 削除したレコード、対象が無ければ null
 * @throws {Error} id 欠落・接続失敗・削除失敗時
 */
export async function deleteById(id) {
  if (!id) {
    throw new Error('deleteById には予約 ID が必要です。');
  }

  await ensureConnected();

  try {
    return await ReservationModel.findOneAndDelete({ reservationId: id }).lean();
  } catch (err) {
    throw new Error(`予約レコードの削除に失敗しました: ${err.message}`, { cause: err });
  }
}

/**
 * 予約の通知済みフラグ（notified）を true に更新する（要件 3.2）。
 *
 * Notification_Service が予約時刻到来の通知送出後に呼び出し、同一予約が
 * 二重に通知されないようにする。`updateStatus` が status のみを更新するのに対し、
 * 本ヘルパは notified フラグのみを更新する最小限の操作を提供する。
 *
 * @param {string} id 予約 ID（reservationId）
 * @returns {Promise<object|null>} 更新後のレコード、対象が無ければ null
 * @throws {Error} id 欠落・接続失敗・書込失敗時（要件 2.3 と同様に伝播）
 */
export async function markNotified(id) {
  if (!id) {
    throw new Error('markNotified には予約 ID が必要です。');
  }

  await ensureConnected();

  try {
    return await ReservationModel.findOneAndUpdate(
      { reservationId: id },
      { $set: { notified: true } },
      { new: true, runValidators: true },
    ).lean();
  } catch (err) {
    throw new Error(`予約の通知済みフラグ更新に失敗しました: ${err.message}`, { cause: err });
  }
}

/**
 * 予約のリマインダー通知済みフラグ（reminderSent）を true に更新する（要件 3.1）。
 *
 * Notification_Service がリマインダー通知送出後に呼び出し、同一予約が
 * 二重にリマインダー通知されないようにする。
 *
 * @param {string} id 予約 ID（reservationId）
 * @returns {Promise<object|null>} 更新後のレコード、対象が無ければ null
 * @throws {Error} id 欠落・接続失敗・書込失敗時
 */
export async function markReminderSent(id) {
  if (!id) {
    throw new Error('markReminderSent には予約 ID が必要です。');
  }

  await ensureConnected();

  try {
    return await ReservationModel.findOneAndUpdate(
      { reservationId: id },
      { $set: { reminderSent: true } },
      { new: true, runValidators: true },
    ).lean();
  } catch (err) {
    throw new Error(`予約のリマインダー通知済みフラグ更新に失敗しました: ${err.message}`, { cause: err });
  }
}

/**
 * 予約の10分前リマインダー通知済みフラグ（tenMinReminderSent）を true に更新する。
 *
 * `reminderSent` とは独立したフラグを使う。24時間前リマインダーと同じフラグを
 * 共有すると、24時間前リマインダーが送信済みの予約が10分前リマインダーの
 * 対象から永久に除外され、開催10分前の通知が一切送られなくなる。
 *
 * @param {string} id 予約 ID（reservationId）
 * @returns {Promise<object|null>} 更新後のレコード、対象が無ければ null
 * @throws {Error} id 欠落・接続失敗・書込失敗時
 */
export async function markTenMinReminderSent(id) {
  if (!id) {
    throw new Error('markTenMinReminderSent には予約 ID が必要です。');
  }

  await ensureConnected();

  try {
    return await ReservationModel.findOneAndUpdate(
      { reservationId: id },
      { $set: { tenMinReminderSent: true } },
      { new: true, runValidators: true },
    ).lean();
  } catch (err) {
    throw new Error(
      `予約の10分前リマインダー通知済みフラグ更新に失敗しました: ${err.message}`,
      { cause: err },
    );
  }
}

/**
 * Reservation_Store リポジトリ（オブジェクト形式のエクスポート）。
 * アプリケーション層で依存注入しやすいようまとめて公開する。
 */
export const reservationStore = Object.freeze({
  save,
  findById,
  find,
  findBySessionId,
  updateStatus,
  deleteById,
  markNotified,
  markReminderSent,
  markTenMinReminderSent,
});

export default reservationStore;
