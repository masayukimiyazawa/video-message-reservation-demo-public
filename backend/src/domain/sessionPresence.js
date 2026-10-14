/**
 * 会議室の在室状況（Session_Presence）の純粋ロジック
 *
 * 「ユーザと管理者の全員が退室した」ことを判定するための規則をここに集約する。
 * 入退室の記録そのものは infra（sessionPresenceStore）、Vonage からのイベント受理は
 * services（roomLifecycleService）が担う。
 *
 * Vonage Video の接続イベント（connectionCreated / connectionDestroyed）を
 * サーバー側で受信し、接続の出入りを記録する。ブラウザが強制終了しても
 * 検知できるため、クライアント通知だけに依存しない。
 */

/**
 * 在室状況ドキュメントから現在の接続を取り出す。
 * @param {{ connections?: unknown }} [presence]
 * @returns {Array<{ connectionId: string, userId?: string, role?: string }>}
 */
export function activeConnections(presence) {
  const connections = presence?.connections;
  return Array.isArray(connections) ? connections.filter((c) => c && c.connectionId) : [];
}

/**
 * 会議室に誰もいなくなったかどうかを判定する（純粋）。
 *
 * @param {object} [presence] 在室状況ドキュメント
 * @returns {boolean} 接続が 0 件なら true
 */
export function isRoomEmpty(presence) {
  return activeConnections(presence).length === 0;
}

/**
 * 会議室を自動的に無効化すべきかどうかを判定する（純粋）。
 *
 * 無効化条件を厳密に 3 つ全て満たすときだけ true:
 *  1. 在室記録が存在する（未知のセッションを勝手に閉じない）
 *  2. まだ閉じられていない（冪等。再実行しても二重処理しない）
 *  3. 一度は使われた（openedAt がある＝誰か入ったことがある）かつ、全員退室している
 *
 * 条件 3 の「一度使われた」判定を入れていないと、通話開始前に誤って室を閉じてしまう。
 *
 * @param {object} [presence] 在室状況ドキュメント
 * @returns {boolean}
 */
export function shouldCloseRoom(presence) {
  if (!presence) {
    return false; // 記録が無いセッションは扱わない
  }
  if (presence.closedAt != null) {
    return false; // 既に無効化済み。再実行しても何もしない（冪等）
  }
  if (presence.openedAt == null) {
    return false; // 一度も誰も入っていない。空室を閉じる必要はない
  }
  return isRoomEmpty(presence);
}

/**
 * Vonage Video の監視 Webhook ペイロードから接続情報を抽出する（純粋）。
 *
 * 公式ペイロード形式:
 *   { sessionId, projectId, event, timestamp, connection: { id, createdAt, data } }
 *
 * 接続の connection.data には sessionService の buildConnectionData が
 * userId / role を JSON 文字列として埋め込んでいる（話者分離の前提）。
 * 解析に失敗しても監視処理は止めないため、userId / role は null で許容する。
 *
 * 対象イベント:
 *   - connectionCreated / connectionDestroyed: 在室管理用（接続情報を返す）
 *   - streamCreated / streamDestroyed / archive 等: 既知だが在室管理対象外（null を返し、呼び出し側で静かにスキップ）
 *   - その他: null を返す
 *
 * @param {object} payload Vonage が POST した JSON
 * @returns {{
 *   event: string|null,
 *   sessionId: string|null,
 *   connectionId: string|null,
 *   userId: string|null,
 *   role: string|null,
 *   reason: string|null
 * }|null} 解析不能または在室管理対象外なら null
 */
export function parseConnectionEvent(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const event = typeof payload.event === 'string' ? payload.event : null;
  const sessionId =
    typeof payload.sessionId === 'string' && payload.sessionId.length > 0
      ? payload.sessionId
      : null;
  const connectionId =
    typeof payload.connection?.id === 'string' && payload.connection.id.length > 0
      ? payload.connection.id
      : null;
  const reason = typeof payload.reason === 'string' ? payload.reason : null;

  if (!event || !sessionId || !connectionId) {
    return null;
  }

  // 在室管理対象のイベントのみ接続情報を返す
  const isPresenceEvent = event === PresenceEvent.CONNECTED || event === PresenceEvent.DISCONNECTED;
  if (!isPresenceEvent) {
    // 既知イベント（streamCreated 等）は正常だが在室管理対象外 → null を返し呼び出し側でスキップ
    return null;
  }

  // connection.data は JSON 文字列。不正でも監視は継続する。
  const { userId, role } = parseConnectionData(payload.connection?.data);

  return { event, sessionId, connectionId, userId, role, reason };
}

/**
 * 在室状況の更新イベント種別。
 * @readonly
 * @enum {string}
 */
export const PresenceEvent = Object.freeze({
  CONNECTED: 'connectionCreated',
  DISCONNECTED: 'connectionDestroyed',
});

/**
 * connection data 文字列を解析する（純粋）。不正な JSON でも null を返す。
 * @param {unknown} raw
 * @returns {{ userId: string|null, role: string|null }}
 */
function parseConnectionData(raw) {
  const empty = { userId: null, role: null };
  if (typeof raw !== 'string' || raw.length === 0) {
    return empty;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return empty;
    }
    return {
      userId: typeof parsed.userId === 'string' ? parsed.userId : null,
      role: typeof parsed.role === 'string' ? parsed.role : null,
    };
  } catch {
    return empty;
  }
}
