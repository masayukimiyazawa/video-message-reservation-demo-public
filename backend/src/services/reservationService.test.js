import { createReservationService, ReservationErrorCode } from './reservationService.js';
import { ReservationStatus } from '../domain/constants.js';

/**
 * Reservation_System サービスのユニットテスト
 *  - Task 7.4 (要件 2.3): Reservation_Store 書込失敗の構造化失敗応答への変換
 *  - Task 8.2 (要件 1.5・2.3): 空き不可時の代替提示・バリデーション・状態遷移・失敗応答変換
 *
 * store を注入して例外を発生させ、サービスが例外を伝播せず結果オブジェクトへ
 * 変換すること、および各エラーコードを検証する。
 */

/** Vonage Video クライアントのモック。 */
function makeVideoClient(overrides = {}) {
  return {
    createSession: async () => ({ sessionId: 'test-session-id' }),
    ...overrides,
  };
}

/** 有効な予約 DTO を作る（必須フィールドを満たす）。 */
function validDto(overrides = {}) {
  return {
    reservationId: 'r-1',
    contact: '+15551230000',
    reservationTime: '2030-01-01T10:00:00.000Z',
    service: 'consultation',
    language: 'en',
    ...overrides,
  };
}

/** 各メソッドが指定した振る舞いをするスタブ store を作る。 */
function makeStore(overrides = {}) {
  return {
    find: async () => [],
    findById: async () => null,
    save: async (r) => r,
    updateStatus: async () => null,
    deleteById: async () => null,
    markNotified: async () => null,
    markReminderSent: async () => null,
    ...overrides,
  };
}

/** logger.error を記録するスタブ。 */
function makeLogger() {
  const calls = [];
  return { logger: { error: (...args) => calls.push(args) }, calls };
}

describe('createReservation (Task 8.2 / 要件 1.3・1.5・2.3)', () => {
  test('有効な DTO なら保存して { ok:true, reservation } を返す', async () => {
    const saved = { ...validDto(), status: ReservationStatus.PENDING, notified: false };
    const store = makeStore({ find: async () => [], save: async () => saved });
    const svc = createReservationService({ store, videoClient: makeVideoClient() });

    const result = await svc.createReservation(validDto());
    expect(result.ok).toBe(true);
    expect(result.reservation).toEqual(saved);
  });

  test('必須フィールド欠落は validation_error を返し保存しない', async () => {
    let saveCalled = false;
    const store = makeStore({ save: async (r) => { saveCalled = true; return r; } });
    const svc = createReservationService({ store, videoClient: makeVideoClient() });

    const result = await svc.createReservation(validDto({ contact: '   ' }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.VALIDATION_ERROR);
    expect(result.errors).toContain('contact');
    expect(saveCalled).toBe(false);
  });

  test('不正な言語は validation_error を返す', async () => {
    const svc = createReservationService({ store: makeStore(), videoClient: makeVideoClient() });
    const result = await svc.createReservation(validDto({ language: 'fr' }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.VALIDATION_ERROR);
    expect(result.errors).toContain('language:invalid');
  });

  test('希望枠が既存予約と重複する場合 slot_unavailable と代替候補を返す（要件 1.5）', async () => {
    // 既存に同一時刻の confirmed 予約を持たせて衝突させる。
    const existing = [
      {
        reservationId: 'existing-1',
        contact: '+1',
        reservationTime: '2030-01-01T10:00:00.000Z',
        service: 's',
        status: ReservationStatus.CONFIRMED,
        language: 'en',
      },
    ];
    const store = makeStore({ find: async () => existing });
    const svc = createReservationService({ store, videoClient: makeVideoClient() });

    const result = await svc.createReservation(validDto());
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.SLOT_UNAVAILABLE);
    expect(Array.isArray(result.alternatives)).toBe(true);
    expect(result.alternatives.length).toBeGreaterThanOrEqual(1);
  });

  test('キャンセル済み既存予約は枠を占有しないので available（重複しない）', async () => {
    const existing = [
      {
        reservationId: 'cancelled-1',
        contact: '+1',
        reservationTime: '2030-01-01T10:00:00.000Z',
        service: 's',
        status: ReservationStatus.CANCELLED,
        language: 'en',
      },
    ];
    const saved = { ...validDto(), status: ReservationStatus.PENDING };
    const store = makeStore({ find: async () => existing, save: async () => saved });
    const svc = createReservationService({ store, videoClient: makeVideoClient() });

    const result = await svc.createReservation(validDto());
    expect(result.ok).toBe(true);
  });

  test('空き判定用の一覧取得（find）が失敗すると store_error へ変換される（要件 2.3）', async () => {
    const { logger, calls } = makeLogger();
    const store = makeStore({ find: async () => { throw new Error('接続失敗'); } });
    const svc = createReservationService({ store, logger, videoClient: makeVideoClient() });

    const result = await svc.createReservation(validDto());
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.STORE_ERROR);
    expect(result.message).toContain('接続失敗');
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Reservation_Store 書込失敗の変換 (Task 7.4 / 要件 2.3)', () => {
  test('save が例外を投げると store_error 応答へ変換され、例外は伝播しない', async () => {
    const { logger, calls } = makeLogger();
    const store = makeStore({
      find: async () => [],
      save: async () => { throw new Error('書込失敗: write concern error'); },
    });
    const svc = createReservationService({ store, logger, videoClient: makeVideoClient() });

    // 例外を投げず結果を返すこと（rejects にならない）。
    const result = await svc.createReservation(validDto());
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.STORE_ERROR);
    expect(result.message).toContain('書込失敗');
    // エラーが記録されること（要件 2.3）。
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  test('非 Error（文字列 throw）でも store_error へ変換される', async () => {
    const { logger } = makeLogger();
    const store = makeStore({
      find: async () => [],
      // eslint-disable-next-line no-throw-literal
      save: async () => { throw 'string failure'; },
    });
    const svc = createReservationService({ store, logger, videoClient: makeVideoClient() });

    const result = await svc.createReservation(validDto());
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.STORE_ERROR);
    expect(result.message).toBe('string failure');
  });
});

describe('updateReservation (Task 8.2 / 要件 2.1・2.3)', () => {
  test('id が空なら validation_error', async () => {
    const svc = createReservationService({ store: makeStore() });
    const result = await svc.updateReservation('', { service: 'x' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.VALIDATION_ERROR);
  });

  test('対象が存在しなければ not_found', async () => {
    const store = makeStore({ findById: async () => null });
    const svc = createReservationService({ store });
    const result = await svc.updateReservation('r-1', { service: 'x' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.NOT_FOUND);
  });

  test('patch をマージして保存する（reservationId は書き換えられない）', async () => {
    const current = {
      reservationId: 'r-1',
      contact: '+1',
      reservationTime: '2030-01-01T10:00:00.000Z',
      service: 'old',
      status: ReservationStatus.PENDING,
      language: 'en',
    };
    let savedArg;
    const store = makeStore({
      findById: async () => current,
      save: async (r) => { savedArg = r; return r; },
    });
    const svc = createReservationService({ store });

    const result = await svc.updateReservation('r-1', { service: 'new', reservationId: 'hacked' });
    expect(result.ok).toBe(true);
    expect(savedArg.service).toBe('new');
    expect(savedArg.reservationId).toBe('r-1');
  });

  test('findById 失敗は store_error へ変換される（要件 2.3）', async () => {
    const { logger } = makeLogger();
    const store = makeStore({ findById: async () => { throw new Error('read fail'); } });
    const svc = createReservationService({ store, logger });
    const result = await svc.updateReservation('r-1', { service: 'x' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.STORE_ERROR);
  });
});

describe('cancelReservation (Task 8.2 / 要件 2.1・2.3)', () => {
  test('存在する予約を cancelled に更新する', async () => {
    const updated = { reservationId: 'r-1', status: ReservationStatus.CANCELLED };
    let statusArg;
    const store = makeStore({
      updateStatus: async (id, status) => { statusArg = status; return updated; },
    });
    const svc = createReservationService({ store });

    const result = await svc.cancelReservation('r-1');
    expect(result.ok).toBe(true);
    expect(statusArg).toBe(ReservationStatus.CANCELLED);
    expect(result.reservation).toEqual(updated);
  });

  test('対象が存在しなければ not_found', async () => {
    const store = makeStore({ updateStatus: async () => null });
    const svc = createReservationService({ store });
    const result = await svc.cancelReservation('r-1');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.NOT_FOUND);
  });

  test('updateStatus 失敗は store_error へ変換される（要件 2.3）', async () => {
    const { logger } = makeLogger();
    const store = makeStore({ updateStatus: async () => { throw new Error('cancel fail'); } });
    const svc = createReservationService({ store, logger });
    const result = await svc.cancelReservation('r-1');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.STORE_ERROR);
  });
});

describe('deleteReservation (要件 2.1・2.3)', () => {
  test('存在する予約を削除して { ok:true, reservation } を返す', async () => {
    const deleted = { reservationId: 'r-1', contact: '+15551230000' };
    let idArg;
    const store = makeStore({
      deleteById: async (id) => { idArg = id; return deleted; },
    });
    const svc = createReservationService({ store });

    const result = await svc.deleteReservation('r-1');
    expect(result.ok).toBe(true);
    expect(idArg).toBe('r-1');
    expect(result.reservation).toEqual(deleted);
  });

  test('ID 欠落は validation_error', async () => {
    const svc = createReservationService({ store: makeStore() });
    const result = await svc.deleteReservation('');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.VALIDATION_ERROR);
  });

  test('対象が存在しなければ not_found', async () => {
    const store = makeStore({ deleteById: async () => null });
    const svc = createReservationService({ store });
    const result = await svc.deleteReservation('r-missing');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.NOT_FOUND);
  });

  test('deleteById 失敗は store_error へ変換される（要件 2.3）', async () => {
    const { logger } = makeLogger();
    const store = makeStore({ deleteById: async () => { throw new Error('delete fail'); } });
    const svc = createReservationService({ store, logger });
    const result = await svc.deleteReservation('r-1');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.STORE_ERROR);
  });
});

describe('listReservations (Task 8.2 / 要件 2.4)', () => {
  test('find の結果を { ok:true, reservations } で返す', async () => {
    const rows = [{ reservationId: 'a' }, { reservationId: 'b' }];
    const store = makeStore({ find: async () => rows });
    const svc = createReservationService({ store });
    const result = await svc.listReservations();
    expect(result.ok).toBe(true);
    expect(result.reservations).toEqual(rows);
  });

  test('find 失敗は store_error へ変換される（要件 2.3）', async () => {
    const { logger } = makeLogger();
    const store = makeStore({ find: async () => { throw new Error('list fail'); } });
    const svc = createReservationService({ store, logger });
    const result = await svc.listReservations();
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ReservationErrorCode.STORE_ERROR);
  });
});
