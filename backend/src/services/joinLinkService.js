/**
 * 入室リンクサービス（アプリケーション層）
 *
 * 役割:
 *  1. 予約時刻の通知に合わせて「一度だけ有効なパスワードレス入室リンク」を発行する。
 *  2. 受信者がリンクを開いた初回クリック時に、トークンを消費して入室を許可する。
 *
 * 設計上の要点:
 *  - トークン文字列は `crypto.randomBytes` による推測不能な乱数にする。
 *    URL 自体が入室資格情報（bearer secret）なので、短くて予測可能な値は使わない。
 *  - 消費は joinTokenStore.consume の atomic update に委譲する。これにより
 *    同時に 2 人がリンクを開いても、片方だけが成功する。
 *  - 判定規則は domain/joinLink.js に集約し、ここでは I/O と結果の整形だけを行う。
 *  - トークン ID はログやエラーメッセージに一切含めない（秘密情報）。
 *
 * 依存注入:
 *  - joinTokenStore  … トークンの永続化
 *  - tokenIdFactory  … トークン ID 生成関数
 *  - clock           … 現在時刻（テストでは固定値を注入）
 *  - publicOrigin    … リンクに使う公開オリジン（env.publicAppUrl）
 *
 * 重要: publicOrigin は CORS 用の env.clientOrigin ではなく
 * 「利用者が実際に開く公開 URL」（env.publicAppUrl）である必要がある。
 * clientOrigin は開発時に http://localhost:5173 を指すため、
 * これをリンクに使うと利用者のスマホからは到達できない。
 */

import { randomBytes } from 'node:crypto';

import { describePublicAppUrlProblem } from '../config/publicAppUrl.js';
import {
  JoinTokenErrorCode,
  buildJoinUrl,
  computeJoinLinkExpiry,
  evaluateJoinToken,
} from '../domain/joinLink.js';
import { joinTokenStore } from '../infra/joinTokenStore.js';

/** トークン ID のバイト数（16 バイト = 32 文字の 16 進数）。 */
export const JOIN_TOKEN_BYTES = 16;

/**
 * 既定のトークン ID 生成。推測不能な乱数を hex 文字列で返す。
 * @returns {string}
 */
function defaultTokenIdFactory() {
  return randomBytes(JOIN_TOKEN_BYTES).toString('hex');
}

/**
 * 入室リンクサービスを生成する。
 *
 * @param {object} deps
 * @param {{issue: Function, findByTokenId: Function, consume: Function}} deps.joinTokenStore トークンストア
 * @param {string|(() => string)} deps.getPublicOrigin リンクに用いる公開オリジンを返す関数（例: () => 'https://example.com'）
 *   文字列も受け付ける（後方互換）。関数の場合は呼び出しごとに評価されるため、
 *   環境変数の変更（Cloudflare Tunnel 再起動等）を即座に反映できる。
 * @param {() => string} [deps.tokenIdFactory] トークン ID 生成関数
 * @param {() => Date} [deps.clock] 現在時刻の取得関数
 * @returns {{
 *   issueForReservation: (input: {reservationId: string, sessionId: string, reservationTime: Date|string|number}) => Promise<{tokenId: string, url: string, expiresAt: Date}>,
 *   redeem: (tokenId: string) => Promise<{reservationId: string, sessionId: string}>,
 *   inspect: (tokenId: string) => Promise<{ok: true}|{ok: false, code: string}>,
 * }}
 */
export function createJoinLinkService({
  joinTokenStore,
  getPublicOrigin,
  tokenIdFactory = defaultTokenIdFactory,
  clock = () => new Date(),
}) {
  /**
   * 現在の公開オリジンを解決する（関数なら呼び出し、文字列ならそのまま返す）。
   * @returns {string}
   */
  function resolvePublicOrigin() {
    return typeof getPublicOrigin === 'function' ? getPublicOrigin() : getPublicOrigin;
  }
  /**
   * 予約に対して入室リンクを発行する。
   *
   * @param {{reservationId: string, sessionId: string, reservationTime: Date|string|number}} input
   * @returns {Promise<{tokenId: string, url: string, expiresAt: Date}>} 発行結果（url を WhatsApp 本文に埋め込む）
   * @throws {Error} 必須項目が欠落している場合
   */
  async function issueForReservation({ reservationId, sessionId, reservationTime }) {
    if (!reservationId) {
      throw new Error('入室リンクの発行には reservationId が必要です。');
    }
    if (!sessionId) {
      throw new Error('入室リンクの発行には sessionId が必要です。');
    }

    // 公開 URL を動的に解決（関数なら呼び出し、文字列ならそのまま）。
    const currentPublicOrigin = resolvePublicOrigin();

    // 公開 URL が未設定 / localhost のままでは WhatsApp 内のリンクが
    // 利用者の端末で開けない。黙って壊れたリンクを配信しないよう、
    // 発行前に明示的に失敗させる（トークンを消費する前に止める）。
    const publicUrlProblem = describePublicAppUrlProblem(currentPublicOrigin);
    if (publicUrlProblem) {
      throw new Error(`入室リンクを発行できません: ${publicUrlProblem}`);
    }

    const now = clock();
    const tokenId = tokenIdFactory();
    const expiresAt = computeJoinLinkExpiry(reservationTime, now);

    await joinTokenStore.issue({ tokenId, reservationId, sessionId, expiresAt });

    return { tokenId, url: buildJoinUrl(currentPublicOrigin, tokenId), expiresAt };
  }

  /**
   * リンクの現在の可否だけを調べる（消費はしない）。
   *
   * 入室ページの初回表示時に「無効なリンク」の旨を早期案内するために用いる。
   * 実際の入室許可は redeem が行う。
   *
   * @param {string} tokenId
   * @returns {Promise<{ok: true}|{ok: false, code: string}>}
   */
  async function inspect(tokenId) {
    const token = await joinTokenStore.findByTokenId(tokenId);
    return evaluateJoinToken(token, clock());
  }

  /**
   * 入室リンクを消費して入室を許可する。
   *
   * 手順:
   *  1. 事前チェックで拒否理由を求める（利用可能な表示のため）。
   *  2. atomic consume で実際に消費する。同時クリックで竞争的になった場合は
   *     store が null を返すが、その場合は他人が消費済みなので「使用済み」を返す。
   *  3. 消費できた場合は予約と室的信息を返す。
   *
   * @param {string} tokenId
   * @returns {Promise<{reservationId: string, sessionId: string}>} 入室に必要な情報
   * @throws {JoinLinkError} 無効なトークンの場合（code で理由を判別できる）
   */
  async function redeem(tokenId) {
    if (!tokenId) {
      throw new JoinLinkError(JoinTokenErrorCode.NOT_FOUND);
    }

    const now = clock();
    const token = await joinTokenStore.findByTokenId(tokenId);

    // 事前に理由を決める（NOT_FOUND / ALREADY_USED / EXPIRED / ROOM_CLOSED）。
    const verdict = evaluateJoinToken(token, now);
    if (!verdict.ok) {
      throw new JoinLinkError(verdict.code);
    }

    // atomic consume。null は「同時に他の誰かが消費した」ことを意味する。
    const consumed = await joinTokenStore.consume(tokenId, now);
    if (!consumed) {
      throw new JoinLinkError(JoinTokenErrorCode.ALREADY_USED);
    }

    return { reservationId: consumed.reservationId, sessionId: consumed.sessionId };
  }

  return Object.freeze({ issueForReservation, redeem, inspect });
}

/**
 * 入室リンクの拒否を表すエラー。ルート層が code から HTTP ステータスを決める。
 */
export class JoinLinkError extends Error {
  /**
   * @param {string} code JoinTokenErrorCode のいずれか
   */
  constructor(code) {
    super(`入室リンクを利用できません: ${code}`);
    this.name = 'JoinLinkError';
    this.code = code;
  }
}

/**
 * 拒否コードを HTTP ステータスとレスポンス body へ変換する（ルート層で使う）。
 *
 * - 404 … 存在しないトークン（列挙攻撃を避けるため 404 にする）
 * - 410 … 既に消費済み、または会議室の終了処理で無効化された（利用者は同じ扱い）
 *
 * @param {string} code
 * @returns {{status: number, error: string}}
 */
export function toJoinLinkErrorResponse(code) {
  switch (code) {
    case JoinTokenErrorCode.NOT_FOUND:
      return { status: 404, error: JoinTokenErrorCode.NOT_FOUND };
    case JoinTokenErrorCode.ALREADY_USED:
    case JoinTokenErrorCode.ROOM_CLOSED:
    case JoinTokenErrorCode.EXPIRED:
      // 3 つとも「これから入室できない」ため、利用者来说是同じ扱いでよい。
      // 400 ではなく 410（Gone）で「_PERMANENT な失効」を伝える。
      return { status: 410, error: code };
    default:
      return { status: 400, error: 'invalid_join_token' };
  }
}

/**
 * 実ストア・動的公開オリジンで構築した既定の入室リンクサービス。
 * import 時に副作用は発生しない（DB アクセスは初回利用時の遅延接続に任せる）。
 * getPublicOrigin は呼び出しごとに環境変数を読むため、Cloudflare Tunnel の
 * URL 変更（再起動等）をバックエンド再起動なしで即座に反映する。
 */
export const joinLinkService = createJoinLinkService({
  joinTokenStore,
  // 公開オリジン。呼び出しごとに環境変数 PUBLIC_APP_URL を読むため、
  // Cloudflare Tunnel の URL 変更を即座に反映する。
  // CORS 用の env.clientOrigin ではない点に注意（localhost を指すと到達不能）。
  getPublicOrigin: () => process.env.PUBLIC_APP_URL ?? '',
});

export default joinLinkService;
