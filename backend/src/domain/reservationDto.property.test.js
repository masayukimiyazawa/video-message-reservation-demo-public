import fc from 'fast-check';
import { buildReservationDTO } from './reservationDto.js';
import { ConversationStep, SUPPORTED_LANGUAGES } from './constants.js';

/**
 * Feature: vonage-video-reservation, Property 2: 完了会話からの予約 DTO は必須フィールドを備える
 *
 * For any 予約完了状態の会話について、buildReservationDTO が生成する予約 DTO は
 * 連絡先・予約時刻・対象サービス・対応言語のすべてを含む。
 *
 * Validates: Requirements 1.2, 1.3
 */

/** 予約時刻: Date または解析可能な ISO 文字列 */
const reservationTimeArb = fc.oneof(
  fc
    .date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2100-01-01T00:00:00.000Z') })
    .filter((d) => !Number.isNaN(d.getTime())),
  fc
    .date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2100-01-01T00:00:00.000Z') })
    .filter((d) => !Number.isNaN(d.getTime()))
    .map((d) => d.toISOString()),
);

/** 完了した会話状態ジェネレータ（必須 4 フィールドを満たす） */
const completedStateArb = fc.record({
  step: fc.constant(ConversationStep.COMPLETED),
  contact: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  reservationTime: reservationTimeArb,
  service: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  language: fc.constantFrom(...SUPPORTED_LANGUAGES),
  // 余分なフィールドが混ざっていても DTO には 4 フィールドのみ抽出される
  selectedDate: fc.option(fc.string(), { nil: undefined }),
});

describe('Property 2: 完了会話からの予約 DTO は必須フィールドを備える (要件 1.2, 1.3)', () => {
  test('生成 DTO は連絡先・予約時刻・対象サービス・対応言語を必ず含む', () => {
    fc.assert(
      fc.property(completedStateArb, (state) => {
        const dto = buildReservationDTO(state);

        expect(dto).toBeDefined();

        // 連絡先
        expect(typeof dto.contact).toBe('string');
        expect(dto.contact.trim().length).toBeGreaterThan(0);

        // 予約時刻（Date または解析可能な値）
        expect(dto.reservationTime).toBeDefined();
        const millis =
          dto.reservationTime instanceof Date
            ? dto.reservationTime.getTime()
            : new Date(dto.reservationTime).getTime();
        expect(Number.isNaN(millis)).toBe(false);

        // 対象サービス
        expect(typeof dto.service).toBe('string');
        expect(dto.service.trim().length).toBeGreaterThan(0);

        // 対応言語 ∈ {en, ja}
        expect(SUPPORTED_LANGUAGES).toContain(dto.language);

        // 入力値が保存されている
        expect(dto.contact).toBe(state.contact);
        expect(dto.service).toBe(state.service);
        expect(dto.reservationTime).toBe(state.reservationTime);
        expect(dto.language).toBe(state.language);
      }),
      { numRuns: 200 },
    );
  });

  test('入力状態を変更しない（純粋性）', () => {
    fc.assert(
      fc.property(completedStateArb, (state) => {
        const snapshot = JSON.stringify(state);
        buildReservationDTO(state);
        expect(JSON.stringify(state)).toBe(snapshot);
      }),
      { numRuns: 100 },
    );
  });
});
