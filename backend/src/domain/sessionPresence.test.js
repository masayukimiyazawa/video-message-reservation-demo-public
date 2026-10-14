import {
  PresenceEvent,
  activeConnections,
  isRoomEmpty,
  parseConnectionEvent,
  shouldCloseRoom,
} from './sessionPresence.js';

describe('domain sessionPresence (在室判定)', () => {
  test('接続リストから不正な要素を除いて取り出す', () => {
    const presence = { connections: [{ connectionId: 'c1' }, null, { role: 'guest' }] };

    expect(activeConnections(presence)).toEqual([{ connectionId: 'c1' }]);
  });

  test('connections が無ければ空とみなす', () => {
    expect(activeConnections({})).toEqual([]);
    expect(activeConnections({ connections: 'oops' })).toEqual([]);
    expect(isRoomEmpty(null)).toBe(true);
  });

  test('接続が 0 件なら空室', () => {
    expect(isRoomEmpty({ connections: [] })).toBe(true);
  });

  test('接続が 1 件でも残っていれば空室ではない', () => {
    expect(isRoomEmpty({ connections: [{ connectionId: 'c1' }] })).toBe(false);
  });
});

describe('domain shouldCloseRoom (室を自動無効化する条件)', () => {
  const opened = { openedAt: new Date('2026-01-01T00:00:00Z'), connections: [] };

  test('一度使われて全員退室したら閉じる', () => {
    expect(shouldCloseRoom(opened)).toBe(true);
  });

  test('まだ誰か接続中なら閉じない', () => {
    const presence = { ...opened, connections: [{ connectionId: 'c1' }] };

    expect(shouldCloseRoom(presence)).toBe(false);
  });

  test('一度も使われていない空室は閉じない（通話開始前の誤終了を防ぐ）', () => {
    expect(shouldCloseRoom({ openedAt: null, connections: [] })).toBe(false);
  });

  test('既に閉じているものは再実行しても閉じない（冪等）', () => {
    const closed = { ...opened, closedAt: new Date('2026-01-01T01:00:00Z') };

    expect(shouldCloseRoom(closed)).toBe(false);
  });

  test('記録が無いセッションは扱わない', () => {
    expect(shouldCloseRoom(null)).toBe(false);
    expect(shouldCloseRoom(undefined)).toBe(false);
  });
});

describe('domain parseConnectionEvent (Vonage 監視ペイロード解析)', () => {
  const base = {
    sessionId: '2_MX4-session',
    projectId: '123456',
    timestamp: 1470257688309,
  };

  test('connectionCreated から接続情報を取り出す', () => {
    const payload = {
      ...base,
      event: PresenceEvent.CONNECTED,
      connection: { id: 'c-1', createdAt: 1470257688143, data: '' },
    };

    expect(parseConnectionEvent(payload)).toEqual({
      event: 'connectionCreated',
      sessionId: '2_MX4-session',
      connectionId: 'c-1',
      userId: null,
      role: null,
      reason: null,
    });
  });

  test('connectionDestroyed は reason も返す', () => {
    const payload = {
      ...base,
      event: PresenceEvent.DISCONNECTED,
      reason: 'clientDisconnected',
      connection: { id: 'c-1', data: '' },
    };

    expect(parseConnectionEvent(payload).reason).toBe('clientDisconnected');
  });

  test('connection data から userId / role を復元する（話者分離の識別子）', () => {
    const payload = {
      ...base,
      event: PresenceEvent.CONNECTED,
      connection: {
        id: 'c-1',
        data: JSON.stringify({ userId: 'staff-1', role: 'administrator' }),
      },
    };

    const parsed = parseConnectionEvent(payload);

    expect(parsed.userId).toBe('staff-1');
    expect(parsed.role).toBe('administrator');
  });

  test('接続済み（role=guest）も解析できる', () => {
    const payload = {
      ...base,
      event: PresenceEvent.CONNECTED,
      connection: { id: 'c-2', data: JSON.stringify({ role: 'guest', displayName: 'Guest' }) },
    };

    const parsed = parseConnectionEvent(payload);

    expect(parsed.role).toBe('guest');
    expect(parsed.userId).toBeNull();
  });

  test('不正な connection data でも解析を止めない', () => {
    const payload = { ...base, event: 'connectionCreated', connection: { id: 'c-1', data: '{oops' } };

    const parsed = parseConnectionEvent(payload);

    expect(parsed).not.toBeNull();
    expect(parsed.userId).toBeNull();
    expect(parsed.role).toBeNull();
  });

  test('data が JSON でない（プレーン文字列）でも null になる', () => {
    const payload = { ...base, event: 'connectionCreated', connection: { id: 'c-1', data: 'plain' } };

    expect(parseConnectionEvent(payload).userId).toBeNull();
  });

  test('event / sessionId / connection.id のいずれかが欠落したら null', () => {
    expect(parseConnectionEvent(null)).toBeNull();
    expect(parseConnectionEvent('text')).toBeNull();
    expect(parseConnectionEvent({ sessionId: 's', connection: { id: 'c' } })).toBeNull();
    expect(parseConnectionEvent({ event: 'connectionCreated', connection: { id: 'c' } })).toBeNull();
    expect(parseConnectionEvent({ event: 'connectionCreated', sessionId: 's' })).toBeNull();
    expect(
      parseConnectionEvent({ event: 'connectionCreated', sessionId: '', connection: { id: 'c' } }),
    ).toBeNull();
  });

  test('streamCreated 等の在室管理対象外イベントは null を返す（サービス側で静かにスキップ）', () => {
    const payload = { ...base, event: 'streamCreated', connection: { id: 'c-1', data: '' } };

    expect(parseConnectionEvent(payload)).toBeNull();
  });
});
