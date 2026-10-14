/**
 * buildDateOptions / SELECT_DATE 具体日付タイトルのユニットテスト（要件 1.1）
 *
 * WhatsApp ユーザーに提示される予約日の選択肢が、静的な "Day 1/2/3" ではなく現在時刻
 * (now) を基準にした具体的な日付タイトル（en: "YYYY-MM-DD (Www)" / ja: "M月D日(W)"）に
 * なることを検証する。id は 'day_N' のまま維持され、resolveReservationDateTime が
 * 選択日を正しくオフセット解決できることを確認する。
 */

import {
  buildDateOptions,
  nextStep,
  resolveReservationDateTime,
  DATE_OPTIONS,
} from './conversation.js';
import { ConversationStep, OutMessageType } from './constants.js';

describe('buildDateOptions（具体日付の選択肢生成 / 要件 1.1）', () => {
  test('en: 基準日 now から day_1..day_3 の ISO 日付 + 曜日タイトルを生成する', () => {
    // 2025-06-10 は火曜日(Tue)。day_1=当日, day_2=+1日(Wed), day_3=+2日(Thu)。
    const now = '2025-06-10T12:34:56.000Z';
    const options = buildDateOptions(now, 'en');

    expect(options).toEqual([
      { id: 'day_1', title: '2025-06-10 (Tue)' },
      { id: 'day_2', title: '2025-06-11 (Wed)' },
      { id: 'day_3', title: '2025-06-12 (Thu)' },
    ]);
  });

  test('ja: 基準日 now から M月D日(W) タイトルを生成する', () => {
    const now = '2025-06-10T12:34:56.000Z';
    const options = buildDateOptions(now, 'ja');

    expect(options).toEqual([
      { id: 'day_1', title: '6月10日(火)' },
      { id: 'day_2', title: '6月11日(水)' },
      { id: 'day_3', title: '6月12日(木)' },
    ]);
  });

  test('id は day_N のまま維持され、DATE_OPTIONS の件数と一致する', () => {
    const options = buildDateOptions('2026-09-26T00:00:00.000Z', 'en');
    expect(options.map((o) => o.id)).toEqual(['day_1', 'day_2', 'day_3']);
    expect(options).toHaveLength(DATE_OPTIONS.length);
  });

  test('count 引数で件数を変えられる', () => {
    const options = buildDateOptions('2026-09-26T00:00:00.000Z', 'en', 5);
    expect(options).toHaveLength(5);
    expect(options[4]).toEqual({ id: 'day_5', title: '2026-09-30 (Wed)' });
  });

  test('決定的・純粋: 同じ now で同じ結果、Date.now() に依存しない', () => {
    const now = '2026-09-26T23:59:59.999Z';
    const a = buildDateOptions(now, 'en');
    const b = buildDateOptions(now, 'en');
    expect(a).toEqual(b);
    // 具体的な期待値（2026-09-26 は土曜日 Sat）。
    expect(a[0]).toEqual({ id: 'day_1', title: '2026-09-26 (Sat)' });
  });

  test('UTC で計算され、resolveReservationDateTime の解決日とタイトルが一致する', () => {
    const now = '2025-06-10T12:34:56.000Z';
    const options = buildDateOptions(now, 'en');
    // day_2 のタイトル日付部（2025-06-11）と、同 id を slot 00:00 で解決した日付が一致。
    // slot_0000 = 00:00 JST = 15:00 UTC 前日なので、日付は前日 (2025-06-10) になる。
    const iso = resolveReservationDateTime('day_2', 'slot_0000', now);
    expect(iso.slice(0, 10)).toBe('2025-06-10');
    // タイトルは JST 日付 (2025-06-11) だが、UTC 日付は前日になる。
    // options[1].title は JST 日付なので '2025-06-11' で始まる。
    expect(options[1].title.startsWith('2025-06-11')).toBe(true);
  });

  test('now 未指定時は決定的基準日 (2000-01-01) にフォールバックする', () => {
    // 2000-01-01 は土曜日(Sat)。
    const options = buildDateOptions(undefined, 'en');
    expect(options[0]).toEqual({ id: 'day_1', title: '2000-01-01 (Sat)' });
  });
});

describe('SELECT_SERVICE → SELECT_DATE で具体日付タイトルが提示される（要件 1.1）', () => {
  test('en: SELECT_DATE メッセージの options が具体日付タイトルを持ち id は day_N', () => {
    const now = '2025-06-10T00:00:00.000Z';
    const { nextState, outMessage } = nextStep(
      { step: ConversationStep.SELECT_SERVICE, language: 'en' },
      { value: 'consultation', language: 'en', now },
    );

    expect(nextState.step).toBe(ConversationStep.SELECT_DATE);
    expect(outMessage.type).toBe(OutMessageType.LIST);
    expect(outMessage.options.map((o) => o.id)).toEqual(['day_1', 'day_2', 'day_3']);
    // 具体日付（静的 "Day 1" ではない）。
    expect(outMessage.options[0].title).toBe('2025-06-10 (Tue)');
    for (const opt of outMessage.options) {
      expect(opt.title).toContain('2025');
      expect(opt.title).not.toMatch(/^Day \d+$/);
    }
  });

  test('ja: SELECT_DATE メッセージの options が日本語の具体日付タイトルを持つ', () => {
    const now = '2025-06-10T00:00:00.000Z';
    const { outMessage } = nextStep(
      { step: ConversationStep.SELECT_SERVICE, language: 'ja' },
      { value: 'consultation', language: 'ja', now },
    );

    expect(outMessage.options[0].title).toBe('6月10日(火)');
    expect(outMessage.options.map((o) => o.id)).toEqual(['day_1', 'day_2', 'day_3']);
  });
});
