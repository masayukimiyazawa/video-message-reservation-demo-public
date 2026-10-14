/**
 * パスワードレス入室リンクの純粋ロジック
 *
 * エンドユーザーは WhatsApp で受け取ったリンクをクリックするだけで通話へ入室できる。
 * リンクは「一度だけ有効」であり、消費された後は再クリックしても入室できない。
 *
 * このモジュールは I/O を含まない。URL の組み立てと有効期限の計算のみを担う。
 * トークンの発行・消費は infra（joinTokenStore）と services（joinLinkService）が行う。
 */

import { JoinTokenErrorCode } from './constants.js';

/** フロントの入室ページのパス（App.jsx のルートと一致させること）。 */
export const JOIN_PATH_PREFIX = '/join/';

/** 予約時刻が過ぎてもリンクを許可する猶予時間（文字起こし生成待ちを含む）。 */
export const JOIN_LINK_GRACE_MS = 3 * 60 * 60 * 1000; // 3 時間

/**
 * 入室リンクが有効であり続ける最小時間。
 * 通知直後に発行されるため、予約時刻が近い/ past でも最低この長さは残す。
 */
export const JOIN_LINK_MIN_VALID_MS = 30 * 60 * 1000; // 30 分

/**
 * トークン ID から入室 URL を組み立てる。
 *
 * @param {string} tokenId 消費可能なランダムトークン ID
 * @param {string} origin フロントのオリジン（例: https://example.trycloudflare.com）
 * @returns {string} クリック可能な入室 URL
 */
export function buildJoinUrl(origin, tokenId) {
  const base = String(origin ?? '').replace(/\/+$/, '');
  return `${base}${JOIN_PATH_PREFIX}${tokenId}`;
}

/**
 * 入室リンクの有効期限を計算する。
 *
 * 予約時刻 + 猶予時間を上限とし、予約時刻がすでに 過ぎている場合は
 * 「現在時刻 + 最小有効時間」を下限として返す。これにより、
 * 通知が予定時刻より遅れて送られてもリンクが即死にならない。
 *
 * @param {Date|string|number} reservationTime 予約時刻
 * @param {Date|string|number} now 現在時刻
 * @returns {Date} 有効期限
 */
export function computeJoinLinkExpiry(reservationTime, now) {
  const nowDate = toDate(now);
  const base = toDate(reservationTime);

  // 予約時刻が無効な場合は現在時刻基準で決める。
  const target = Number.isNaN(base.getTime()) ? nowDate : base;

  const graceEnd = new Date(target.getTime() + JOIN_LINK_GRACE_MS);
  const minimumEnd = new Date(nowDate.getTime() + JOIN_LINK_MIN_VALID_MS);

  return graceEnd > minimumEnd ? graceEnd : minimumEnd;
}

/**
 * トークン記録が現在時刻時点で入室を許可するかを判定する（純粋）。
 *
 * @param {{ consumedAt?: Date|null, invalidatedAt?: Date|null, expiresAt?: Date }} token
 * @param {Date|string|number} now 現在時刻
 * @returns {boolean}
 */
export function isJoinTokenUsable(token, now) {
  if (!token) {
    return false;
  }
  // 消費済み・無効化済みは不可。
  if (token.consumedAt != null || token.invalidatedAt != null) {
    return false;
  }
  const expiresAt = toDate(token.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    return false;
  }
  return expiresAt.getTime() > toDate(now).getTime();
}

/**
 * 入室リンクの拒否理由を表すコード。
 * 定義の正本は constants.js の JoinTokenErrorCode で、ここでは再輸出する。
 * HTTP ステータス（404 / 410）への変換はルート層が行う。
 */
export { JoinTokenErrorCode };

/**
 * 入室トークン記録と現在時刻から、拒否理由を求める（純粋）。
 *
 * @param {object|null} token JoinToken ドキュメント
 * @param {Date|string|number} now 現在時刻
 * @returns {{ok: true}|{ok: false, code: string}} 許可か拒否理由
 */
export function evaluateJoinToken(token, now) {
  if (!token) {
    return { ok: false, code: JoinTokenErrorCode.NOT_FOUND };
  }
  if (token.consumedAt != null) {
    return { ok: false, code: JoinTokenErrorCode.ALREADY_USED };
  }
  if (token.invalidatedAt != null) {
    return { ok: false, code: JoinTokenErrorCode.ROOM_CLOSED };
  }
  const expiresAt = toDate(token.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= toDate(now).getTime()) {
    return { ok: false, code: JoinTokenErrorCode.EXPIRED };
  }
  return { ok: true };
}

/**
 * 日付など各種の入力（Date / 文字列 / 数値）を Date に正規化する。
 * @param {Date|string|number} value
 * @returns {Date} 変換不能なら Invalid Date
 */
function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}
