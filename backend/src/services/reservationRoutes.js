/**
 * Reservation ルーティング（予約 CRUD / 要件 2.4・1.3・2.1）
 *
 * 予約の一覧取得・作成・更新/キャンセルを提供する Express Router。
 * authorize ミドルウェアで保護し（管理者/スタッフ、更新は所有）、Reservation_System
 * にビジネスロジックを委譲する。サービスの結果コードを HTTP ステータスへ対応付ける。
 *
 * エンドポイント（設計 API 概要）:
 *  - GET    /reservations      予約一覧取得（VIEW_RESERVATION）
 *  - POST   /reservations      予約作成（MANAGE_RESERVATION）
 *  - PATCH  /reservations/:id   予約更新/キャンセル（MANAGE_RESERVATION・所有）
 *  - DELETE /reservations/:id   予約削除（MANAGE_RESERVATION・所有）
 *
 * 結果コード → HTTP 対応:
 *  - validation_error → 400
 *  - slot_unavailable → 409
 *  - not_found        → 404
 *  - store_error      → 500
 *
 * @module services/reservationRoutes
 */

import { Router } from 'express';

import { reservationService as defaultReservationService, isActiveReservation } from './reservationService.js';
import { notificationService as defaultNotificationService } from './notificationService.js';
import { authorize as defaultAuthorize } from './authMiddleware.js';
import { AuthAction, ReservationStatus } from '../domain/constants.js';
import { buildTimeOptions, startOfJstDayUtc } from '../domain/conversation.js';
import { resolveBaseDate } from '../domain/conversation.js';
import { videoClient as defaultVideoClient } from '../infra/videoClient.js';

/** Reservation_System の結果コード → HTTP ステータスの対応表。 */
const ERROR_STATUS = Object.freeze({
  validation_error: 400,
  slot_unavailable: 409,
  not_found: 404,
  store_error: 500,
});

/**
 * サービスの失敗結果を適切な HTTP ステータスで返す。
 * 未知のコードは 500 にフォールバックする。
 * @param {import('express').Response} res
 * @param {{ code?: string }} result
 * @returns {import('express').Response}
 */
function sendFailure(res, result) {
  const status = ERROR_STATUS[result?.code] ?? 500;
  return res.status(status).json(result);
}

/**
 * Reservation Router を生成する。テスト容易性のため依存を注入可能にする。
 *
 * @param {object} [deps]
 * @param {ReturnType<import('./reservationService.js').createReservationService>} [deps.reservationService]
 * @param {ReturnType<import('./notificationService.js').createNotificationService>} [deps.notificationService]
 *   手動再通知（WhatsApp ジョインリンク再送）に使用する通知サービス
 * @param {typeof defaultAuthorize} [deps.authorize] authorize ミドルウェアファクトリ
 * @param {() => Date} [deps.now] 現在時刻の供給（テストで「今日」を固定する）
 * @param {typeof defaultVideoClient} [deps.videoClient] Vonage Video クライアント（テストでモック可能）
 * @returns {import('express').Router}
 */
export function createReservationRouter({
  reservationService = defaultReservationService,
  notificationService = defaultNotificationService,
  authorize = defaultAuthorize,
  now = () => new Date(),
  videoClient = defaultVideoClient,
} = {}) {
  const router = Router();

  // JST オフセット（ミリ秒）
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

  /**
   * 現在時刻を返す。
   * 基準時刻は UTC instant のまま扱う（タイムゾーン非依存）。
   * テストでは `now` を注入して「今日」の境界を固定する。
   */
  function getNowJst() {
    return now();
  }

  /**
   * 日付文字列 (YYYY-MM-DD) を、その JST 暦日の開始 instant へ変換する。
   *
   * dateStr は「JST 暦日」を表すため、UTC 0:00 から JST オフセットを引いて
   * JST 0:00 相当の instant を返す（例: '2026-10-01' → 2026-09-30T15:00:00Z）。
   * UTC 0:00 のままだと JST 9:00〜翌 JST 8:59 の予約が前後の日に
   * 振り分けてしまうため、境界は必ず JST 0:00 でそろえる。
   *
   * @param {string} dateStr
   * @returns {Date} JST 0:00 に相当する instant（不正値は NaN を持つ Date）
   */
  function parseJstDayStart(dateStr) {
    const [year, month, day] = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - JST_OFFSET_MS);
  }

  /**
   * その JST 暦日の終了 instant（JST 23:59:59.999）を返す。
   * @param {string} dateStr
   * @returns {Date}
   */
  function parseJstDayEnd(dateStr) {
    return new Date(parseJstDayStart(dateStr).getTime() + 24 * 60 * 60 * 1000 - 1);
  }

  /**
   * 単一予約を操作する（PATCH / DELETE）の所有関係リゾルバ。
   *
   * 対象予約を読み込み、その assignedStaffId を ownership として渡す（要件 5.3）。
   * これにより、スタッフは自身に割り当てられた予約のみ更新/削除できる。
   * 読み込みに失敗した場合は assignedStaffId 未解決（非所有）として扱い、
   * スタッフは canAccess により 403 となる（管理者は全許可）。
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {{ userId: string, role: string }} user
   * @returns {Promise<{ userId: string, assignedStaffId: (string|undefined) }>}
   */
  async function resolveReservationOwnership(req, res, user) {
    let assignedStaffId = req?.body?.assignedStaffId ?? undefined;
    // 対象予約を一覧から解決して所有関係を確定する（サービス経由）。
    try {
      const result = await reservationService.listReservations({});
      if (result.ok) {
        const target = result.reservations.find((r) => r.reservationId === req.params.id);
        if (target) {
          assignedStaffId = target.assignedStaffId;
          // 後続ハンドラが再利用できるよう保持する。
          res.locals.reservation = target;
        }
      }
    } catch (_err) {
      // 解決失敗時は非所有として扱う（スタッフは 403、管理者は全許可）。
    }
    return { userId: user.userId, assignedStaffId };
  }

  // GET /reservations: 予約一覧取得（要件 2.4）
  router.get('/', authorize(AuthAction.VIEW_RESERVATION), async (req, res, next) => {
    try {
      const result = await reservationService.listReservations(req.query ?? {});
      if (result.ok) {
        return res.status(200).json({ reservations: result.reservations });
      }
      return sendFailure(res, result);
    } catch (err) {
      return next(err);
    }
  });

  // POST /reservations: 予約作成（要件 1.3・2.1）
  router.post('/', authorize(AuthAction.MANAGE_RESERVATION), async (req, res, next) => {
    try {
      const result = await reservationService.createReservation(req.body ?? {});
      if (result.ok) {
        return res.status(201).json({ reservation: result.reservation });
      }
      return sendFailure(res, result);
    } catch (err) {
      return next(err);
    }
  });

  // PATCH /reservations/:id: 予約更新/キャンセル（要件 2.1）
  router.patch(
    '/:id',
    authorize(AuthAction.MANAGE_RESERVATION, { resolveOwnership: resolveReservationOwnership }),
    async (req, res, next) => {
      try {
        const patch = req.body ?? {};
        // status: 'cancelled' の場合はキャンセル操作として扱う。
        const result =
          patch.status === 'cancelled'
            ? await reservationService.cancelReservation(req.params.id)
            : await reservationService.updateReservation(req.params.id, patch);

        if (result.ok) {
          return res.status(200).json({ reservation: result.reservation });
        }
        return sendFailure(res, result);
      } catch (err) {
        return next(err);
      }
    },
  );

  // DELETE /reservations/:id: 予約削除（要件 2.1・5.3）
  // キャンセル（状態更新）とは異なり、レコード自体を削除する。
  router.delete(
    '/:id',
    authorize(AuthAction.MANAGE_RESERVATION, { resolveOwnership: resolveReservationOwnership }),
    async (req, res, next) => {
      try {
        const result = await reservationService.deleteReservation(req.params.id);
        if (result.ok) {
          return res.status(200).json({ reservation: result.reservation });
        }
        return sendFailure(res, result);
      } catch (err) {
        return next(err);
      }
    },
  );

  // GET /reservations/available-slots: 指定日の予約可能時間帯を取得
  // クエリパラメータ: date (ISO 日付文字列, 例: 2026-09-30)
  router.get(
    '/available-slots',
    authorize(AuthAction.VIEW_RESERVATION),
    async (req, res, next) => {
      try {
        const dateParam = req.query.date;
        if (!dateParam) {
          return res.status(400).json({ error: 'date query parameter is required (e.g., ?date=2026-09-30)' });
        }

        const nowJst = getNowJst();

        // dateParam は JST 暦日。JST 0:00 相当の instant へ変換する。
        const targetDayStart = parseJstDayStart(dateParam);
        if (isNaN(targetDayStart.getTime())) {
          return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        // JST 暦日ベースで「今日」を求める。ローカル時刻の getDate() を
        // 使うとサーバー TZ に依存し、15:00 JST 以降では「今日」が明日にずれる。
        const todayJst = startOfJstDayUtc(nowJst);
        const dayDiff = Math.round(
          (targetDayStart.getTime() - todayJst.getTime()) / (24 * 60 * 60 * 1000),
        );
        const dayIndex = dayDiff + 1;

        if (dayIndex < 1 || dayIndex > 3) {
          return res.status(400).json({ error: 'Date out of range. Only next 3 days are supported.' });
        }

        const selectedDate = `day_${dayIndex}`;
        // buildTimeOptions は JST 暦日ベースで時刻を返す（dayBasisOffsetMs で明示）。
        const timeOptions = buildTimeOptions(nowJst, selectedDate, {
          startOfToday: todayJst,
          dayBasisOffsetMs: JST_OFFSET_MS,
        });

        // 既存予約を取得して、既に予約されているスロットを除外
        //
        // キーは「JST 暦日 + 時刻」で持つ。multiDay フォールバック時は
        // 3日分のスロットが返るため、時刻だけで比較すると
        // 「別日の同じ時刻」が一律で消えてしまう（あるいは消えない）。
        const result = await reservationService.listReservations({});
        const bookedSlots = new Set();
        if (result.ok) {
          for (const r of result.reservations) {
            // キャンセル（削除）済み予約は枠を占有しないため、予約可能枠から
            // 除外しない（削除済みスロットが再予約できない問題の修正）。
            if (!isActiveReservation(r)) continue;
            const reservationTime = new Date(r.reservationTime);
            if (Number.isNaN(reservationTime.getTime())) continue;
            // UTC -> JST 変換して暦日と時刻を取得
            const jstTime = new Date(reservationTime.getTime() + JST_OFFSET_MS);
            const year = jstTime.getUTCFullYear();
            const month = String(jstTime.getUTCMonth() + 1).padStart(2, '0');
            const day = String(jstTime.getUTCDate()).padStart(2, '0');
            const hour = String(jstTime.getUTCHours()).padStart(2, '0');
            const minute = String(jstTime.getUTCMinutes()).padStart(2, '0');
            bookedSlots.add(`${year}-${month}-${day} ${hour}:${minute}`);
          }
        }

        // 予約済みスロットを除外
        // 判定は slot.date + slot.time で行う。slot.title は multiDay の場合
        // 'M/D HH:MM' と日付を含む表示専用文字列のため、比較には使えない。
        const availableSlots = timeOptions.filter(
          (slot) => !bookedSlots.has(`${slot.date} ${slot.time}`),
        );

        return res.status(200).json({ slots: availableSlots });
      } catch (err) {
        return next(err);
      }
    },
  );

  // GET /reservations/booked-slots: 指定日の予約済み枠を取得（管理者用・編集/削除用詳細込み）
  // クエリパラメータ: date (ISO 日付文字列, 例: 2026-09-30)
  router.get(
    '/booked-slots',
    authorize(AuthAction.VIEW_RESERVATION),
    async (req, res, next) => {
      try {
        const dateParam = req.query.date;
        if (!dateParam) {
          return res.status(400).json({ error: 'date query parameter is required (e.g., ?date=2026-09-30)' });
        }

        const targetDayStart = parseJstDayStart(dateParam);
        if (isNaN(targetDayStart.getTime())) {
          return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        // 既存予約を取得
        const result = await reservationService.listReservations({});
        const bookedSlots = [];
        if (result.ok) {
          const targetStart = targetDayStart;
          const targetEnd = parseJstDayEnd(dateParam);

          for (const r of result.reservations) {
            // キャンセル（削除）済み予約は枠を占有しないため「予約済み」として
            // 提示しない（削除済みなのに一覧に残る問題の修正）。
            if (!isActiveReservation(r)) continue;
            const reservationTime = new Date(r.reservationTime);
            if (reservationTime >= targetStart && reservationTime <= targetEnd) {
              // UTC -> JST 変換して時刻を取得
              const jstTime = new Date(reservationTime.getTime() + JST_OFFSET_MS);
              const hour = jstTime.getUTCHours().toString().padStart(2, '0');
              const minute = jstTime.getUTCMinutes().toString().padStart(2, '0');
              bookedSlots.push({
                reservationId: r.reservationId,
                time: `${hour}:${minute}`,
                contact: r.contact,
                service: r.service,
                status: r.status,
                language: r.language,
                assignedStaffId: r.assignedStaffId,
              });
            }
          }
        }

        // 時刻順でソート
        bookedSlots.sort((a, b) => a.time.localeCompare(b.time));

        return res.status(200).json({ slots: bookedSlots });
      } catch (err) {
        return next(err);
      }
    },
  );

  // GET /reservations/:id/session: 予約のセッション ID を取得（なければ作成）
  router.get(
    '/:id/session',
    authorize(AuthAction.VIEW_RESERVATION),
    async (req, res, next) => {
      try {
        const reservationId = req.params.id;

        // 予約を取得
        const result = await reservationService.listReservations({});
        if (!result.ok) {
          return sendFailure(res, result);
        }

        const reservation = result.reservations.find((r) => r.reservationId === reservationId);
        if (!reservation) {
          return res.status(404).json({ error: 'Reservation not found' });
        }

        // 既に sessionId があればそれを返す
        if (reservation.sessionId) {
          return res.status(200).json({ sessionId: reservation.sessionId });
        }

        // なければ Vonage Video セッションを作成
        let session;
        try {
          session = await videoClient.createSession();
        } catch (err) {
          return res.status(500).json({ error: 'Failed to create Vonage Video session' });
        }

        // 予約に sessionId を更新
        try {
          await reservationService.updateReservation(reservationId, { sessionId: session.sessionId });
        } catch (err) {
          // セッション作成は成功したが更新失敗の場合、セッションIDは返すが警告ログを出す
          console.warn('[Reservation_Routes] sessionId created but failed to update reservation:', err);
        }

        return res.status(200).json({ sessionId: session.sessionId });
      } catch (err) {
        return next(err);
      }
    },
  );

  // POST /reservations/:id/resend-notification: 管理者が手動で通知を再送する。
  //
  // 1 回限りの入室リンクを張り直すため、joinLinkService が新しいトークンを発行する。
  // 通知 serviçoは例外を握りつぶして { whatsappSent, joinUrl } を返すため、
  // 送信失敗は 502 として呼び出し側（管理画面）に伝える。
  router.post(
    '/:id/resend-notification',
    authorize(AuthAction.MANAGE_RESERVATION, { resolveOwnership: resolveReservationOwnership }),
    async (req, res, next) => {
      try {
        const reservationId = req.params.id;
        // resolveReservationOwnership が読み込んだ予約を再利用する（未読込時は取得する）。
        let reservation = res.locals.reservation;
        if (!reservation) {
          const list = await reservationService.listReservations({});
          if (!list.ok) {
            return sendFailure(res, list);
          }
          reservation = list.reservations.find((r) => r.reservationId === reservationId);
        }
        if (!reservation) {
          return res.status(404).json({ ok: false, code: 'not_found' });
        }
        // キャンセル済み予約は通知の再送対象としない。
        if (reservation.status === ReservationStatus.CANCELLED) {
          return res.status(409).json({
            ok: false,
            code: 'reservation_cancelled',
            message: 'キャンセル済みの予約には通知を再送できません。',
          });
        }

        const result = await notificationService.sendManualJoinLink(reservation);
        if (!result?.whatsappSent) {
          return res.status(502).json({
            ok: false,
            code: 'notification_failed',
            message: '通知の再送に失敗しました。',
          });
        }
        return res.status(200).json({ ok: true, joinUrl: result.joinUrl });
      } catch (err) {
        return next(err);
      }
    },
  );

  // GET /reservations/:id/archives: 特定予約の録画一覧取得
  router.get(
    '/:id/archives',
    authorize(AuthAction.VIEW_RECORDING),
    async (req, res, next) => {
      try {
        // まず予約を取得して sessionId を取得
        const reservationResult = await reservationService.listReservations({});
        if (!reservationResult.ok) {
          return sendFailure(res, reservationResult);
        }
        const reservation = reservationResult.reservations.find((r) => r.reservationId === req.params.id);
        if (!reservation) {
          return res.status(404).json({ error: 'Reservation not found' });
        }
        const targetSessionId = reservation.sessionId;

        // モックデータ対応の関数を使用（開発環境ではモックデータを返す）
        const archives = await videoClient.getArchivesBySessionIdWithMock(targetSessionId);
        // Vonage API の url フィールドを downloadUrl にマッピング（フロントエンド互換性のため）
        const mappedArchives = archives.map((a) => ({
          ...a,
          downloadUrl: a.url,
          archiveId: a.id || a.archiveId,
        }));
        return res.status(200).json({ archives: mappedArchives });
      } catch (err) {
        return next(err);
      }
    },
  );

  // GET /reservations/:id/transcriptions: 特定予約の文字起こし一覧取得
  router.get(
    '/:id/transcriptions',
    authorize(AuthAction.VIEW_TRANSCRIPTION),
    async (req, res, next) => {
      try {
        // まず予約を取得して sessionId を取得
        const reservationResult = await reservationService.listReservations({});
        if (!reservationResult.ok) {
          return sendFailure(res, reservationResult);
        }
        const reservation = reservationResult.reservations.find((r) => r.reservationId === req.params.id);
        if (!reservation) {
          return res.status(404).json({ error: 'Reservation not found' });
        }
        const targetSessionId = reservation.sessionId;

        const archives = await videoClient.getArchivesBySessionIdWithMock(targetSessionId);
        const transcriptionArchives = (archives || []).filter((a) => {
          const sessionId = a.sessionId || a.session_id || a.session;
          return sessionId === targetSessionId && (a.hasTranscription || a.transcription);
        });
        // Vonage API の transcription.url を downloadUrl にマッピング（フロントエンド互換性のため）
        // リスト取得では transcription.url が含まれないため、個別に getArchive で取得する
        const mappedTranscriptions = await Promise.all(
          transcriptionArchives.map(async (a) => {
            let downloadUrl = a.transcription?.url;
            let language = a.transcription?.primaryLanguageCode || a.language;
            // transcription.url がない場合は個別にアーカイブを取得して解決
            if (!downloadUrl && a.id) {
              try {
                const archiveResult = await videoClient.getArchive(a.id);
                if (archiveResult && archiveResult.transcription) {
                  downloadUrl = archiveResult.transcription.url;
                  language = archiveResult.transcription.primaryLanguageCode || language;
                }
              } catch {
                // 個別取得に失敗してもスキップ
              }
            }
            return {
              transcriptionId: a.id || a.archiveId,
              name: a.name,
              downloadUrl,
              language,
              createdAt: a.createdAt,
            };
          })
        );
        return res.status(200).json({ transcriptions: mappedTranscriptions });
      } catch (err) {
        return next(err);
      }
    },
  );

  return router;
}

/** 既定の Reservation Router（実 Reservation_System 依存）。 */
export const reservationRouter = createReservationRouter();

export default reservationRouter;
