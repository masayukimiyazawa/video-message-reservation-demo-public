/**
 * Reservation_System アプリケーションサービス (要件 1.3・2.1・2.3・2.4)
 *
 * 予約の作成・更新・キャンセル・一覧取得を担うアプリケーション層のサービス。
 * 設計書 Components の Reservation_System に対応し、以下を配線する。
 *
 *  - ドメイン: validateReservation(record)      … 必須フィールド/言語の検証 (要件 2.2・6.4)
 *  - ドメイン: checkAvailability(existing, slot) … 作成時の空き判定 (要件 1.5)
 *  - インフラ: Reservation_Store (save/findById/find/updateStatus) … 永続化 (要件 2.1・2.4)
 *
 * 結果の表現:
 *  すべての公開メソッドは例外を投げず、判別可能な「結果オブジェクト」を返す。
 *  API 層 (Chatbot / Admin API) はこの結果を見て HTTP 応答へ変換できる。
 *
 *    成功:        { ok: true, reservation }
 *    一覧成功:    { ok: true, reservations }
 *    バリデーション失敗: { ok: false, code: 'validation_error', errors }
 *    空き不可:    { ok: false, code: 'slot_unavailable', alternatives }
 *    未検出:      { ok: false, code: 'not_found' }
 *    書込/接続失敗: { ok: false, code: 'store_error', message }  (要件 2.3)
 *
 * エラー方針 (要件 2.3):
 *  Reservation_Store は接続/書込失敗時に例外を送出する。本サービスはそれを捕捉し、
 *  エラーを記録した上で構造化された失敗応答へ変換する。呼び出し元へは例外を伝播しない。
 *
 * @typedef {import('../domain/types.js').Reservation} Reservation
 * @typedef {import('../domain/types.js').ReservationDTO} ReservationDTO
 * @typedef {import('../domain/types.js').Slot} Slot
 */

import { randomUUID } from 'node:crypto';

import { checkAvailability } from '../domain/availability.js';
import { validateReservation } from '../domain/validateReservation.js';
import { ReservationStatus } from '../domain/constants.js';
import { reservationStore as defaultStore } from '../infra/reservationStore.js';
import { videoClient as defaultVideoClient } from '../infra/videoClient.js';

/**
 * サービスが返す失敗コード。API 層はこれを HTTP ステータスへ対応付ける。
 * @readonly
 * @enum {string}
 */
export const ReservationErrorCode = Object.freeze({
  VALIDATION_ERROR: 'validation_error',
  SLOT_UNAVAILABLE: 'slot_unavailable',
  NOT_FOUND: 'not_found',
  STORE_ERROR: 'store_error',
});

/** 予約枠の既定長（ミリ秒）。DTO が明示的な終了時刻を持たない場合に用いる。 */
const DEFAULT_SLOT_DURATION_MS = 30 * 60 * 1000;

/**
 * 予約が「枠を占有する有効状態」かどうかを判定する。
 *
 * キャンセル（削除）済み予約は枠を占有しない。空き判定・予約済み枠一覧・
 * 予約可能枠のいずれもこの規則で canceled 除外するため、単一の判定に集約している。
 * （以前はこの規則が空き判定にのみ適用され、参照系がキャンセル済み予約を
 *   「予約済み」として扱っていたため、削除した枠が表示され続け、
 *   かつ予約可能枠からも除外されていた。）
 *
 * @param {import('../domain/types.js').Reservation} reservation
 * @returns {boolean} 枠を占有するなら true
 */
export function isActiveReservation(reservation) {
  return reservation?.status !== ReservationStatus.CANCELLED;
}

/**
 * Reservation_System サービスを生成する。
 *
 * 依存（Reservation_Store・ロガー）を注入可能にし、テスト時に例外注入や
 * ログ確認を行いやすくする。既定では実際の Reservation_Store と console を用いる。
 *
 * @param {object} [deps]
 * @param {typeof defaultStore} [deps.store] Reservation_Store リポジトリ
 * @param {{ error: Function }} [deps.logger] エラー記録用ロガー
 * @returns {{
 *   createReservation: (dto: ReservationDTO & Partial<Reservation>) => Promise<object>,
 *   updateReservation: (id: string, patch: Partial<Reservation>) => Promise<object>,
 *   cancelReservation: (id: string) => Promise<object>,
 *   deleteReservation: (id: string) => Promise<object>,
 *   listReservations: (filter?: object) => Promise<object>,
 * }}
 */
export function createReservationService(deps = {}) {
  const store = deps.store ?? defaultStore;
  const logger = deps.logger ?? console;
  const videoClient = deps.videoClient ?? defaultVideoClient;

  /**
   * Reservation_Store 例外を構造化失敗応答へ変換する (要件 2.3)。
   * エラーを記録した上で { ok:false, code:'store_error', ... } を返す。
   * @param {string} operation 失敗した操作名（ログ用）
   * @param {Error} err 捕捉した例外
   * @returns {{ ok: false, code: string, message: string }}
   */
  function toStoreFailure(operation, err) {
    logger.error(`[Reservation_System] ${operation} が失敗しました:`, err);
    return {
      ok: false,
      code: ReservationErrorCode.STORE_ERROR,
      message: err?.message ?? String(err),
    };
  }

  /**
   * DTO/patch の予約時刻から空き判定用の希望枠 Slot を構築する。
   * end が与えられていなければ既定長を加算する。
   * @param {Date|string|number} reservationTime
   * @param {Date|string|number} [reservationEnd]
   * @returns {Slot}
   */
  function toRequestedSlot(reservationTime, reservationEnd) {
    const start = new Date(reservationTime);
    const end = reservationEnd
      ? new Date(reservationEnd)
      : new Date(start.getTime() + DEFAULT_SLOT_DURATION_MS);
    return { start, end };
  }

  /**
   * 予約レコード配列を空き判定用の既存枠 Slot[] に変換する。
   * キャンセル済みの予約は枠を占有しないため除外する。
   * @param {Reservation[]} reservations
   * @param {string} [excludeId] 判定対象自身（更新時）を除外する予約 ID
   * @returns {Slot[]}
   */
  function toExistingSlots(reservations, excludeId) {
    return reservations
      .filter(isActiveReservation)
      .filter((r) => !excludeId || r.reservationId !== excludeId)
      .map((r) =>
        toRequestedSlot(r.reservationTime, r.reservationEnd),
      );
  }

  /**
   * 予約を作成する (要件 1.3・2.1)。
   *
   * 手順:
   *  1. DTO から予約レコードを組み立てる（reservationId 未指定なら採番、状態は pending）。
   *  2. validateReservation で必須フィールド/言語を検証（不正なら拒否）。
   *  3. checkAvailability で空き判定。重複時は代替候補を添えて拒否 (要件 1.5)。
   *  4. Reservation_Store.save で永続化。失敗は捕捉して失敗応答へ変換 (要件 2.3)。
   *
   * @param {ReservationDTO & Partial<Reservation>} dto 予約登録要求
   * @returns {Promise<object>} 結果オブジェクト
   */
  async function createReservation(dto) {
    const record = buildRecordFromDto(dto);

    const validation = validateReservation(record);
    if (!validation.valid) {
      return {
        ok: false,
        code: ReservationErrorCode.VALIDATION_ERROR,
        errors: validation.errors,
      };
    }

    // 空き判定に必要な既存予約を取得する。取得失敗も store_error として扱う。
    let existing;
    try {
      existing = await store.find({});
    } catch (err) {
      return toStoreFailure('予約一覧の取得（空き判定用）', err);
    }

    const requestedSlot = toRequestedSlot(record.reservationTime, dto.reservationEnd);
    const availability = checkAvailability(toExistingSlots(existing), requestedSlot);
    if (!availability.available) {
      return {
        ok: false,
        code: ReservationErrorCode.SLOT_UNAVAILABLE,
        alternatives: availability.alternatives,
      };
    }

    // Vonage Video セッションを作成する
    let session;
    try {
      session = await videoClient.createSession();
    } catch (err) {
      logger.error('[Reservation_System] Vonage Video セッションの作成に失敗しました:', err);
      return {
        ok: false,
        code: ReservationErrorCode.STORE_ERROR,
        message: 'Vonage Video セッションの作成に失敗しました: ' + (err?.message ?? String(err)),
      };
    }

    // sessionId をレコードに追加
    record.sessionId = session.sessionId;

    try {
      const saved = await store.save(record);
      return { ok: true, reservation: saved };
    } catch (err) {
      return toStoreFailure('予約の保存', err);
    }
  }

  /**
   * 予約を更新する (要件 2.1)。
   *
   * 既存レコードへ patch をマージし、検証してから保存する。
   * 対象が存在しない場合は not_found を返す。
   *
   * @param {string} id 予約 ID
   * @param {Partial<Reservation>} patch 更新内容
   * @returns {Promise<object>} 結果オブジェクト
   */
  async function updateReservation(id, patch) {
    if (!id) {
      return { ok: false, code: ReservationErrorCode.VALIDATION_ERROR, errors: ['reservationId'] };
    }

    let current;
    try {
      current = await store.findById(id);
    } catch (err) {
      return toStoreFailure('予約の取得', err);
    }
    if (!current) {
      return { ok: false, code: ReservationErrorCode.NOT_FOUND };
    }

    // patch で reservationId を書き換えさせない（同一性を維持）。
    const merged = { ...current, ...patch, reservationId: current.reservationId };

    const validation = validateReservation(merged);
    if (!validation.valid) {
      return {
        ok: false,
        code: ReservationErrorCode.VALIDATION_ERROR,
        errors: validation.errors,
      };
    }

    try {
      const saved = await store.save(merged);
      return { ok: true, reservation: saved };
    } catch (err) {
      return toStoreFailure('予約の更新', err);
    }
  }

  /**
   * 予約をキャンセルする (要件 2.1)。
   *
   * 状態を cancelled に更新する。対象が存在しない場合は not_found を返す。
   *
   * @param {string} id 予約 ID
   * @returns {Promise<object>} 結果オブジェクト
   */
  async function cancelReservation(id) {
    if (!id) {
      return { ok: false, code: ReservationErrorCode.VALIDATION_ERROR, errors: ['reservationId'] };
    }

    try {
      const updated = await store.updateStatus(id, ReservationStatus.CANCELLED);
      if (!updated) {
        return { ok: false, code: ReservationErrorCode.NOT_FOUND };
      }
      return { ok: true, reservation: updated };
    } catch (err) {
      return toStoreFailure('予約のキャンセル', err);
    }
  }

  /**
   * 予約を削除する (要件 2.1)。
   *
   * レコード自体を永続化から削除する（cancelReservation と違い状態Canceled には残さない）。
   * 対象が存在しない場合は not_found、ストア障害は store_error を返す。
   *
   * @param {string} id 予約 ID
   * @returns {Promise<object>} 結果オブジェクト
   */
  async function deleteReservation(id) {
    if (!id) {
      return { ok: false, code: ReservationErrorCode.VALIDATION_ERROR, errors: ['reservationId'] };
    }

    try {
      const deleted = await store.deleteById(id);
      if (!deleted) {
        return { ok: false, code: ReservationErrorCode.NOT_FOUND };
      }
      return { ok: true, reservation: deleted };
    } catch (err) {
      return toStoreFailure('予約の削除', err);
    }
  }

  /**
   * 予約一覧を取得する (要件 2.4)。Admin_UI 用。
   *
   * @param {object} [filter] Reservation_Store のクエリフィルタ（省略時は全件）
   * @returns {Promise<object>} 結果オブジェクト
   */
  async function listReservations(filter = {}) {
    try {
      const reservations = await store.find(filter);
      return { ok: true, reservations };
    } catch (err) {
      return toStoreFailure('予約一覧の取得', err);
    }
  }

  return {
    createReservation,
    updateReservation,
    cancelReservation,
    deleteReservation,
    listReservations,
  };
}

/**
 * 予約 DTO から永続化用の予約レコードを組み立てる。
 * reservationId が未指定なら UUID を採番し、status が未指定なら pending を既定とする。
 * @param {ReservationDTO & Partial<Reservation>} dto
 * @returns {Reservation}
 */
function buildRecordFromDto(dto) {
  const source = dto ?? {};
  const { reservationEnd, ...rest } = source;
  return {
    ...rest,
    reservationId: source.reservationId ?? randomUUID(),
    status: source.status ?? ReservationStatus.PENDING,
    notified: source.notified ?? false,
  };
}

/**
 * 既定の依存（実 Reservation_Store・console）で構成した Reservation_System サービス。
 * API 層はこのインスタンスをそのまま利用できる。
 */
export const reservationService = createReservationService();

export default reservationService;
