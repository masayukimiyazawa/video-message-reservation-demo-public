/**
 * REST API クライアントラッパー（タスク 15.1 / 要件 4.1）。
 *
 * - ベース URL は Vite 環境変数 `VITE_API_BASE_URL` から取得する。
 *   未設定時は「同一オリジン」（空文字）として相対パスで叩く。
 *   これにより、バックエンドが SPA も配信する構成（Cloudflare トンネル /
 *   デプロイ先で 1 つの公開 URL だけを使う運用）では、利用者がどの URL から
 *   開いても API へ同じオリジンで到達できる。
 *   フロント（5173）とバックエンド（4000）を分けて運用する場合のみ
 *   `VITE_API_BASE_URL=http://localhost:4000` のように絶対 URL を指定する。
 * - JWT を localStorage に保持し、Authorization: Bearer として自動付与する。
 * - JSON リクエスト/レスポンスの共通処理とエラー整形を提供する。
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

const TOKEN_STORAGE_KEY = 'vvr.authToken';

/**
 * 保持中の認証トークンを取得する。
 * @returns {string|null}
 */
export function getAuthToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * 認証トークンを保存する。null を渡すとクリアする。
 * @param {string|null} token
 */
export function setAuthToken(token) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    /* localStorage 不可環境では何もしない */
  }
}

/**
 * 認証トークンを破棄する（ログアウト用）。
 */
export function clearAuthToken() {
  setAuthToken(null);
}

/**
 * REST 呼び出しの失敗を表す構造化エラー。
 */
export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * 低レベルの fetch ラッパー。
 * - JWT を自動で付与。
 * - `body` がオブジェクトの場合は JSON へシリアライズ。
 * - 非 2xx 応答は ApiError として送出。
 *
 * @param {string} path 例: '/reservations'
 * @param {RequestInit & { body?: any }} [options]
 * @returns {Promise<any>} JSON パース済みレスポンス（204 の場合は null）
 */
// 401 ハンドラを登録するためのコールバック（React Router の navigate などを後から注入可能）
let onUnauthorized = null;

/**
 * 401 レスポンス時のハンドラを設定する（React Router の navigate などを注入する用途）。
 * @param {(path: string) => void} handler
 * @returns {() => void} ハンドラをクリアするクリーンアップ関数
 */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
  return () => {
    onUnauthorized = null;
  };
}

/**
 * 内部用：401 時の共通処理（トークン破棄＋ハンドラ呼び出し）。
 */
function handleUnauthorized() {
  clearAuthToken();
  if (onUnauthorized) {
    onUnauthorized('/login');
  }
}

export async function apiFetch(path, options = {}) {
  const { headers: customHeaders, body, ...rest } = options;

  const headers = { ...(customHeaders || {}) };
  let payload = body;

  // オブジェクトボディは JSON 化して Content-Type を付与する（FormData 等はそのまま）。
  const isPlainObject =
    body != null && typeof body === 'object' && !(body instanceof FormData);
  if (isPlainObject) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    payload = JSON.stringify(body);
  }

  const token = getAuthToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers,
    body: payload,
  });

  const data = await parseResponse(res);

  if (!res.ok) {
    // 401 はトークン期限切れや無効 → トークン破棄＋ログイン画面へ
    if (res.status === 401) {
      handleUnauthorized();
      throw new ApiError('認証が切れました。再度ログインしてください。', {
        status: 401,
        body: data,
      });
    }
    const message =
      (data && (data.message || data.error)) || `API error ${res.status}`;
    throw new ApiError(message, { status: res.status, body: data });
  }

  return data;
}

/**
 * レスポンス本文を Content-Type に応じてパースする。
 * @param {Response} res
 * @returns {Promise<any>}
 */
async function parseResponse(res) {
  if (res.status === 204) {
    return null;
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

/**
 * REST ヘルパー。設計書の API 概要に沿った代表的な呼び出しを提供する。
 * 各メソッドは薄いラッパーであり、後続タスク（16/17）がそのまま利用できる。
 */
export const api = {
  get: (path, options) => apiFetch(path, { ...options, method: 'GET' }),
  post: (path, body, options) =>
    apiFetch(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) =>
    apiFetch(path, { ...options, method: 'PATCH', body }),
  delete: (path, options) => apiFetch(path, { ...options, method: 'DELETE' }),

  /**
   * ログイン（要件 5.1）。成功時にトークンを保存する。
   * @param {{ userId: string, password: string }} credentials
   */
  async login(credentials) {
    const result = await apiFetch('/auth/login', {
      method: 'POST',
      body: credentials,
    });
    if (result && result.token) {
      setAuthToken(result.token);
    }
    return result;
  },

  logout() {
    clearAuthToken();
  },

  /** 予約一覧取得（要件 2.4） */
  listReservations: (filter) => {
    const qs = filter ? `?${new URLSearchParams(filter).toString()}` : '';
    return apiFetch(`/reservations${qs}`, { method: 'GET' });
  },

  /** 指定日の予約可能時間帯取得 */
  getAvailableSlots: (date) =>
    apiFetch(`/reservations/available-slots?date=${date}`, { method: 'GET' }),

  /** 指定日の予約済み枠取得（管理者用） */
  getBookedSlots: (date) =>
    apiFetch(`/reservations/booked-slots?date=${date}`, { method: 'GET' }),

  /** 予約のセッション ID 取得（なければ作成） */
  getSessionId: (reservationId) =>
    apiFetch(`/reservations/${reservationId}/session`, { method: 'GET' }),

  /** 予約作成 */
  createReservation: (dto) =>
    apiFetch('/reservations', { method: 'POST', body: dto }),

  /** 予約更新/キャンセル */
  updateReservation: (id, patch) =>
    apiFetch(`/reservations/${id}`, { method: 'PATCH', body: patch }),

  /** 予約削除（キャンセルではなくレコード自体を削除） */
  deleteReservation: (id) =>
    apiFetch(`/reservations/${id}`, { method: 'DELETE' }),

  /**
   * 予約の通知を手動で再送する（管理画面「再通知」）。
   * 1 回限りの入室リンクを張り直すため、サーバー側で新しいリンクを発行して送る。
   * @param {string} reservationId
   * @returns {Promise<{ ok: boolean, joinUrl?: string }>}
   */
  resendNotification: (reservationId) =>
    apiFetch(`/reservations/${reservationId}/resend-notification`, { method: 'POST' }),

  /** Video セッショントークン発行（認証必須 / 管理者・スタッフ・要件 4.1） */
  createSessionToken: (sessionId) =>
    apiFetch(`/sessions/${sessionId}/token`, { method: 'POST' }),

  /**
   * ゲスト用 Video セッショントークン発行（認証不要 / モバイル等のエンドユーザー・要件 4.1）。
   * apiFetch はトークン保持時のみ Authorization を付与するため、未ログインでは
   * 認証ヘッダーなしで送信される。予約バックドのため有効な予約がなければ 403。
   * @param {string} sessionId
   * @param {string} [displayName] connection data に埋め込む表示名
   */
  createGuestSessionToken: (sessionId, displayName) =>
    apiFetch(`/sessions/${sessionId}/guest-token`, {
      method: 'POST',
      body: displayName ? { displayName } : undefined,
    }),

  /** 録画開始（要件 7.1） */
  startRecording: (body) =>
    apiFetch('/recordings/start', { method: 'POST', body }),

  /** 録画停止（要件 7.3） */
  stopRecording: (archiveId) =>
    apiFetch(`/recordings/${archiveId}/stop`, { method: 'POST' }),

  /** 話者分離文字起こし取得（要件 8.2） */
  getTranscription: (archiveId) =>
    apiFetch(`/transcriptions/${archiveId}`, { method: 'GET' }),

  /** 文字起こし一覧取得（要件 8.5・管理画面用） */
  getTranscriptions: () =>
    apiFetch(`/transcriptions`, { method: 'GET' }),

  /** 録画一覧取得（要件 7.4・管理画面用） */
  getArchives: () =>
    apiFetch(`/recordings`, { method: 'GET' }),

  /** 特定予約の録画一覧取得 */
  getReservationArchives: (reservationId) =>
    apiFetch(`/reservations/${reservationId}/archives`, { method: 'GET' }),

  /** 文字起こし一覧取得（要件 8.5・管理画面用） */
  getTranscriptions: () =>
    apiFetch(`/transcriptions`, { method: 'GET' }),

  /** 特定予約の文字起こし一覧取得 */
  getReservationTranscriptions: (reservationId) =>
    apiFetch(`/reservations/${reservationId}/transcriptions`, { method: 'GET' }),

  /** 録画（アーカイブ）削除 */
  deleteArchive: (archiveId) =>
    apiFetch(`/recordings/${archiveId}`, { method: 'DELETE' }),

  /** 文字起こし（トランスクリプション）削除 */
  deleteTranscription: (archiveId) =>
    apiFetch(`/transcriptions/${archiveId}`, { method: 'DELETE' }),

  /**
   * WhatsApp 入室リンクのトークンを消費し、ゲスト publisher トークンを取得する（要件 4.1・新機能）。
   * 初回クリック時にしか成功しない（一度だけ有効）。2 回目以降は 410 を返す。
   * @param {string} tokenId
   * @param {string} [displayName] 任意の表示名
   */
  redeemJoinToken: (tokenId, displayName) =>
    apiFetch(`/sessions/join/${tokenId}`, {
      method: 'POST',
      body: displayName ? { displayName } : undefined,
    }),
};

export default api;
