/**
 * Vonage 実データの構造を再現した groupBySpeaker の回帰テスト。
 *
 * Feature: vonage-video-reservation, Property 10: 文字起こし整形は全発話を保存し話者に対応付ける
 *
 * Vonage Video API 実環境で取得した individual archive の
 * `transcription.zip` の構造を fixture にしている。
 * 録画・ジョブ・チャンネル識別子は架空の値に置き換えている。
 *
 * 実データで当初の想定と 3 点ずれていた（いずれもここで回帰を固定する）:
 *   1. セグメントはトップレベルではなく `transcription.segments` にある
 *   2. `channels_metadata` は配列ではなく、channel 番号をキーにしたオブジェクト
 *   3. `speaker_display_name` は JSON オブジェクトの二重エンコード文字列
 *
 * 従来これらは「実測値込みでテストが green」だったため検出されず、実環境では
 * 話者分離が常に空配列を返していた（UI は「完了」を表示しながら空の文字起こし）。
 *
 * Validates: Requirements 8.3
 */

import { groupBySpeaker } from './groupBySpeaker.js';

/**
 * 実環境の transcription.zip 内の JSON 構造を再現したダミー payload。
 * （このアーカイブでは発話が無かったため `segments` は空配列）
 */
const REAL_PAYLOAD_EMPTY_SEGMENTS = Object.freeze({
  job_id: '00000000-0000-4000-8000-000000000001',
  timestamp: '2026-09-25T10:29:01.724923',
  language: 'ja-JP',
  transcription: {
    provider: 'google',
    provider_version: '2.1.3',
    confidence: { overall: 0.5, channels: [0.5] },
    segments: [],
    number_of_channels: 1,
  },
  channels_metadata: {
    0: {
      id: '00000000-0000-4000-8000-000000000002',
      speaker_id: null,
      speaker_display_name: '{"role":"guest","displayName":"Guest"}',
    },
    1: {
      id: '00000000-0000-4000-8000-000000000003',
      speaker_id: null,
      speaker_display_name: '{"userId":"admin","role":"administrator"}',
    },
    2: {
      id: '00000000-0000-4000-8000-000000000004',
      speaker_id: null,
      speaker_display_name: '{"userId":"admin","role":"administrator"}',
    },
  },
  meta_data: {},
});

/** 同じ実構造のまま、発話セグメントだけ埋めたもの（発話が無かったアーカイブの挙動を再現するため） */
function withSegments(segments) {
  return {
    ...REAL_PAYLOAD_EMPTY_SEGMENTS,
    transcription: {
      ...REAL_PAYLOAD_EMPTY_SEGMENTS.transcription,
      confidence: { overall: 0.9, channels: [0.9, 0.9] },
      segments,
      number_of_channels: 2,
    },
  };
}

describe('groupBySpeaker: Vonage 実ペイロード (要件 8.3)', () => {
  test('実構造（segments 空）は空配列を返し、例外を投げない', () => {
    expect(groupBySpeaker(REAL_PAYLOAD_EMPTY_SEGMENTS)).toEqual([]);
  });

  test('実構造でも transcription.segments を拾って話者ごとにまとめる', () => {
    const raw = withSegments([
      { channel: 0, start: 0.1, end: 2.4, text: 'こんにちは' },
      { channel: 1, start: 2.6, end: 5.0, text: 'どうも、お元気ですか' },
      { channel: 0, start: 5.2, end: 7.1, text: 'はい、よろしくお願いします' },
    ]);

    const groups = groupBySpeaker(raw);

    // 従来はここで [] になり、セグメントを全件取りこぼしていた。
    expect(groups).toHaveLength(2);
    expect(groups.reduce((n, g) => n + g.segments.length, 0)).toBe(3);

    // キーが channel 番号なので、channel 0/1 が解決される
    expect(groups[0].channel).toBe(0);
    expect(groups[0].streamId).toBe('00000000-0000-4000-8000-000000000002');
    expect(groups[1].channel).toBe(1);
    expect(groups[1].streamId).toBe('00000000-0000-4000-8000-000000000003');
  });

  test('speaker_display_name の二重 JSON エンコードから表示名を復元する', () => {
    const raw = withSegments([{ channel: 0, start: 0, end: 1, text: 'やあ' }]);

    const [guest] = groupBySpeaker(raw);

    // '{"role":"guest","displayName":"Guest"}' -> 'Guest'
    expect(guest.speakerLabel).toBe('Guest');
  });

  test('表示名を持たない管理者は stream ID へフォールバックし、生 JSON を露出しない', () => {
    const raw = withSegments([{ channel: 1, start: 0, end: 1, text: 'こんにちは' }]);

    const [admin] = groupBySpeaker(raw);

    expect(admin.speakerLabel).toBe('00000000-0000-4000-8000-000000000003');
    expect(admin.speakerLabel).not.toContain('{');
  });

  test('後方互換形式（トップレベル segments + 配列 metadata）でも同じ結果になる', () => {
    const segments = [
      { channel: 0, start: 0.1, end: 2.4, text: 'こんにちは' },
      { channel: 1, start: 2.6, end: 5.0, text: 'どうも' },
    ];
    // 実形式と同じ情報を `name` で持たせた等価な入力（ラベル解決の結果を揃えるため）
    const legacy = {
      segments,
      channels_metadata: [
        { id: '00000000-0000-4000-8000-000000000002', name: 'Guest' },
        { id: '00000000-0000-4000-8000-000000000003' },
      ],
    };

    const fromLegacy = groupBySpeaker(legacy);
    const fromVonage = groupBySpeaker(withSegments(segments));

    // 等価な情報を持つ入力なら、出力は入力形式に依らず同一になる
    expect(fromLegacy).toEqual(fromVonage);
  });

  test('入力を変更しない（純粋性）', () => {
    const raw = withSegments([{ channel: 0, start: 0.1, end: 2.4, text: 'こんにちは' }]);
    const snapshot = JSON.stringify(raw);

    groupBySpeaker(raw);

    expect(JSON.stringify(raw)).toBe(snapshot);
  });
});
