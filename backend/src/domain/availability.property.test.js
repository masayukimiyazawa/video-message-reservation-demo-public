import fc from 'fast-check';
import { checkAvailability } from './availability.js';

/**
 * Feature: vonage-video-reservation, Property 3: 空き判定は重複時に必ず代替を提示する
 *
 * For any 既存予約集合と任意の希望予約枠について、checkAvailability は希望枠が既存予約と
 * 重複するとき available: false と 1 つ以上の非重複な代替候補を返し、重複しないときのみ
 * available: true を返す。
 *
 * Validates: Requirements 1.5
 */

const toMs = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/** 半開区間 [start, end) の重複判定（テスト側の独立実装） */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** 希望枠が既存集合のいずれかと重複するか */
function conflictsAny(reqStart, reqEnd, existing) {
  return existing.some((ex) => overlaps(reqStart, reqEnd, toMs(ex.start), toMs(ex.end)));
}

const BASE = Date.UTC(2025, 0, 1, 0, 0, 0);

/** duration 分(分単位のオフセット)で slot を作る */
function makeSlot(startOffsetMin, durationMin) {
  const start = BASE + startOffsetMin * 60_000;
  const end = start + Math.max(durationMin, 1) * 60_000;
  return { start: new Date(start), end: new Date(end) };
}

/** 既存予約集合ジェネレータ */
const existingArb = fc.array(
  fc
    .record({
      startOffsetMin: fc.integer({ min: 0, max: 100_000 }),
      durationMin: fc.integer({ min: 1, max: 240 }),
    })
    .map(({ startOffsetMin, durationMin }) => makeSlot(startOffsetMin, durationMin)),
  { maxLength: 12 },
);

/** 希望枠ジェネレータ */
const requestedArb = fc
  .record({
    startOffsetMin: fc.integer({ min: 0, max: 100_000 }),
    durationMin: fc.integer({ min: 1, max: 240 }),
  })
  .map(({ startOffsetMin, durationMin }) => makeSlot(startOffsetMin, durationMin));

describe('Property 3: 空き判定は重複時に必ず代替を提示する (要件 1.5)', () => {
  test('重複時は available:false かつ非重複な代替を 1 件以上返す。非重複時のみ true', () => {
    fc.assert(
      fc.property(existingArb, requestedArb, (existing, requested) => {
        const result = checkAvailability(existing, requested);

        const reqStart = toMs(requested.start);
        const reqEnd = toMs(requested.end);
        const isConflict = conflictsAny(reqStart, reqEnd, existing);

        // available は実際の重複状態と厳密に一致する
        expect(result.available).toBe(!isConflict);

        if (isConflict) {
          // 代替は 1 件以上
          expect(Array.isArray(result.alternatives)).toBe(true);
          expect(result.alternatives.length).toBeGreaterThanOrEqual(1);
          // 各代替は既存予約のいずれとも重複しない
          for (const alt of result.alternatives) {
            expect(conflictsAny(toMs(alt.start), toMs(alt.end), existing)).toBe(false);
            // 代替枠は正しい向き（start < end）
            expect(toMs(alt.start)).toBeLessThan(toMs(alt.end));
          }
        } else {
          expect(result.alternatives).toEqual([]);
        }
      }),
      { numRuns: 300 },
    );
  });

  test('引数の既存配列を変更しない（純粋性）', () => {
    fc.assert(
      fc.property(existingArb, requestedArb, (existing, requested) => {
        const snapshot = JSON.stringify(existing);
        checkAvailability(existing, requested);
        expect(JSON.stringify(existing)).toBe(snapshot);
      }),
      { numRuns: 150 },
    );
  });
});
