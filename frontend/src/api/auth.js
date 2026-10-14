/**
 * 認証・ロールユーティリティ（タスク 17.1 / 要件 5.1・5.2・5.3）。
 *
 * JWT からロール（administrator / staff）と userId をデコードし、
 * ロール別のメニュー可視性と認可ヘルパーを提供する。
 * 署名検証はサーバー側で行う。ここではペイロード（表示制御用）のみを読む。
 */
import { getAuthToken, clearAuthToken } from './client.js';

/** 既知のロール値（バックエンド domain/constants.ROLES と対応）。 */
export const ROLES = Object.freeze({
  ADMINISTRATOR: 'administrator',
  STAFF: 'staff',
});

/**
 * URL-safe Base64（JWT のペイロード部）をデコードする。
 * @param {string} segment
 * @returns {string}
 */
function base64UrlDecode(segment) {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  if (typeof atob === 'function') {
    // ブラウザ環境。UTF-8 を正しく復元する。
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  // 非ブラウザ環境（テスト等）。
  return Buffer.from(padded, 'base64').toString('utf-8');
}

/**
 * JWT を検証せずにペイロードを取り出す（表示制御用）。
 * @param {string|null} token
 * @returns {{ userId?: string, role?: string, exp?: number, iat?: number }|null}
 */
export function decodeToken(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
}

/**
 * トークンの有効期限が切れているか判定する。
 * exp を持たないトークンは失効しないものとして扱う。
 * @param {{ exp?: number }|null} payload
 * @returns {boolean}
 */
export function isTokenExpired(payload) {
  if (!payload || typeof payload.exp !== 'number') {
    return false;
  }
  // exp は秒単位（JWT 標準）。
  return payload.exp * 1000 <= Date.now();
}

/**
 * 現在のユーザー情報（表示制御用）を取得する。
 * 未ログイン・失効トークン時は null。
 * @returns {{ userId: string, role: string }|null}
 */
export function getCurrentUser() {
  const payload = decodeToken(getAuthToken());
  if (!payload || !payload.role) {
    return null;
  }
  if (isTokenExpired(payload)) {
    // 失効済みトークンは破棄する。
    clearAuthToken();
    return null;
  }
  return { userId: payload.userId, role: payload.role };
}

/**
 * 認証済み（有効なトークンを保持）かどうか。
 * @returns {boolean}
 */
export function isAuthenticated() {
  return getCurrentUser() != null;
}

/**
 * 管理者ロールかどうか。
 * @param {{ role?: string }|null} user
 * @returns {boolean}
 */
export function isAdministrator(user) {
  return user?.role === ROLES.ADMINISTRATOR;
}

/**
 * スタッフロールかどうか。
 * @param {{ role?: string }|null} user
 * @returns {boolean}
 */
export function isStaff(user) {
  return user?.role === ROLES.STAFF;
}

/**
 * 管理メニュー項目キー。
 * @readonly
 */
export const MENU_ITEMS = Object.freeze({
  RESERVATIONS: 'reservations',
  NOTIFICATIONS: 'notifications',
  RECORDING: 'recording',
  TRANSCRIPTION: 'transcription',
  PERMISSIONS: 'permissions',
  TEST_LINKS: 'testLinks',
});

/**
 * ロールに応じて表示可能なメニュー項目を返す（要件 5.2・5.3）。
 * - 管理者: すべての管理/録画/文字起こし/権限管理操作。
 * - スタッフ: 自身に割り当てられた予約に対する操作のみ（権限管理は不可）。
 * @param {string|undefined} role
 * @returns {string[]}
 */
export function menuItemsForRole(role) {
  if (role === ROLES.ADMINISTRATOR) {
    return [
      MENU_ITEMS.RESERVATIONS,
      MENU_ITEMS.NOTIFICATIONS,
      MENU_ITEMS.RECORDING,
      MENU_ITEMS.TRANSCRIPTION,
    ];
  }
  if (role === ROLES.STAFF) {
    // スタッフは自身に割り当てられた予約のみ管理可能
    return [
      MENU_ITEMS.RESERVATIONS,
      MENU_ITEMS.NOTIFICATIONS,
    ];
  }
  return [];
}

/**
 * ユーザーが対象予約を管理（更新/キャンセル/録画操作）できるか判定する（要件 5.2・5.3）。
 * - 管理者: 常に可。
 * - スタッフ: 自身に割り当てられた予約（assignedStaffId === userId）のみ可。
 * @param {{ userId?: string, role?: string }|null} user
 * @param {{ assignedStaffId?: string }|null} reservation
 * @returns {boolean}
 */
export function canManageReservation(user, reservation) {
  if (!user) {
    return false;
  }
  if (user.role === ROLES.ADMINISTRATOR) {
    return true;
  }
  if (user.role === ROLES.STAFF) {
    return Boolean(reservation) && reservation.assignedStaffId === user.userId;
  }
  return false;
}

/**
 * スタッフ向けに、自身に割り当てられた予約のみへ絞り込む（要件 5.3）。
 * 管理者はすべての予約を返す。
 * @param {{ userId?: string, role?: string }|null} user
 * @param {Array<{ assignedStaffId?: string }>} reservations
 * @returns {Array}
 */
export function visibleReservations(user, reservations = []) {
  if (!user) {
    return [];
  }
  if (user.role === ROLES.ADMINISTRATOR) {
    return reservations;
  }
  if (user.role === ROLES.STAFF) {
    return reservations.filter((r) => r.assignedStaffId === user.userId);
  }
  return [];
}
