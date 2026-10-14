import { describe, it, expect, vi } from 'vitest';

import { createSocketClient, SOCKET_EVENTS } from './socket.js';

/**
 * ソケット購読ヘルパーの回帰テスト。
 *
 * 手動再通知（reservation:manualJoinLink）のイベント名が SOCKET_EVENTS に
 * 定義されていること、各ヘルパーが正しいイベント名で購読/解除することを検証する。
 */

function makeFakeSocket() {
  return {
    connected: false,
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

describe('socket クライアントのイベント購読', () => {
  it('SOCKET_EVENTS に manualJoinLink が定義されている', () => {
    expect(SOCKET_EVENTS.RESERVATION_MANUAL_JOIN_LINK).toBe('reservation:manualJoinLink');
  });

  it('onManualJoinLink は reservation:manualJoinLink を購読/解除する', () => {
    const socket = makeFakeSocket();
    const client = createSocketClient(socket);
    const handler = () => {};

    const unsubscribe = client.onManualJoinLink(handler);

    expect(socket.on).toHaveBeenCalledWith('reservation:manualJoinLink', handler);

    unsubscribe();
    expect(socket.off).toHaveBeenCalledWith('reservation:manualJoinLink', handler);
  });
});
