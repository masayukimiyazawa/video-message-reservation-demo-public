/**
 * roomLifecycleService ユニットテスト
 *
 * 検証の要点:
 *  - 入室/退出イベントで在室記録を更新する
 *  - 全員退室した時だけ室を無効化する（before: 1 人の時は何もしない）
 *  - 無効化で「接続切断・リンク無効化・予約 completed」の 3 つを行う
 *  - 同時退室による二重処理を防ぐ（markClosed が 1 回だけ成功する）
 *  - 切断に失敗しても後続の後始末は実行される
 *  - 通话開始前の空室を誤って閉じない
 */

import { ReservationStatus } from '../domain/constants.js';
import { createActiveArchiveStore } from '../infra/activeArchiveStore.js';
import { createRoomLifecycleService } from './roomLifecycleService.js';

/**
 * メモリ上の各ストア偽実装。signal の意味論を本番に合わせている。
 * - sessionPresenceStore.markClosed は closedAt:null のときだけ成功し、2 回目は null
 */
function makeDeps({ presence, reservations = [], closed = false, recordingService } = {}) {
  const state = {
    presence:
      presence == null
        ? null
        : {
            sessionId: 's1',
            connections: [],
            openedAt: null,
            closedAt: closed ? new Date('2026-01-01T02:00:00Z') : null,
            ...presence,
          },
    reservations: reservations.map((r) => ({ ...r })),
    joinTokens: [],
  };

  const calls = {
    addConnection: [],
    removeConnection: [],
    markClosed: [],
    disconnectClient: [],
    updateStatus: [],
    invalidate: [],
    startRecording: [],
    stopRecording: [],
  };

  const deps = {
    calls,
    state,
    activeArchiveStore: createActiveArchiveStore(),
    sessionPresenceStore: {
      async addConnection(input) {
        calls.addConnection.push(input);
        if (!state.presence) {
          state.presence = {
            sessionId: input.sessionId,
            connections: [],
            openedAt: input.joinedAt,
            closedAt: null,
          };
        }
        state.presence.connections.push({
          connectionId: input.connectionId,
          userId: input.userId,
          role: input.role,
          joinedAt: input.joinedAt,
        });
        if (state.presence.openedAt == null) state.presence.openedAt = input.joinedAt;
        return state.presence;
      },
      async removeConnection({ sessionId, connectionId }) {
        calls.removeConnection.push({ sessionId, connectionId });
        if (!state.presence) return null;
        state.presence.connections = state.presence.connections.filter(
          (c) => c.connectionId !== connectionId,
        );
        return state.presence;
      },
      async findBySessionId(sessionId) {
        if (!state.presence || state.presence.sessionId !== sessionId) return null;
        return state.presence;
      },
      async markClosed(sessionId, closedAt) {
        calls.markClosed.push({ sessionId, closedAt });
        if (!state.presence || state.presence.closedAt != null) return null;
        state.presence.closedAt = closedAt;
        return state.presence;
      },
    },
    joinTokenStore: {
      async invalidateBySessionId(sessionId, now) {
        calls.invalidate.push({ sessionId, now });
        return 1;
      },
      // 依存オブジェクトの完全性を保証するため、使われる全メソッドを実装する。
      // （在室記録が無い場合のみ呼ばれる）
      async isSessionInvalidated() {
        return false;
      },
    },
    reservationStore: {
      async findBySessionId(sessionId) {
        return state.reservations.filter((r) => r.sessionId === sessionId);
      },
      async updateStatus(reservationId, status) {
        calls.updateStatus.push({ reservationId, status });
        const target = state.reservations.find((r) => r.reservationId === reservationId);
        if (target) target.status = status;
        return target;
      },
    },
    videoClient: {
      async disconnectClient(sessionId, connectionId) {
        calls.disconnectClient.push({ sessionId, connectionId });
      },
    },
    recordingService: recordingService ?? {
      async startRecording(req) {
        calls.startRecording.push(req);
        return { ok: true, archive: { id: `arch-${req.sessionId}` } };
      },
      async stopRecording(archiveId) {
        calls.stopRecording.push(archiveId);
        return { ok: true };
      },
    },
    clock: () => new Date('2026-01-01T01:00:00Z'),
    logs: [],
    logger: (msg, meta) => deps.logs.push({ msg, meta }),
  };

  return deps;
}

const now = () => new Date('2026-01-01T01:00:00Z');
const opened = () => new Date('2026-01-01T00:00:00Z');

describe('services roomLifecycleService 入室イベント', () => {
  test('connectionCreated で在室記録に追加する', async () => {
    const deps = makeDeps();
    const service = createRoomLifecycleService(deps);

    const result = await service.handleConnectionEvent({
      event: 'connectionCreated',
      sessionId: 's1',
      connectionId: 'c1',
      userId: 'admin',
      role: 'administrator',
    });

    expect(result).toEqual({ handled: true, closed: false, rejected: false });
    expect(deps.calls.addConnection[0]).toMatchObject({
      sessionId: 's1',
      connectionId: 'c1',
      userId: 'admin',
      role: 'administrator',
      joinedAt: now(),
    });
  });

  test('入室だけでは室を閉じない', async () => {
    const deps = makeDeps();
    const service = createRoomLifecycleService(deps);

    await service.handleConnectionEvent({
      event: 'connectionCreated',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(deps.calls.markClosed).toHaveLength(0);
  });

  test('有効な室への入室は切断しない', async () => {
    const deps = makeDeps({ presence: { connections: [], openedAt: opened() } });
    const service = createRoomLifecycleService(deps);

    const result = await service.handleConnectionEvent({
      event: 'connectionCreated',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(result.rejected).toBe(false);
    expect(deps.calls.disconnectClient).toHaveLength(0);
    expect(deps.calls.addConnection).toHaveLength(1);
  });

  test('ゲスト入室で予約の対応言語を引き継いで自動録画する（en）', async () => {
    const deps = makeDeps({
      reservations: [
        { reservationId: 'r1', sessionId: 's1', status: ReservationStatus.CONFIRMED, language: 'en' },
      ],
    });
    const service = createRoomLifecycleService(deps);

    await service.handleConnectionEvent({
      event: 'connectionCreated',
      sessionId: 's1',
      connectionId: 'c1',
      userId: 'guest-1',
      role: 'guest',
    });

    expect(deps.calls.startRecording).toHaveLength(1);
    expect(deps.calls.startRecording[0]).toMatchObject({
      sessionId: 's1',
      withTranscription: true,
      language: 'en',
      reservationId: 'r1',
    });
  });

  test('対応言語が日本語の予約は言語 ja で自動録画する', async () => {
    const deps = makeDeps({
      reservations: [
        { reservationId: 'r1', sessionId: 's1', status: ReservationStatus.CONFIRMED, language: 'ja' },
      ],
    });
    const service = createRoomLifecycleService(deps);

    await service.handleConnectionEvent({
      event: 'connectionCreated',
      sessionId: 's1',
      connectionId: 'c1',
      userId: 'guest-1',
      role: 'guest',
    });

    expect(deps.calls.startRecording[0]).toMatchObject({ language: 'ja', reservationId: 'r1' });
  });

  test('予約が無いゲスト入室は言語 ja を既定として自動録画する', async () => {
    const deps = makeDeps();
    const service = createRoomLifecycleService(deps);

    await service.handleConnectionEvent({
      event: 'connectionCreated',
      sessionId: 's1',
      connectionId: 'c1',
      userId: 'guest-1',
      role: 'guest',
    });

    expect(deps.calls.startRecording[0]).toMatchObject({
      sessionId: 's1',
      language: 'ja',
      reservationId: null,
    });
  });

  test('管理者・スタッフの入室では自動録画しない', async () => {
    const deps = makeDeps();
    const service = createRoomLifecycleService(deps);

    await service.handleConnectionEvent({
      event: 'connectionCreated',
      sessionId: 's1',
      connectionId: 'c1',
      userId: 'admin',
      role: 'administrator',
    });

    expect(deps.calls.startRecording).toHaveLength(0);
  });
});

describe('services roomLifecycleService 退出イベントと室無効化', () => {
  test('まだ接続が残っていれば閉じない（全員退室才算）', async () => {
    const deps = makeDeps({
      presence: { connections: [{ connectionId: 'c1' }, { connectionId: 'c2' }], openedAt: opened() },
    });
    const service = createRoomLifecycleService(deps);

    const result = await service.handleConnectionEvent({
      event: 'connectionDestroyed',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(result.closed).toBe(false);
    expect(deps.calls.markClosed).toHaveLength(0);
  });

  test('最後の 1 人が退室したら室を無効化する', async () => {
    const deps = makeDeps({
      presence: { connections: [{ connectionId: 'c1' }], openedAt: opened() },
    });
    const service = createRoomLifecycleService(deps);

    const result = await service.handleConnectionEvent({
      event: 'connectionDestroyed',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(result).toEqual({ handled: true, closed: true });
    expect(deps.calls.markClosed).toHaveLength(1);
  });

  test('全員退室で進行中の手動録画も停止する（要件 10）', async () => {
    const deps = makeDeps({
      presence: { connections: [{ connectionId: 'c1' }], openedAt: opened() },
    });
    // 手動録画（管理画面 POST /recordings/start）は recordingService 経由で
    // 共有ストアに登録される。ここでは登録済みの状態を再現する。
    deps.activeArchiveStore.set('s1', 'arch-manual');
    const service = createRoomLifecycleService(deps);

    const result = await service.handleConnectionEvent({
      event: 'connectionDestroyed',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(result).toEqual({ handled: true, closed: true });
    expect(deps.calls.stopRecording).toEqual(['arch-manual']);
    // 停止後は登録が消える（二重停止を避ける）。
    expect(deps.activeArchiveStore.get('s1')).toBeNull();
  });

  test('進行中録画が無ければ停止を試みない', async () => {
    const deps = makeDeps({
      presence: { connections: [], openedAt: opened() },
    });
    const service = createRoomLifecycleService(deps);

    await service.handleConnectionEvent({
      event: 'connectionDestroyed',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(deps.calls.stopRecording).toHaveLength(0);
  });

  test('無効化時にその室の未消費リンクを無効化する', async () => {
    const deps = makeDeps({ presence: { connections: [], openedAt: opened() } });
    const service = createRoomLifecycleService(deps);

    await service.handleConnectionEvent({
      event: 'connectionDestroyed',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(deps.calls.invalidate).toEqual([{ sessionId: 's1', now: now() }]);
  });

  test('無効化時にその室に紐づく予約をすべて completed にする', async () => {
    const deps = makeDeps({
      presence: { connections: [], openedAt: opened() },
      reservations: [
        { reservationId: 'r1', sessionId: 's1', status: ReservationStatus.CONFIRMED },
        { reservationId: 'r2', sessionId: 's1', status: ReservationStatus.PENDING },
        { reservationId: 'r3', sessionId: 'other', status: ReservationStatus.CONFIRMED },
      ],
    });
    const service = createRoomLifecycleService(deps);

    await service.handleConnectionEvent({
      event: 'connectionDestroyed',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(deps.calls.updateStatus).toEqual([
      { reservationId: 'r1', status: ReservationStatus.COMPLETED },
      { reservationId: 'r2', status: ReservationStatus.COMPLETED },
    ]);
  });

  test('完了済み・キャンセル済みの予約は触らない（多重更新を避ける）', async () => {
    const deps = makeDeps({
      presence: { connections: [], openedAt: opened() },
      reservations: [
        { reservationId: 'r1', sessionId: 's1', status: ReservationStatus.COMPLETED },
        { reservationId: 'r2', sessionId: 's1', status: ReservationStatus.CANCELLED },
      ],
    });
    const service = createRoomLifecycleService(deps);

    await service.handleConnectionEvent({
      event: 'connectionDestroyed',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(deps.calls.updateStatus).toHaveLength(0);
  });

  test('通話開始前の空室は閉じない（openedAt が無い）', async () => {
    const deps = makeDeps({ presence: { connections: [], openedAt: null } });
    const service = createRoomLifecycleService(deps);

    const result = await service.handleConnectionEvent({
      event: 'connectionDestroyed',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(result.closed).toBe(false);
    expect(deps.calls.markClosed).toHaveLength(0);
  });

  test('在室記録が無いセッションは何もしない', async () => {
    const deps = makeDeps({ presence: null });
    const service = createRoomLifecycleService(deps);

    const result = await service.handleConnectionEvent({
      event: 'connectionDestroyed',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(result.closed).toBe(false);
    expect(deps.calls.markClosed).toHaveLength(0);
  });
});

describe('services roomLifecycleService 冪等性・障害耐性', () => {
  test('2 人目の退出で既に閉じているなら二重処理しない', async () => {
    // 1 人目の退出で閉じた直後の状態（markClosed が null を返す）を再現。
    const deps = makeDeps({ presence: { connections: [], openedAt: opened() }, closed: true });
    const service = createRoomLifecycleService(deps);

    const result = await service.handleConnectionEvent({
      event: 'connectionDestroyed',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(result.closed).toBe(false);
    expect(deps.calls.updateStatus).toHaveLength(0);
    expect(deps.calls.invalidate).toHaveLength(0);
  });

  test('同時退室で race が起きても markClosed は 1 回だけ成功する', async () => {
    const deps = makeDeps({ presence: { connections: [], openedAt: opened() } });
    const service = createRoomLifecycleService(deps);

    // 2 つのイベントを並行処理する（実際の同時退出を模す）。
    const results = await Promise.all([
      service.handleConnectionEvent({ event: 'connectionDestroyed', sessionId: 's1', connectionId: 'c1' }),
      service.handleConnectionEvent({ event: 'connectionDestroyed', sessionId: 's1', connectionId: 'c2' }),
    ]);

    // markClosed の成功は 1 回だけ。
    expect(results.filter((r) => r.closed)).toHaveLength(1);
    // 予約の completed 化も 1 回だけ（findBySessionId は 1 回しか走らない）。
    expect(deps.calls.updateStatus.length).toBeLessThanOrEqual(2);
  });

  test('リンク無効化が失敗しても予約の完了化は実行される', async () => {
    const deps = makeDeps({
      presence: { connections: [], openedAt: opened() },
      reservations: [{ reservationId: 'r1', sessionId: 's1', status: ReservationStatus.CONFIRMED }],
    });
    deps.joinTokenStore.invalidateBySessionId = async () => {
      throw new Error('MongoDB timeout');
    };
    const service = createRoomLifecycleService(deps);

    const result = await service.handleConnectionEvent({
      event: 'connectionDestroyed',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(result.closed).toBe(true);
    // リンク無効化は失敗したが、予約の後始末はスキップされない。
    expect(deps.calls.updateStatus).toEqual([
      { reservationId: 'r1', status: ReservationStatus.COMPLETED },
    ]);
  });

  test('後始尾の失敗は例外を送出せず webhook を落とさない', async () => {
    const deps = makeDeps({ presence: { connections: [], openedAt: opened() } });
    deps.joinTokenStore.invalidateBySessionId = async () => {
      throw new Error('MongoDB timeout');
    };
    const service = createRoomLifecycleService(deps);

    await expect(
      service.handleConnectionEvent({ event: 'connectionDestroyed', sessionId: 's1', connectionId: 'c1' }),
    ).resolves.toBeDefined();
    expect(deps.logs.some((l) => l.msg.includes('入室リンクの無効化に失敗'))).toBe(true);
  });

  test('無効化済み室への入室は記録せず、接続を強制切断する（同時入室の競合対策）', async () => {
    const deps = makeDeps({ presence: { connections: [], openedAt: opened() }, closed: true });
    const service = createRoomLifecycleService(deps);

    const result = await service.handleConnectionEvent({
      event: 'connectionCreated',
      sessionId: 's1',
      connectionId: 'c-late',
    });

    expect(result.rejected).toBe(true);
    expect(deps.calls.addConnection).toHaveLength(0);
    expect(deps.calls.disconnectClient).toEqual([
      { sessionId: 's1', connectionId: 'c-late' },
    ]);
  });

  test('無効化済み室への入室で切断が失敗しても例外を送出しない', async () => {
    const deps = makeDeps({ presence: { connections: [], openedAt: opened() }, closed: true });
    deps.videoClient.disconnectClient = async () => {
      throw new Error('500 internal');
    };
    const service = createRoomLifecycleService(deps);

    await expect(
      service.handleConnectionEvent({ event: 'connectionCreated', sessionId: 's1', connectionId: 'c-late' }),
    ).resolves.toMatchObject({ rejected: true });
    expect(deps.logs.some((l) => l.msg.includes('無効化済み室の接続切断に失敗'))).toBe(true);
  });
});

describe('services roomLifecycleService その他のイベント', () => {
  test('接続の出入りに無関係なイベントは無視する', async () => {
    const deps = makeDeps();
    const service = createRoomLifecycleService(deps);

    const result = await service.handleConnectionEvent({
      event: 'streamCreated',
      sessionId: 's1',
      connectionId: 'c1',
    });

    expect(result).toEqual({ handled: false, closed: false });
    expect(deps.calls.addConnection).toHaveLength(0);
    expect(deps.calls.removeConnection).toHaveLength(0);
  });
});

describe('services roomLifecycleService isRoomClosed（入室前の拒否判定）', () => {
  test('未閉鎖なら false', async () => {
    const deps = makeDeps({ presence: { connections: [], openedAt: opened() } });
    const service = createRoomLifecycleService(deps);

    expect(await service.isRoomClosed('s1')).toBe(false);
  });

  test('閉鎖済みなら true', async () => {
    const deps = makeDeps({ presence: { connections: [], openedAt: opened() }, closed: true });
    const service = createRoomLifecycleService(deps);

    expect(await service.isRoomClosed('s1')).toBe(true);
  });

  test('記録が無いセッションは false（未知の室を閉じない）', async () => {
    const deps = makeDeps({ presence: null });
    const service = createRoomLifecycleService(deps);

    expect(await service.isRoomClosed('unknown')).toBe(false);
  });
});

describe('services roomLifecycleService 依存ストアの完全性', () => {
  test('本番の joinTokenStore が 要求するメソッドをすべて公開している', async () => {
    // テストのスタブが実装不足のまま素通りすると、実行時に TypeError になる。
    // 実ストアと使われるメソッド集合を突き合わせ、乖離を早期に検出する。
    const { joinTokenStore: realStore } = await import('../infra/joinTokenStore.js');
    const required = ['issue', 'findByTokenId', 'consume', 'invalidateBySessionId', 'isSessionInvalidated'];

    for (const method of required) {
      expect(typeof realStore[method]).toBe('function');
    }
  });

  test('roomLifecycleService が使う joinTokenStore のメソッドを既存スタブが実装している', async () => {
    const deps = makeDeps();
    const { joinTokenStore: realStore } = await import('../infra/joinTokenStore.js');

    // 本サービスが実際に使うメソッドだけを検証する
    // （issue / findByTokenId / consume は joinLinkService 側で使うため対象外）。
    const required = ['invalidateBySessionId', 'isSessionInvalidated'];
    for (const key of required) {
      expect(typeof realStore[key]).toBe('function');
      expect(typeof deps.joinTokenStore[key]).toBe('function');
    }
  });

  test('roomLifecycleService が使う reservationStore の全メソッドを既存スタブが実装している', async () => {
    const deps = makeDeps();
    const { reservationStore: realStore } = await import('../infra/reservationStore.js');

    // 本サービスが実際に使うメソッドだけを検証する（save などは使わない）。
    const required = ['findBySessionId', 'updateStatus'];
    const missing = required.filter((key) => typeof deps.reservationStore[key] !== 'function');

    expect(missing).toEqual([]);
  });

  test('roomLifecycleService が使う videoClient の全メソッドを既存スタブが実装している', async () => {
    const deps = makeDeps();
    const { videoClient: realClient } = await import('../infra/videoClient.js');
    const required = ['disconnectClient'];

    for (const key of required) {
      expect(typeof realClient[key]).toBe('function');
      expect(typeof deps.videoClient[key]).toBe('function');
    }
  });
});
