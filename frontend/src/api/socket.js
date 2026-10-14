import { io } from 'socket.io-client';
import { API_BASE_URL, getAuthToken } from './client.js';

/**
 * Socket.IO クライアント接続ラッパー（タスク 15.1 / 要件 3.3, 7.5）。
 *
 * サーバーが送出するリアルタイムイベント（`reservation:due`・`recording:status`）を
 * 購読するためのヘルパーを提供する。接続には JWT を auth として渡す。
 */

/** サーバーが送出する既知のイベント名。 */
export const SOCKET_EVENTS = {
  RESERVATION_DUE: 'reservation:due',
  RECORDING_STATUS: 'recording:status',
  RESERVATION_TEN_MIN_REMINDER: 'reservation:tenMinReminder',
  RESERVATION_MANUAL_JOIN_LINK: 'reservation:manualJoinLink',
};

/**
 * Socket.IO クライアントを生成する（自動接続なし）。
 * @param {import('socket.io-client').ManagerOptions & import('socket.io-client').SocketOptions} [options]
 * @returns {import('socket.io-client').Socket}
 */
export function createSocket(options = {}) {
  const token = getAuthToken();
  return io(API_BASE_URL, {
    autoConnect: false,
    auth: token ? { token } : undefined,
    ...options,
  });
}

/**
 * 接続を管理し、イベント購読ヘルパーを備えたラッパーを生成する。
 * React コンポーネントは connect() / on*() / disconnect() を使い、
 * 返される unsubscribe 関数でクリーンアップできる。
 *
 * @param {import('socket.io-client').Socket} [socket] 既存 socket を注入可能（テスト用）
 * @returns {{
 *   socket: import('socket.io-client').Socket,
 *   connect: () => void,
 *   disconnect: () => void,
 *   onReservationDue: (handler: (payload: any) => void) => () => void,
 *   onTenMinReminder: (handler: (payload: any) => void) => () => void,
 *   onManualJoinLink: (handler: (payload: any) => void) => () => void,
 *   onRecordingStatus: (handler: (payload: any) => void) => () => void,
 *   on: (event: string, handler: (payload: any) => void) => () => void,
 * }}
 */
export function createSocketClient(socket = createSocket()) {
  /**
   * 任意イベントを購読し、購読解除関数を返す。
   * @param {string} event
   * @param {(payload: any) => void} handler
   */
  const on = (event, handler) => {
    socket.on(event, handler);
    return () => socket.off(event, handler);
  };

return {
    socket,
    connect: () => {
      if (!socket.connected) {
        socket.connect();
      }
    },
    disconnect: () => socket.disconnect(),
    /** 予約時刻到来通知（要件 3.3） */
    onReservationDue: (handler) => on(SOCKET_EVENTS.RESERVATION_DUE, handler),
    /** 10分前リマインダー通知（要件 3.1・3.4） */
    onTenMinReminder: (handler) => on(SOCKET_EVENTS.RESERVATION_TEN_MIN_REMINDER, handler),
    /** 管理者による手動再通知（ジョインリンク再送） */
    onManualJoinLink: (handler) => on(SOCKET_EVENTS.RESERVATION_MANUAL_JOIN_LINK, handler),
    /** 録画状態変化通知（要件 7.5） */
    onRecordingStatus: (handler) => on(SOCKET_EVENTS.RECORDING_STATUS, handler),
    on,
  };
}

export default createSocketClient;
