import fc from 'fast-check';
import { selectReminderReservations } from './selectReminderReservations.js';

/**
 * Feature: vonage-video-reservation, Property: リマインダー対象選択はウィンドウ内かつ未送信・確定済みに限定される
 *
 * For any 予約集合と任意の現在時刻・ウィンドウについて、selectReminderReservations が返す集合は、
 * - reservationTime > now (将来)
 * - reservationTime - now <= windowMs (ウィンドウ内)
 * - reminderSent != true (未送信)
 * - status === 'confirmed' (確定済み)
 * を満たす予約と厳密に一致する。
 *
 * Validates: Requirements 3.1
 */

const toMs = (v) => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return new Date(v).getTime();
  return NaN;
};

const BASE = Date.UTC(2025, 0, 1, 0, 0, 0);

const reservationTimeArb = fc.integer({ min: -100_000, max: 100_000 }).chain((offsetMin) => {
  const ms = BASE + offsetMin * 60_000;
  return fc.constantFrom(new Date(ms), new Date(ms).toISOString(), ms);
});

const reservationArb = fc.record({
  reservationId: fc.string({ minLength: 1 }),
  reservationTime: reservationTimeArb,
  reminderSent: fc.oneof(fc.boolean(), fc.constant(undefined)),
  status: fc.constantFrom('pending', 'confirmed', 'cancelled', 'completed'),
});

const reservationsArb = fc.array(reservationArb, { maxLength: 20 });

const nowArb = fc.integer({ min: -100_000, max: 100_000 }).chain((offsetMin) => {
  const ms = BASE + offsetMin * 60_000;
  return fc.constantFrom(new Date(ms), new Date(ms).toISOString(), ms);
});

const windowArb = fc.integer({ min: 1, max: 7 * 24 * 60 * 60 * 1000 });

function expectedReminders(reservations, now, windowMs) {
  const nowMs = toMs(now);
  return reservations.filter((r) => {
    if (r == null) return false;
    if (r.reminderSent === true) return false;
    if (r.status !== 'confirmed') return false;
    const rMs = toMs(r.reservationTime);
    if (Number.isNaN(rMs)) return false;
    if (rMs <= nowMs) return false;
    return rMs - nowMs <= windowMs;
  });
}

describe('Property: リマインダー対象選択はウィンドウ内かつ未送信・確定済みに限定される (要件 3.1)', () => {
  test('返り値は reservationTime > now かつ reservationTime - now <= windowMs かつ reminderSent != true かつ status === confirmed の予約と厳密に一致', () => {
    fc.assert(
      fc.property(reservationsArb, nowArb, windowArb, (reservations, now, windowMs) => {
        const result = selectReminderReservations(reservations, now, windowMs);
        const expected = expectedReminders(reservations, now, windowMs);

        expect(result).toEqual(expected);

        const nowMs = toMs(now);
        for (const r of result) {
          expect(r.reminderSent).not.toBe(true);
          expect(r.status).toBe('confirmed');
          const rMs = toMs(r.reservationTime);
          expect(rMs).toBeGreaterThan(nowMs);
          expect(rMs - nowMs).toBeLessThanOrEqual(windowMs);
        }
      }),
      { numRuns: 300 },
    );
  });

  test('非配列/不正な now では空配列を返す', () => {
    expect(selectReminderReservations(null, BASE)).toEqual([]);
    expect(selectReminderReservations(undefined, BASE)).toEqual([]);
    expect(selectReminderReservations([{ reservationTime: BASE, status: 'confirmed' }], 'not-a-date')).toEqual([]);
  });

  test('入力配列を変更しない（純粋性）', () => {
    fc.assert(
      fc.property(reservationsArb, nowArb, windowArb, (reservations, now, windowMs) => {
        const snapshot = JSON.stringify(reservations);
        selectReminderReservations(reservations, now, windowMs);
        expect(JSON.stringify(reservations)).toBe(snapshot);
      }),
      { numRuns: 100 },
    );
  });

  test('windowMs が負/ゼロの場合は既定の 24h にフォールバックする', () => {
    const future = BASE + 12 * 60 * 60 * 1000; // 12時間後
    const reservations = [
      { reservationId: 'r1', reservationTime: future, status: 'confirmed', reminderSent: false },
    ];
    const result = selectReminderReservations(reservations, BASE, -1);
    expect(result.length).toBe(1);
  });
});