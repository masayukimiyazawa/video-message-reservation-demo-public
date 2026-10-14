import fc from 'fast-check';
import { groupBySpeaker } from './groupBySpeaker.js';

/**
 * Feature: vonage-video-reservation, Property 10: 文字起こし整形は全発話を保存し話者に対応付ける
 *
 * For any 有効な Post-Call Transcription JSON について、groupBySpeaker の出力に含まれる
 * 発話セグメントは元 JSON の全セグメントと過不足なく一致し、各セグメントは
 * channels_metadata で解決可能な話者（stream ID）に対応付けられる。
 *
 * Validates: Requirements 8.3
 */

/** セグメントジェネレータ（channel は数値 or 欠落 -> -1 扱い） */
const segmentArb = fc.record(
  {
    channel: fc.oneof(fc.integer({ min: 0, max: 5 }), fc.constant(undefined)),
    start: fc.double({ min: 0, max: 10000, noNaN: true }),
    end: fc.double({ min: 0, max: 10000, noNaN: true }),
    text: fc.string(),
  },
  { requiredKeys: ['start', 'end', 'text'] },
);

/**
 * channels_metadata 要素（後方互換の配列形式想定用）。
 * 配列位置ではなく明示 `channel` で解決されるため、channel を持たせられる。
 */
const metaArb = fc.record(
  {
    id: fc.string({ minLength: 1 }),
    channel: fc.oneof(fc.integer({ min: 0, max: 5 }), fc.constant(undefined)),
    speakerLabel: fc.oneof(fc.string({ minLength: 1 }), fc.constant(undefined)),
  },
  { requiredKeys: ['id'] },
);

/**
 * channels_metadata 要素（Vonage 実形式）。
 *
 * 実測データでは要素は `id` / `speaker_id` / `speaker_display_name` のみを持ち、
 * **明示的な `channel` フィールドは存在しない**（キーが channel 番号を表す）。
 * 実データに忠実に従い、ここでは `channel` を生成しない。
 */
const vonageMetaArb = fc.record(
  {
    id: fc.string({ minLength: 1 }),
    speaker_id: fc.oneof(fc.string({ minLength: 1 }), fc.constant(null)),
    speaker_display_name: fc.oneof(
      fc.constant(undefined),
      fc.constant(JSON.stringify({ role: 'guest', displayName: 'Guest' })),
      fc.constant(JSON.stringify({ userId: 'admin', role: 'administrator' })),
      fc.constant('not-json'),
    ),
  },
  { requiredKeys: ['id'] },
);

/**
 * Vonage 実構造の生 JSON ジェネレータ。
 *
 * 実測（2026-09-25・individual archive・ja-JP）に基づく:
 *  - セグメントは `transcription.segments` に配置される（トップレベルではない）
 *  - `channels_metadata` は channel 番号をキーにしたオブジェクト（配列ではない）
 *  - 要素は明示 `channel` を持たない
 *  - `speaker_display_name` は JSON オブジェクトの二重エンコード文字列のことがある
 *
 * 当初このテストはトップレベル `segments` + 配列 `channels_metadata` を生成しており、
 * Vonage 実データとの不整合を検出できていなかった（実データでは常に空になるため
 * プロパティが自明に成立してしまう）。実構造で生成する。
 */
const vonageRawJsonArb = fc
  .array(vonageMetaArb, { maxLength: 6 })
  .chain((metas) =>
    fc.record({
      job_id: fc.string({ minLength: 1 }),
      language: fc.constantFrom('ja-JP', 'en-US'),
      transcription: fc.record({
        provider: fc.constant('google'),
        segments: fc.array(segmentArb, { maxLength: 30 }),
        number_of_channels: fc.nat({ max: 6 }),
      }),
      // 実データは「キーが channel 番号」のオブジェクト
      channels_metadata: fc.constant(Object.fromEntries(metas.map((meta, idx) => [String(idx), meta]))),
      meta_data: fc.record({}),
    }),
  );

/** 後方互換形式（トップレベル segments + 配列 channels_metadata）のジェネレータ */
const legacyRawJsonArb = fc.record({
  segments: fc.array(segmentArb, { maxLength: 30 }),
  channels_metadata: fc.array(metaArb, { maxLength: 6 }),
});

/** Vonage 実構造から入力セグメントを取り出す */
function inputSegmentsOf(raw) {
  return raw.transcription.segments.filter((s) => s != null);
}

/** 出力に含まれる総セグメント数 */
function totalSegments(groups) {
  return groups.reduce((sum, g) => sum + g.segments.length, 0);
}

describe('Property 10: 文字起こし整形は全発話を保存し話者に対応付ける (要件 8.3)', () => {
  test('Vonage 実構造: 全セグメントが過不足なく保存され、channel ごとに正しくまとめられる', () => {
    fc.assert(
      fc.property(vonageRawJsonArb, (raw) => {
        const groups = groupBySpeaker(raw);

        const inputSegments = inputSegmentsOf(raw);

        // 総セグメント数が一致（欠落・重複なし）
        expect(totalSegments(groups)).toBe(inputSegments.length);

        // channel 番号は一意（各 channel につき 1 グループ）
        const channels = groups.map((g) => g.channel);
        expect(new Set(channels).size).toBe(channels.length);

        // 各グループのセグメントは正規化された {start, end, text} を持つ
        for (const g of groups) {
          expect(typeof g.channel).toBe('number');
          expect(typeof g.streamId).toBe('string');
          expect(typeof g.speakerLabel).toBe('string');
          for (const seg of g.segments) {
            expect(Object.keys(seg).sort()).toEqual(['end', 'start', 'text']);
          }
        }

        // 各入力セグメントは対応する channel グループに入っている
        for (const seg of inputSegments) {
          const ch = typeof seg.channel === 'number' ? seg.channel : -1;
          const group = groups.find((g) => g.channel === ch);
          expect(group).toBeDefined();
          const found = group.segments.some(
            (s) => s.start === seg.start && s.end === seg.end && s.text === seg.text,
          );
          expect(found).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  test('Vonage 実構造: speaker_display_name の生 JSON がラベルに漏れない', () => {
    fc.assert(
      fc.property(vonageRawJsonArb, (raw) => {
        for (const g of groupBySpeaker(raw)) {
          // 実構造ではキーが channel 番号を表す
          const meta = raw.channels_metadata[String(g.channel)];
          if (!meta) {
            continue;
          }
          // 明示ラベルが無い場合のみ、speaker_display_name から解決される
          const hasExplicit = [meta.speakerLabel, meta.name, meta.label].some(
            (v) => typeof v === 'string' && v.length > 0,
          );
          if (hasExplicit) {
            continue;
          }
          const rawDisplay = meta.speaker_display_name;
          if (typeof rawDisplay !== 'string' || !rawDisplay.trim().startsWith('{')) {
            continue;
          }
          let decoded;
          try {
            decoded = JSON.parse(rawDisplay);
          } catch {
            continue;
          }
          const displayName = decoded?.displayName;
          if (typeof displayName === 'string' && displayName.length > 0) {
            // 復号された表示名が採用される（二重エンコードが解ける）
            expect(g.speakerLabel).toBe(displayName);
          } else {
            // 表示名が無ければ stream ID へフォールバック（生 JSON を露出しない）
            expect(g.speakerLabel).toBe(String(meta.id));
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  test('後方互換形式: トップレベル segments + 配列 channels_metadata でも同じ結果になる', () => {
    fc.assert(
      fc.property(legacyRawJsonArb, (raw) => {
        const groups = groupBySpeaker(raw);
        expect(totalSegments(groups)).toBe(raw.segments.filter((s) => s != null).length);
      }),
      { numRuns: 200 },
    );
  });

  test('Vonage 実構造: channels_metadata のキー（channel 番号）から stream ID が解決される', () => {
    // メタデータのキーとセグメントの channel を一致させる
    const alignedArb = fc
      .array(fc.record({ id: fc.string({ minLength: 1 }) }), { minLength: 1, maxLength: 4 })
      .chain((metas) =>
        fc.record({
          channels_metadata: fc.constant(Object.fromEntries(metas.map((m, idx) => [String(idx), m]))),
          transcription: fc.record({
            segments: fc.array(
              fc.record({
                channel: fc.integer({ min: 0, max: metas.length - 1 }),
                start: fc.double({ min: 0, max: 100, noNaN: true }),
                end: fc.double({ min: 0, max: 100, noNaN: true }),
                text: fc.string(),
              }),
              { minLength: 1, maxLength: 20 },
            ),
          }),
        }),
      );

    fc.assert(
      fc.property(alignedArb, (raw) => {
        const groups = groupBySpeaker(raw);
        for (const g of groups) {
          // channel はメタデータのキーに対応 -> id が stream ID として解決される
          const meta = raw.channels_metadata[String(g.channel)];
          if (meta) {
            expect(g.streamId).toBe(String(meta.id));
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  test('入力を変更しない（純粋性）', () => {
    fc.assert(
      fc.property(vonageRawJsonArb, (raw) => {
        const snapshot = JSON.stringify(raw);
        groupBySpeaker(raw);
        expect(JSON.stringify(raw)).toBe(snapshot);
      }),
      { numRuns: 100 },
    );
  });
});
