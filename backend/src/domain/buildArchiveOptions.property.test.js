import fc from 'fast-check';
import { buildArchiveOptions } from './buildArchiveOptions.js';
import { SUPPORTED_LANGUAGES } from './constants.js';

/**
 * Feature: vonage-video-reservation, Property 9: 文字起こし要時のアーカイブは必ず個別ストリームで有効化される
 *
 * For any 録画開始要求について、文字起こしを伴う場合（withTranscription === true）、
 * buildArchiveOptions の出力は必ず outputMode === 'individual' かつ hasTranscription === true
 * かつ hasAudio === true を満たす。
 *
 * Validates: Requirements 7.2, 8.1
 */

const sessionIdArb = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);

/** 録画開始要求ジェネレータ（withTranscription を含む多様なケース） */
const reqArb = fc.record(
  {
    sessionId: sessionIdArb,
    withTranscription: fc.oneof(fc.boolean(), fc.constant(undefined)),
    language: fc.oneof(fc.constantFrom(...SUPPORTED_LANGUAGES), fc.constant(undefined)),
    primaryLanguageCode: fc.oneof(
      fc.constantFrom('en-US', 'ja-JP', 'fr-FR'),
      fc.constant(undefined),
    ),
    hasVideo: fc.oneof(fc.boolean(), fc.constant(undefined)),
    hasAudio: fc.oneof(fc.boolean(), fc.constant(undefined)),
    name: fc.oneof(fc.string(), fc.constant(undefined)),
  },
  { requiredKeys: ['sessionId'] },
);

describe('Property 9: 文字起こし要時のアーカイブは必ず個別ストリームで有効化される (要件 7.2, 8.1)', () => {
  test('withTranscription===true のとき individual + hasTranscription + hasAudio が必ず成立', () => {
    fc.assert(
      fc.property(reqArb, (req) => {
        const options = buildArchiveOptions(req);

        expect(options.sessionId).toBe(req.sessionId);
        expect(typeof options.outputMode).toBe('string');

        if (req.withTranscription === true) {
          expect(options.outputMode).toBe('individual');
          expect(options.hasTranscription).toBe(true);
          expect(options.hasAudio).toBe(true);
          // primaryLanguageCode は必ず解決され非空
          expect(options.transcriptionProperties).toBeDefined();
          const code = options.transcriptionProperties.primaryLanguageCode;
          expect(typeof code).toBe('string');
          expect(code.length).toBeGreaterThan(0);
        } else {
          // 文字起こしなしのときは individual を強制しない（composed 既定）
          expect(options.outputMode).toBe('composed');
          expect(options.hasTranscription).toBeUndefined();
          expect(options.transcriptionProperties).toBeUndefined();
        }
      }),
      { numRuns: 300 },
    );
  });

  test('明示 primaryLanguageCode は優先される', () => {
    fc.assert(
      fc.property(
        sessionIdArb,
        fc.constantFrom('en-US', 'ja-JP', 'fr-FR'),
        (sessionId, code) => {
          const options = buildArchiveOptions({
            sessionId,
            withTranscription: true,
            primaryLanguageCode: code,
          });
          expect(options.transcriptionProperties.primaryLanguageCode).toBe(code);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('sessionId 欠落時は例外を送出する', () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(undefined), fc.constant(''), fc.constant('   ')), (bad) => {
        expect(() => buildArchiveOptions({ sessionId: bad, withTranscription: true })).toThrow();
      }),
      { numRuns: 50 },
    );
  });
});
