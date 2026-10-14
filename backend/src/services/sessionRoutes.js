/**
 * Session ルーティング（Video トークン発行 / 要件 4.1・8.2）
 *
 * 2 種類のトークン発行エンドポイントを提供する Express Router。
 *
 * 1) `POST /sessions/:id/token`（認証必須 / 管理者・スタッフ）
 *    authorize ミドルウェアで保護し、Session_Service にトークン発行を委譲する。
 *    connection data には認証済みユーザー（req.user）とリクエストで指定された表示名を
 *    埋め込み、ストリーム↔ユーザーの対応付けを可能にする（要件 4.1・8.2）。
 *
 * 2) `POST /sessions/:id/guest-token`（認証不要 / モバイル等のエンドユーザー）
 *    ログインしていない利用者がビデオ通話へ参加できるようにする。authorize は
 *    付与せず、代わりに「該当セッションに対する有効（cancelled 以外）な予約が
 *    存在するか」を Reservation_Store で検証する予約バックド (reservation-backed)
 *    な発行とする。有効な予約がなければ 403 を返し、無制限のトークン発行を防ぐ。
 *
 * レスポンス:
 *  - 200: { token, sessionId, applicationId }
 *  - 400: sessionId 欠落（validation_error）
 *  - 401/403: authorize による拒否 / guest は有効な予約なし
 *  - 500: トークン発行失敗（token_error）
 *
 * @module services/sessionRoutes
 */

import { Router } from 'express';

import { sessionService as defaultSessionService } from './sessionService.js';
import { authorize as defaultAuthorize } from './authMiddleware.js';
import { reservationStore as defaultReservationStore } from '../infra/reservationStore.js';
import {
  JoinLinkError,
  createJoinLinkService,
  toJoinLinkErrorResponse,
  joinLinkService as defaultJoinLinkService,
} from './joinLinkService.js';
import { roomLifecycleService as defaultRoomLifecycleService } from './roomLifecycleService.js';
import { AuthAction, JoinTokenErrorCode, ReservationStatus } from '../domain/constants.js';

/**
 * セッション所有関係リゾルバ。
 *
 * スタッフは自身に割り当てられた予約に紐づくセッションのみ参加できる（要件 5.3）。
 * リクエスト（body/query）で渡された assignedStaffId を用いて所有関係を構築する。
 * 管理者はどのみち全許可（canAccess）のため、この推定精度は問わない。
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {{ userId: string, role: string }} user
 * @returns {{ userId: string, assignedStaffId: (string|undefined) }}
 */
function resolveSessionOwnership(req, _res, user) {
  const assignedStaffId = req?.body?.assignedStaffId ?? req?.query?.assignedStaffId ?? undefined;
  return { userId: user.userId, assignedStaffId };
}

/**
 * Session Router を生成する。テスト容易性のため依存を注入可能にする。
 *
 * @param {object} [deps]
 * @param {ReturnType<import('./sessionService.js').createSessionService>} [deps.sessionService]
 * @param {typeof defaultAuthorize} [deps.authorize] authorize ミドルウェアファクトリ
 * @param {typeof defaultReservationStore} [deps.reservationStore] 予約リポジトリ（guest 発行の予約検証用）
 * @returns {import('express').Router}
 */
export function createSessionRouter({
  sessionService = defaultSessionService,
  authorize = defaultAuthorize,
  reservationStore = defaultReservationStore,
  joinLinkService = defaultJoinLinkService,
  roomLifecycleService = defaultRoomLifecycleService,
} = {}) {
  const router = Router();

  /**
   * 会議室が既に無効化されているかを判定する。
   *
   * 在室記録（Session_Presence）を優先し、記録が無い場合は入室トークン側の
   * 無効化記録で補う。どちらの記録も無い場合は「未使用の室」とみなして
   * 入室を許す（予約が庭に存在するかが後段で保証する）。
   *
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async function isRoomClosed(sessionId) {
    return roomLifecycleService.isRoomClosed(sessionId);
  }

  // POST /sessions/:id/token: Video クライアントトークン発行（要件 4.1・8.2）
  router.post(
    '/:id/token',
    authorize(AuthAction.VIEW_RESERVATION, { resolveOwnership: resolveSessionOwnership }),
    async (req, res, next) => {
      try {
        const sessionId = req.params.id;
        const body = req.body ?? {};
        const result = await sessionService.issueToken(sessionId, {
          user: {
            userId: req.user?.userId,
            role: req.user?.role,
            displayName: body.displayName,
          },
          role: body.role,
          expireTime: body.expireTime,
          initialLayoutClassList: body.initialLayoutClassList,
        });

        if (result.ok) {
          return res.status(200).json({
            token: result.token,
            sessionId: result.sessionId,
            applicationId: result.applicationId,
          });
        }

        if (result.code === 'validation_error') {
          return res.status(400).json(result);
        }
        return res.status(500).json(result);
      } catch (err) {
        return next(err);
      }
    },
  );

  // POST /sessions/:id/guest-token: 認証不要のゲスト用トークン発行（要件 4.1）。
  // ログインしていないエンドユーザー（モバイル等）がビデオ通話へ参加できるようにする。
  // 無制限の発行を防ぐため、該当セッションに対する有効（cancelled 以外）な予約が
  // 存在する場合のみトークンを発行する（予約バックド）。
  router.post('/:id/guest-token', async (req, res, next) => {
    try {
      const sessionId = req.params.id;
      const body = req.body ?? {};

      // sessionId 欠落は検証エラー（400）。Express の :id 経由では通常空にならないが、
      // 明示的に検証してサービス層と挙動を揃える。
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        return res.status(400).json({
          ok: false,
          code: 'validation_error',
          message: 'sessionId が欠落しています。',
        });
      }

      // 会議室が既に無効化されている場合は入室を拒否する（全員退室後は再入室できない）。
      if (await isRoomClosed(sessionId)) {
        return res.status(410).json({
          error: JoinTokenErrorCode.ROOM_CLOSED,
          message: 'この会議室は終了しました。',
        });
      }

      // 該当セッションの予約を検索し、cancelled 以外の有効な予約があるか確認する。
      // Reservation_Store の失敗はそのまま伝播させる（要件 2.3）。
      const reservations = await reservationStore.findBySessionId(sessionId);
      const hasActiveReservation =
        Array.isArray(reservations) &&
        reservations.some((r) => r && r.status !== ReservationStatus.CANCELLED);

      if (!hasActiveReservation) {
        return res.status(403).json({
          error: 'forbidden',
          message: 'No active reservation for this session',
        });
      }

      // ゲスト publisher トークンを発行する。connection data に guest ロールと表示名を埋め込む。
      const result = await sessionService.issueToken(sessionId, {
        user: {
          role: 'guest',
          displayName: body.displayName || 'Guest',
        },
        role: 'publisher',
      });

      if (result.ok) {
        return res.status(200).json({
          token: result.token,
          sessionId: result.sessionId,
          applicationId: result.applicationId,
        });
      }

      if (result.code === 'validation_error') {
        return res.status(400).json(result);
      }
      return res.status(500).json(result);
    } catch (err) {
      return next(err);
    }
  });

  // POST /sessions/join/:tokenId: WhatsApp の入室リンクを消費して入室する（認証不要）。
  //
  // 流れ:
  //  1. 入室トークンを消費する（一度だけ有効。roomLifecycleService と同一の store を使う）
  //  2. その室が無効化済みなら拒否する
  //  3. ゲスト publisher トークンを発行して返す
  //
  // ここでは入室可能という事実だけを返し、実際の入室は frontend が行う。
  // .Link の再クリックは 410（already_used）で拒否される。
  router.post('/join/:tokenId', async (req, res, next) => {
    try {
      const tokenId = req.params.tokenId;

      // 1. トークンを消費する。拒否理由は 404 / 410 で伝える。
      let redeemed;
      try {
        redeemed = await joinLinkService.redeem(tokenId);
      } catch (err) {
        // トークン拒否は想定内なので、対応する status を返して終了する。
        // それ以外の例外は共通エラーハンドラへ委譲する。
        if (err instanceof JoinLinkError) {
          const { status, error } = toJoinLinkErrorResponse(err.code);
          return res.status(status).json({
            error,
            message: '入室リンクを利用できません。',
          });
        }
        throw err;
      }

      // 2. 室が無効化済みなら拒否する（消費は取り消さない: ワンタイム性を保つ）。
      if (await isRoomClosed(redeemed.sessionId)) {
        return res.status(410).json({
          error: JoinTokenErrorCode.ROOM_CLOSED,
          message: 'この会議室は終了しました。',
        });
      }

      // 3. ゲスト publisher トークンを発行する。
      const body = req.body ?? {};
      const result = await sessionService.issueToken(redeemed.sessionId, {
        user: {
          role: 'guest',
          displayName: body.displayName || 'Guest',
        },
        role: 'publisher',
      });

      if (!result.ok) {
        if (result.code === 'validation_error') {
          return res.status(400).json(result);
        }
        return res.status(500).json(result);
      }

      return res.status(200).json({
        token: result.token,
        sessionId: result.sessionId,
        reservationId: redeemed.reservationId,
        applicationId: result.applicationId,
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

/** 既定の Session Router（実 Session_Service 依存）。 */
export const sessionRouter = createSessionRouter();

export default sessionRouter;
