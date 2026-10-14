import fc from 'fast-check';
import {
  validateReservation,
  REQUIRED_RESERVATION_FIELDS,
} from './validateReservation.js';
import { RESERVATION_STATUSES, SUPPORTED_LANGUAGES } from './constants.js';

/**
 * Feature: vonage-video-reservation, Property 5: 予約レコードのバリデーション
 *
 * For any 予約レコードについて、validateReservation は必須フィールドがすべて存在し
 * language ∈ {en, ja} の場合にのみ検証を通過し、いずれかが欠落または不正な言語の場合は拒否する。
 *
 * Validates: Requirements 2.2, 6.4
 */

/** 「存在する」とみなせる（欠落でない）判定：ソースの isPresent と同一規則 */
function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/** フィールド値ジェネレータ: 存在する値と欠落値の両方を含む */
const presentStringArb = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);
const maybeMissingArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant(''),
  fc.constant('   '),
  presentStringArb,
);

/** 予約レコードジェネレータ（各必須フィールドが存在/欠落を取りうる） */
const recordArb = fc.record({
  reservationId: maybeMissingArb,
  contact: maybeMissingArb,
  reservationTime: fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    presentStringArb,
    fc.date().filter((d) => !Number.isNaN(d.getTime())),
  ),
  service: maybeMissingArb,
  status: fc.oneof(fc.constant(undefined), fc.constant(null), fc.constantFrom(...RESERVATION_STATUSES)),
  language: fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constantFrom(...SUPPORTED_LANGUAGES),
    fc.constantFrom('xx', 'EN', 'jp', 'fr'),
  ),
});

/** レコードが「有効であるべき」かをテスト側で独立計算する */
function expectedValid(record) {
  const allPresent = REQUIRED_RESERVATION_FIELDS.every((f) => isPresent(record[f]));
  const langOk = SUPPORTED_LANGUAGES.includes(record.language);
  return allPresent && langOk;
}

describe('Property 5: 予約レコードのバリデーション (要件 2.2, 6.4)', () => {
  test('必須フィールド全存在かつ language ∈ {en, ja} のときのみ valid: true', () => {
    fc.assert(
      fc.property(recordArb, (record) => {
        const result = validateReservation(record);
        expect(result.valid).toBe(expectedValid(record));
        expect(Array.isArray(result.errors)).toBe(true);
        // 有効なら errors 空、無効なら 1 件以上
        if (result.valid) {
          expect(result.errors).toEqual([]);
        } else {
          expect(result.errors.length).toBeGreaterThanOrEqual(1);
        }
      }),
      { numRuns: 300 },
    );
  });

  test('完全に有効なレコードは常に通過する', () => {
    const validRecordArb = fc.record({
      reservationId: presentStringArb,
      contact: presentStringArb,
      reservationTime: presentStringArb,
      service: presentStringArb,
      status: fc.constantFrom(...RESERVATION_STATUSES),
      language: fc.constantFrom(...SUPPORTED_LANGUAGES),
    });
    fc.assert(
      fc.property(validRecordArb, (record) => {
        const result = validateReservation(record);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  test('不正な言語は language:invalid を報告して拒否する', () => {
    const invalidLangRecordArb = fc.record({
      reservationId: presentStringArb,
      contact: presentStringArb,
      reservationTime: presentStringArb,
      service: presentStringArb,
      status: fc.constantFrom(...RESERVATION_STATUSES),
      language: fc.constantFrom('xx', 'EN', 'jp', 'fr', 'english'),
    });
    fc.assert(
      fc.property(invalidLangRecordArb, (record) => {
        const result = validateReservation(record);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('language:invalid');
      }),
      { numRuns: 100 },
    );
  });

  test('null / 非オブジェクト入力は拒否する', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer(), fc.string()),
        (bad) => {
          const result = validateReservation(bad);
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
