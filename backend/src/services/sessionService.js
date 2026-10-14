/**
 * Session_Service（Vonage Video トークン発行 / 要件 4.1・8.2）
 *
 * ビデオ通話セッションへ参加するためのクライアントトークンを発行するアプリケーション層。
 * 設計書 API 概要の `POST /sessions/:id/token`（Video トークン発行）に対応する。
 *
 * 配線する依存:
 *  - インフラ: Vonage Video クライアント（createSession / generateToken）
 *
 * connection data によるストリーム↔ユーザー対応付け（要件 4.1・8.2）:
 *  トークンの `data`（connection data）に参加ユーザーの識別情報（userId / role /
 *  displayName）を JSON 文字列として埋め込む。これにより、セッションモニタリング
 *  コールバックや Post-Call Transcription の channels_metadata（stream ID）と
 *  ユーザーを対応付けられる（設計「話者分離」前提）。
 *
 * 結果の表現:
 *  公開メソッドは例外を投げず、判別可能な結果オブジェクトを返す。
 *    成功: { ok: true, token, sessionId, applicationId }
 *    検証失敗: { ok: false, code: 'validation_error', message }
 *    発行失敗: { ok: false, code: 'token_error', message }
 */

import env from '../config/env.js';
import { videoClient as defaultVideoClient } from '../infra/videoClient.js';

/**
 * サービスが返す失敗コード。API 層はこれを HTTP ステータスへ対応付ける。
 * @readonly
 * @enum {string}
 */
export const SessionErrorCode = Object.freeze({
  VALIDATION_ERROR: 'validation_error',
  TOKEN_ERROR: 'token_error',
});

/**
 * connection data（stream↔ユーザー対応付け）を構築する（要件 4.1・8.2）。
 *
 * Vonage の connection data は文字列（最大 1KB 程度）である必要があるため、
 * ユーザー識別情報を JSON 文字列へ直列化する。空フィールドは除外する。
 *
 * @param {{ userId?: string, role?: string, displayName?: string }} [user]
 * @returns {string} JSON 文字列（未指定時は空オブジェクト JSON）
 */
export function buildConnectionData(user = {}) {
  const data = {};
  if (typeof user.userId === 'string' && user.userId.length > 0) {
    data.userId = user.userId;
  }
  if (typeof user.role === 'string' && user.role.length > 0) {
    data.role = user.role;
  }
  if (typeof user.displayName === 'string' && user.displayName.length > 0) {
    data.displayName = user.displayName;
  }
  return JSON.stringify(data);
}

/**
 * Session_Service を生成する。依存を注入可能にし、テスト容易性を確保する。
 *
 * @param {object} [deps]
 * @param {typeof defaultVideoClient} [deps.videoClient] Vonage Video クライアントラッパー
 * @param {string} [deps.applicationId] Vonage Video アプリケーション ID（トークン署名・監視API用、
 *   かつクライアント SDK の接続先識別子）
 * @param {{ error: Function }} [deps.logger] ロガー
 * @returns {{
 *   issueToken: (sessionId: string, params?: object) => Promise<object>,
 * }}
 */
export function createSessionService(deps = {}) {
  const videoClient = deps.videoClient ?? defaultVideoClient;
  const applicationId = deps.applicationId ?? env.vonage.videoApplicationId;
  const logger = deps.logger ?? console;

  /**
   * 指定セッションのクライアントトークンを発行する（要件 4.1・8.2）。
   *
   * @param {string} sessionId 対象セッション ID（`POST /sessions/:id/token` の :id）
   * @param {object} [params]
   * @param {{ userId?: string, role?: string, displayName?: string }} [params.user]
   *        connection data へ埋め込むユーザー情報（authorize が付与する req.user 等）
   * @param {string} [params.role] Vonage トークンのロール（publisher/subscriber/moderator）
   * @param {number} [params.expireTime] トークン有効期限（UNIX 秒）
   * @param {string[]} [params.initialLayoutClassList] 初期レイアウトクラス
   * @returns {Promise<object>} 結果オブジェクト
   */
  async function issueToken(sessionId, params = {}) {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return {
        ok: false,
        code: SessionErrorCode.VALIDATION_ERROR,
        message: 'sessionId が欠落しています。',
      };
    }

    const tokenOptions = {
      // connection data による stream↔ユーザー対応付け（要件 4.1・8.2）
      data: buildConnectionData(params.user),
    };
    if (typeof params.role === 'string' && params.role.length > 0) {
      tokenOptions.role = params.role;
    }
    if (typeof params.expireTime === 'number') {
      tokenOptions.expireTime = params.expireTime;
    }
    if (Array.isArray(params.initialLayoutClassList)) {
      tokenOptions.initialLayoutClassList = params.initialLayoutClassList;
    }

    try {
      const token = await videoClient.generateToken(sessionId, tokenOptions);
      return {
        ok: true,
        token,
        sessionId,
        applicationId,
      };
    } catch (err) {
      logger.error('[Session_Service] クライアントトークンの発行に失敗しました:', err);
      return {
        ok: false,
        code: SessionErrorCode.TOKEN_ERROR,
        message: err?.message ?? String(err),
      };
    }
  }

  return { issueToken };
}

/** 既定の依存で構成した Session_Service インスタンス。API 層はこれをそのまま利用できる。 */
export const sessionService = createSessionService();

export default sessionService;
