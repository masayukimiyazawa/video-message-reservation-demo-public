import { createNotificationService, RESERVATION_DUE_EVENT, RESERVATION_REMINDER_EVENT } from './notificationService.js';

/**
 * Notification_Service の部分的失敗ユニットテスト（Task 11.2 / 要件 3.4）
 *
 * WhatsApp 通知の送信が失敗しても、Socket.IO `reservation:due` の画面通知イベントは
 * 送出され、予約は notified に更新される（部分的失敗の許容）。
 * emit / sendWhatsApp / store を注入モックにして検証する。
 */

/** emit の呼び出しを記録するモック。 */
function makeEmit() {
  const calls = [];
  const emit = (event, payload) => calls.push({ event, payload });
  emit.calls = calls;
  return emit;
}

/** find / markNotified / markReminderSent を記録する store モック。 */
function makeStore(candidates) {
  const notifiedIds = [];
  const reminderSentIds = [];
  const tenMinReminderSentIds = [];
  return {
    store: {
      find: async (filter) => {
        // 10分前リマインダー用フィルタ: tenMinReminderSent: { $ne: true }
        if (filter && filter.tenMinReminderSent !== undefined) {
          return candidates.filter(
            (r) => r.tenMinReminderSent !== true && r.status === 'confirmed',
          );
        }
        if (filter && filter.reminderSent !== undefined) {
          // 24時間前リマインダー用フィルタ: reminderSent: { $ne: true } かつ status: confirmed
          return candidates.filter((r) =>
            r.reminderSent !== true && r.status === 'confirmed'
          );
        }
        // 到来通知用フィルタ: notified: { $ne: true }
        return candidates.filter((r) => r.notified !== true);
      },
      markNotified: async (id) => { notifiedIds.push(id); return { reservationId: id, notified: true }; },
      markReminderSent: async (id) => { reminderSentIds.push(id); return { reservationId: id, reminderSent: true }; },
      markTenMinReminderSent: async (id) => { tenMinReminderSentIds.push(id); return { reservationId: id, tenMinReminderSent: true }; },
      save: async (r) => r,
      findById: async () => null,
      updateStatus: async () => null,
    },
    notifiedIds,
    reminderSentIds,
    tenMinReminderSentIds,
  };
}

/** 現在時刻より前の到来予約。 */
const dueReservation = {
  reservationId: 'r-due-1',
  contact: '+15551230000',
  reservationTime: '2020-01-01T10:00:00.000Z',
  service: 'consultation',
  status: 'confirmed',
  language: 'en',
  notified: false,
  assignedStaffId: 'staff-1',
};

/** リマインダー対象予約（将来の時刻、未送信、確定済み）。 */
const reminderReservation = {
  reservationId: 'r-reminder-1',
  contact: '+15551230001',
  reservationTime: '2020-06-01T12:00:00.000Z', // NOW から 12 時間後
  service: 'follow_up',
  status: 'confirmed',
  language: 'ja',
  notified: false,
  reminderSent: false,
  assignedStaffId: 'staff-2',
};

const NOW = new Date('2020-06-01T00:00:00.000Z');

// リマインダーウィンドウ: 24 時間 = 86400000 ms
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

describe('Notification_Service 部分的失敗 (Task 11.2 / 要件 3.4)', () => {
  test('WhatsApp 送信が失敗しても reservation:due は送出され notified 更新される', async () => {
    const emit = makeEmit();
    const { store, notifiedIds } = makeStore([dueReservation]);
    const errors = [];
    const svc = createNotificationService({
      store,
      emit,
      sendWhatsApp: async () => { throw new Error('WhatsApp API down'); },
      clock: () => NOW,
      logger: { error: (...a) => errors.push(a), info: () => {} },
    });

    const result = await svc.pollDueReservations();

    // Socket.IO 画面通知は送出された（要件 3.4）。
    expect(emit.calls.length).toBe(1);
    expect(emit.calls[0].event).toBe(RESERVATION_DUE_EVENT);
    expect(emit.calls[0].payload.reservationId).toBe('r-due-1');
    // notified が更新された（二重通知防止）。
    expect(notifiedIds).toContain('r-due-1');
    // WhatsApp 失敗が記録され集計される。
    expect(result.whatsappFailures).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.notified).toBe(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test('WhatsApp 送信成功時は whatsappFailures が 0 で reservation:due も送出される', async () => {
    const emit = makeEmit();
    const { store, notifiedIds } = makeStore([dueReservation]);
    const svc = createNotificationService({
      store,
      emit,
      sendWhatsApp: async () => ({ ok: true }),
      clock: () => NOW,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollDueReservations();

    expect(emit.calls.length).toBe(1);
    expect(emit.calls[0].event).toBe(RESERVATION_DUE_EVENT);
    expect(notifiedIds).toContain('r-due-1');
    expect(result.whatsappFailures).toBe(0);
    expect(result.notified).toBe(1);
  });

  test('notify 単体でも WhatsApp 失敗時に画面通知イベントは送出される', async () => {
    const emit = makeEmit();
    const { store } = makeStore([]);
    const svc = createNotificationService({
      store,
      emit,
      sendWhatsApp: async () => { throw new Error('boom'); },
      logger: { error: () => {}, info: () => {} },
    });

    const { whatsappSent } = await svc.notify(dueReservation);

    expect(whatsappSent).toBe(false);
    expect(emit.calls.length).toBe(1);
    expect(emit.calls[0].event).toBe(RESERVATION_DUE_EVENT);
    expect(emit.calls[0].payload.contact).toBe(dueReservation.contact);
  });

  test('到来していない予約は通知されない（notified 更新も emit もなし）', async () => {
    const future = { ...dueReservation, reservationId: 'r-future', reservationTime: '2099-01-01T00:00:00.000Z' };
    const emit = makeEmit();
    const { store, notifiedIds } = makeStore([future]);
    const svc = createNotificationService({
      store,
      emit,
      sendWhatsApp: async () => ({ ok: true }),
      clock: () => NOW,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollDueReservations();
    expect(emit.calls.length).toBe(0);
    expect(notifiedIds.length).toBe(0);
    expect(result.processed).toBe(0);
  });

  test('markNotified が失敗しても他予約の処理は継続する', async () => {
    const r2 = { ...dueReservation, reservationId: 'r-due-2' };
    const emit = makeEmit();
    const store = {
      find: async () => [dueReservation, r2],
      markNotified: async (id) => {
        if (id === 'r-due-1') throw new Error('update fail');
        return { reservationId: id, notified: true };
      },
      save: async (r) => r,
      findById: async () => null,
      updateStatus: async () => null,
    };
    const svc = createNotificationService({
      store,
      emit,
      sendWhatsApp: async () => ({ ok: true }),
      clock: () => NOW,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollDueReservations();
    // 両方 emit される（画面通知は継続）。
    expect(emit.calls.length).toBe(2);
    // markNotified 成功は 1 件のみカウントされる。
    expect(result.notified).toBe(1);
    expect(result.processed).toBe(2);
  });
});

describe('Notification_Service リマインダー通知 (要件 3.1)', () => {
  test('WhatsApp 送信が失敗しても reservation:reminder は送出され reminderSent 更新される', async () => {
    const emit = makeEmit();
    const { store, reminderSentIds } = makeStore([reminderReservation]);
    const errors = [];
    const svc = createNotificationService({
      store,
      emit,
      sendReminderWhatsApp: async () => { throw new Error('WhatsApp API down'); },
      clock: () => NOW,
      reminderWindowMs: REMINDER_WINDOW_MS,
      logger: { error: (...a) => errors.push(a), info: () => {} },
    });

    const result = await svc.pollReminderReservations();

    // Socket.IO 画面通知は送出された（要件 3.4）。
    expect(emit.calls.length).toBe(1);
    expect(emit.calls[0].event).toBe(RESERVATION_REMINDER_EVENT);
    expect(emit.calls[0].payload.reservationId).toBe('r-reminder-1');
    // reminderSent が更新された（二重通知防止）。
    expect(reminderSentIds).toContain('r-reminder-1');
    // WhatsApp 失敗が記録され集計される。
    expect(result.whatsappFailures).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.reminded).toBe(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test('WhatsApp 送信成功時は whatsappFailures が 0 で reservation:reminder も送出される', async () => {
    const emit = makeEmit();
    const { store, reminderSentIds } = makeStore([reminderReservation]);
    const svc = createNotificationService({
      store,
      emit,
      sendReminderWhatsApp: async () => ({ ok: true }),
      clock: () => NOW,
      reminderWindowMs: REMINDER_WINDOW_MS,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollReminderReservations();

    expect(emit.calls.length).toBe(1);
    expect(emit.calls[0].event).toBe(RESERVATION_REMINDER_EVENT);
    expect(reminderSentIds).toContain('r-reminder-1');
    expect(result.whatsappFailures).toBe(0);
    expect(result.reminded).toBe(1);
  });

  test('notifyReminder 単体でも WhatsApp 失敗時に画面通知イベントは送出される', async () => {
    const emit = makeEmit();
    const { store } = makeStore([]);
    const svc = createNotificationService({
      store,
      emit,
      sendReminderWhatsApp: async () => { throw new Error('boom'); },
      logger: { error: () => {}, info: () => {} },
    });

    const { whatsappSent } = await svc.notifyReminder(reminderReservation);

    expect(whatsappSent).toBe(false);
    expect(emit.calls.length).toBe(1);
    expect(emit.calls[0].event).toBe(RESERVATION_REMINDER_EVENT);
    expect(emit.calls[0].payload.contact).toBe(reminderReservation.contact);
  });

  test('リマインダーウィンドウ外の予約は通知されない', async () => {
    const farFuture = {
      ...reminderReservation,
      reservationId: 'r-far-future',
      reservationTime: '2020-07-01T00:00:00.000Z', // 1 ヶ月後（24h ウィンドウ外）
    };
    const emit = makeEmit();
    const { store, reminderSentIds } = makeStore([farFuture]);
    const svc = createNotificationService({
      store,
      emit,
      sendReminderWhatsApp: async () => ({ ok: true }),
      clock: () => NOW,
      reminderWindowMs: REMINDER_WINDOW_MS,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollReminderReservations();
    expect(emit.calls.length).toBe(0);
    expect(reminderSentIds.length).toBe(0);
    expect(result.processed).toBe(0);
  });

  test('到来済み（過去）の予約はリマインダー対象外', async () => {
    const past = {
      ...reminderReservation,
      reservationId: 'r-past',
      reservationTime: '2020-05-01T00:00:00.000Z', // 過去
    };
    const emit = makeEmit();
    const { store, reminderSentIds } = makeStore([past]);
    const svc = createNotificationService({
      store,
      emit,
      sendReminderWhatsApp: async () => ({ ok: true }),
      clock: () => NOW,
      reminderWindowMs: REMINDER_WINDOW_MS,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollReminderReservations();
    expect(emit.calls.length).toBe(0);
    expect(reminderSentIds.length).toBe(0);
    expect(result.processed).toBe(0);
  });

  test('確定済みでない予約はリマインダー対象外', async () => {
    const pending = { ...reminderReservation, reservationId: 'r-pending', status: 'pending' };
    const emit = makeEmit();
    const { store, reminderSentIds } = makeStore([pending]);
    const svc = createNotificationService({
      store,
      emit,
      sendReminderWhatsApp: async () => ({ ok: true }),
      clock: () => NOW,
      reminderWindowMs: REMINDER_WINDOW_MS,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollReminderReservations();
    expect(emit.calls.length).toBe(0);
    expect(reminderSentIds.length).toBe(0);
    expect(result.processed).toBe(0);
  });

  test('リマインダー送信済みの予約は対象外', async () => {
    const sent = { ...reminderReservation, reservationId: 'r-sent', reminderSent: true };
    const emit = makeEmit();
    const { store, reminderSentIds } = makeStore([sent]);
    const svc = createNotificationService({
      store,
      emit,
      sendReminderWhatsApp: async () => ({ ok: true }),
      clock: () => NOW,
      reminderWindowMs: REMINDER_WINDOW_MS,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollReminderReservations();
    expect(emit.calls.length).toBe(0);
    expect(reminderSentIds.length).toBe(0);
    expect(result.processed).toBe(0);
  });

  test('markReminderSent が失敗しても他予約の処理は継続する', async () => {
    const r2 = { ...reminderReservation, reservationId: 'r-reminder-2' };
    const emit = makeEmit();
    const store = {
      find: async () => [reminderReservation, r2],
      markReminderSent: async (id) => {
        if (id === 'r-reminder-1') throw new Error('update fail');
        return { reservationId: id, reminderSent: true };
      },
      save: async (r) => r,
      findById: async () => null,
      updateStatus: async () => null,
    };
    const svc = createNotificationService({
      store,
      emit,
      sendReminderWhatsApp: async () => ({ ok: true }),
      clock: () => NOW,
      reminderWindowMs: REMINDER_WINDOW_MS,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollReminderReservations();
    // 両方 emit される（画面通知は継続）。
    expect(emit.calls.length).toBe(2);
    // markReminderSent 成功は 1 件のみカウントされる。
    expect(result.reminded).toBe(1);
    expect(result.processed).toBe(2);
  });
});

/**
 * 10分前リマインダーの回帰テスト
 *
 * 実障害（2026-10-05 15:30 JST の予約で 15:20 に WhatsApp が送られない）の検証。
 * 24時間前リマインダーと同じ reminderSent フラグを共有していたため、
 * 24時間前通知が送信済みの予約が10分前通知の対象から永久に除外されていた。
 */
describe('10分前リマインダー（pollTenMinReminderReservations）', () => {
  const TEN_MIN_WINDOW_MS = 10 * 60 * 1000;
  /** 15:30 JST = 06:30 UTC の予約。now は 06:20 UTC（ちょうど10分前）。 */
  const tenMinReservation = {
    reservationId: 'r-tenmin-1',
    contact: '+15551230000',
    reservationTime: '2020-06-01T06:30:00.000Z',
    sessionId: 'session-1',
    service: 'consultation',
    status: 'confirmed',
    language: 'ja',
    notified: false,
    reminderSent: false,
    tenMinReminderSent: false,
    assignedStaffId: 'staff-1',
  };
  const nowTenMin = new Date('2020-06-01T06:20:00.000Z');

  test('24時間前リマインダーが送信済みでも10分前通知を送る', async () => {
    // reminderSent: true = 24時間前通知が既に送られた状態。これが本次の原因。
    const alreadyReminded = { ...tenMinReservation, reminderSent: true };
    const emit = makeEmit();
    const { store, tenMinReminderSentIds } = makeStore([alreadyReminded]);
    const sent = [];

    const svc = createNotificationService({
      store,
      emit,
      joinLinkService: {
        issueForReservation: async () => ({ tokenId: 't1', url: 'https://example.test/join' }),
      },
      sendTenMinReminderWhatsApp: async (r, msg) => { sent.push(r.reservationId); return { ok: true }; },
      clock: () => nowTenMin,
      tenMinReminderWindowMs: TEN_MIN_WINDOW_MS,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollTenMinReminderReservations();

    expect(result.processed).toBe(1);
    expect(result.whatsappFailures).toBe(0);
    expect(sent).toEqual(['r-tenmin-1']);
    // 10分前フラグは獨立して更新される（24時間前フラグは汚さない）。
    expect(tenMinReminderSentIds).toEqual(['r-tenmin-1']);
  });

  test('10分前通知送信済みなら再送しない', async () => {
    const alreadyTenMin = { ...tenMinReservation, tenMinReminderSent: true };
    const emit = makeEmit();
    const { store, tenMinReminderSentIds } = makeStore([alreadyTenMin]);
    const sent = [];

    const svc = createNotificationService({
      store,
      emit,
      joinLinkService: {
        issueForReservation: async () => ({ tokenId: 't1', url: 'https://example.test/join' }),
      },
      sendTenMinReminderWhatsApp: async (r) => { sent.push(r.reservationId); return { ok: true }; },
      clock: () => nowTenMin,
      tenMinReminderWindowMs: TEN_MIN_WINDOW_MS,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollTenMinReminderReservations();

    expect(result.processed).toBe(0);
    expect(sent).toEqual([]);
    expect(tenMinReminderSentIds).toEqual([]);
  });

  test('10分前通知を2回ポーリングしても二重送信しない', async () => {
    const emit = makeEmit();
    const sent = [];
    // 実際のストア一样に、フラグ更新を反映する永続オブジェクトを作る。
    let stored = [tenMinReservation];
    const store = {
      find: async (filter) => {
        if (filter && filter.tenMinReminderSent !== undefined) {
          return stored.filter(
            (r) => r.tenMinReminderSent !== true && r.status === 'confirmed',
          );
        }
        return stored.filter((r) => r.reminderSent !== true && r.status === 'confirmed');
      },
      markTenMinReminderSent: async (id) => {
        stored = stored.map((r) => (r.reservationId === id ? { ...r, tenMinReminderSent: true } : r));
        return { reservationId: id, tenMinReminderSent: true };
      },
      markReminderSent: async (id) => ({ reservationId: id, reminderSent: true }),
      save: async (r) => r,
      findById: async () => null,
      updateStatus: async () => null,
    };

    const svc = createNotificationService({
      store,
      emit,
      joinLinkService: {
        issueForReservation: async () => ({ tokenId: 't1', url: 'https://example.test/join' }),
      },
      sendTenMinReminderWhatsApp: async (r) => { sent.push(r.reservationId); return { ok: true }; },
      clock: () => nowTenMin,
      tenMinReminderWindowMs: TEN_MIN_WINDOW_MS,
      logger: { error: () => {}, info: () => {} },
    });

    await svc.pollTenMinReminderReservations();
    await svc.pollTenMinReminderReservations();

    expect(sent).toEqual(['r-tenmin-1']);
  });

  test('WhatsApp 送信が失敗しても画面通知を送出し、他予約の処理は継続する', async () => {
    const r2 = { ...tenMinReservation, reservationId: 'r-tenmin-2' };
    const emit = makeEmit();
    const { store, tenMinReminderSentIds } = makeStore([tenMinReservation, r2]);
    const attempted = [];

    const svc = createNotificationService({
      store,
      emit,
      joinLinkService: {
        issueForReservation: async () => ({ tokenId: 't1', url: 'https://example.test/join' }),
      },
      sendTenMinReminderWhatsApp: async (r) => {
        attempted.push(r.reservationId);
        if (r.reservationId === 'r-tenmin-1') throw new Error('whatsapp down');
        return { ok: true };
      },
      clock: () => nowTenMin,
      tenMinReminderWindowMs: TEN_MIN_WINDOW_MS,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollTenMinReminderReservations();

    // 両方の WhatsApp 送信を試み、2件とも画面通知を出す。
    expect(attempted).toEqual(['r-tenmin-1', 'r-tenmin-2']);
    expect(emit.calls.length).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.whatsappFailures).toBe(1);
    expect(result.reminded).toBe(2);
    expect(tenMinReminderSentIds).toEqual(['r-tenmin-1', 'r-tenmin-2']);
  });

  test('pending 状態の予約には10分前通知を送らない', async () => {
    const pending = { ...tenMinReservation, status: 'pending' };
    const emit = makeEmit();
    const { store } = makeStore([pending]);
    const sent = [];

    const svc = createNotificationService({
      store,
      emit,
      joinLinkService: {
        issueForReservation: async () => ({ tokenId: 't1', url: 'https://example.test/join' }),
      },
      sendTenMinReminderWhatsApp: async (r) => { sent.push(r.reservationId); return { ok: true }; },
      clock: () => nowTenMin,
      tenMinReminderWindowMs: TEN_MIN_WINDOW_MS,
      logger: { error: () => {}, info: () => {} },
    });

    const result = await svc.pollTenMinReminderReservations();

    expect(result.processed).toBe(0);
    expect(sent).toEqual([]);
  });
});
