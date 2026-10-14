import fc from 'fast-check';
import { selectDueReservations } from './selectDueReservations.js';

/**
 * Feature: vonage-video-reservation, Property 6: 到来予約の選択は期限到来かつ未通知に限定される
 *
 * For any 予約集合と任意の現在時刻について、selectDueReservations が返す集合は、
 * reservationTime <= now かつ notified == false である予約と厳密に一致する。
 *
 * Validates: Requirements 3.1, 3.2
 */

const toMs = (v) => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return new Date(v).getTime();
  return NaN;
};

const BASE = Date.UTC(2025, 0, 1, 0, 0, 0);

/** reservationTime: Date / ISO 文字列 / エポック数値 のいずれか */
const reservationTimeArb = fc.integer({ min: -100_000, max: 100_000 }).chain((offsetMin) => {
  const ms = BASE + offsetMin * 60_000;
  return fc.constantFrom(new Date(ms), new Date(ms).toISOString(), ms);
});

const reservationArb = fc.record({
  reservationId: fc.string({ minLength: 1 }),
  reservationTime: reservationTimeArb,
  notified: fc.oneof(fc.boolean(), fc.constant(undefined)),
});

const reservationsArb = fc.array(reservationArb, { maxLength: 20 });

/** now: Date / ISO 文字列 / エポック数値 */
const nowArb = fc.integer({ min: -100_000, max: 100_000 }).chain((offsetMin) => {
  const ms = BASE + offsetMin * 60_000;
  return fc.constantFrom(new Date(ms), new Date(ms).toISOString(), ms);
});

/** テスト側で独立に「到来かつ未通知」を計算 */
function expectedDue(reservations, now) {
  const nowMs = toMs(now);
  return reservations.filter((r) => {
    if (r == null) return false;
    if (r.notified === true) return false;
    const rMs = toMs(r.reservationTime);
    if (Number.isNaN(rMs)) return false;
    return rMs <= nowMs;
  });
}

describe('Property 6: 到来予約の選択は期限到来かつ未通知に限定される (要件 3.1, 3.2)', () => {
  test('返り値は reservationTime <= now かつ notified != true の予約と厳密に一致', () => {
    fc.assert(
      fc.property(reservationsArb, nowArb, (reservations, now) => {
        const result = selectDueReservations(reservations, now);
        const expected = expectedDue(reservations, now);

        // 同一集合・同一順序（入力順保持）
        expect(result).toEqual(expected);

        // 個別条件の確認
        const nowMs = toMs(now);
        for (const r of result) {
          expect(r.notified).not.toBe(true);
          expect(toMs(r.reservationTime)).toBeLessThanOrEqual(nowMs);
        }
      }),
      { numRuns: 300 },
    );
  });

  test('非配列/不正な now では空配列を返す', () => {
    expect(selectDueReservations(null, BASE)).toEqual([]);
    expect(selectDueReservations(undefined, BASE)).toEqual([]);
    expect(selectDueReservations([{ reservationTime: BASE }], 'not-a-date')).toEqual([]);
  });

  test('入力配列を変更しない（純粋性）', () => {
    fc.assert(
      fc.property(reservationsArb, nowArb, (reservations, now) => {
        const snapshot = JSON.stringify(reservations);
        selectDueReservations(reservations, now);
        expect(JSON.stringify(reservations)).toBe(snapshot);
      }),
      { numRuns: 100 },
    );
  });
});
