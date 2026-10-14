/**
 * buildTimeOptions / startOfJstDayUtc のタイムゾーン回帰テスト
 *
 * 実害のあった不具合（サーバーが JST のとき 15:00 以降に「今日」が明日へずれる、
 * 結果として /reservations/available-slots が当日を 400 で拒否する）の再発を防ぐ。
 *
 * 検証の要点:
 *  - startOfJstDayUtc はローカル TZ に依存せず JST 暦日 0:00 を返す
 *  - buildTimeOptions の「今日」は JST 暦日 기준으로判定される
 *  - スロットの 09:00 は JST 09:00 として現在時刻と比較される
 *
 * プロセス TZ に依存しないよう、各ケースは TZ 環境変数を差し替えて実行する。
 *
 * @module domain/conversation.timeSlots.test
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 指定した TZ のもとでconversation.js を読み込み、buildTimeOptions を実行する。
 * ローカル時刻の getDate()/setHours() が混ざると TZ で結果が変わるため、
 * TZ を明示した子プロセスで評価して「TZ 非依存であること」自体を検証する。
 *
 * @param {string} tz タイムゾーン（例: 'Asia/Tokyo', 'UTC', 'America/New_York'）
 * @param {string} script 評価する ESM スナップショット
 * @returns {any} 評価結果（JSON 化可能な値）
 */
function runInTz(tz, script) {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      env: { ...process.env, TZ: tz },
      encoding: 'utf-8',
    },
  );
  return JSON.parse(out);
}

/** conversation.js を import し、2 つの関数を JSON で返すテンプレート。 */
function script(body) {
  return `
    import { buildTimeOptions, startOfJstDayUtc, JST_OFFSET_MS } from ${JSON.stringify(
      path.join(__dirname, 'conversation.js'),
    )};
    const jstOpts = (nowIso) => ({
      startOfToday: startOfJstDayUtc(nowIso),
      dayBasisOffsetMs: JST_OFFSET_MS,
    });
    const out = (${body});
    process.stdout.write(JSON.stringify(out));
  `;
}

describe('domain conversation: buildTimeOptions のタイムゾーン非依存性', () => {
  // 2026-10-01T17:40Z = JST 2026-10-02 02:40。JST サーバーではローカル日付が 10-02 になる。
  const NOW = '2026-10-01T17:40:00.000Z';
  const TZS = ['Asia/Tokyo', 'UTC', 'America/New_York'];

  test.each(TZS)('startOfJstDayUtc は %s でも JST 暦日 0:00 を返す', (tz) => {
    const result = runInTz(
      tz,
      script(`startOfJstDayUtc('${NOW}').toISOString()`),
    );
    // JST 2026-10-02 0:00 = UTC 2026-10-01T15:00:00Z
    expect(result).toBe('2026-10-01T15:00:00.000Z');
  });

  test.each(TZS)('「今日(day_1)」は %s でも 400 相当外となり全スロットを返す', (tz) => {
    // JST 10-02 が今日なので、day_1 は 10-02。02:40 JST より後なので 09:00 以降のみ。
    const result = runInTz(
      tz,
      script(`buildTimeOptions('${NOW}', 'day_1', jstOpts('${NOW}')).map(s => s.title)`),
    );
    expect(result).toEqual(['09:00', '10:30', '14:00', '15:30']);
  });

  test.each(TZS)('%s でも「基準日の終了後は全スロット」へフォールバック', (tz) => {
    // now = JST 2026-10-01 16:00 なので 15:30 は既に過去 → multiDay 表示へ落ちる。
    const LATE = '2026-10-01T07:00:00.000Z';
    const result = runInTz(
      tz,
      script(`buildTimeOptions('${LATE}', 'day_1', jstOpts('${LATE}')).map(s => s.title)`),
    );
    // ラベルは JST 暦日表記（10/1, 10/2, 10/3）
    expect(result).toContain('10/1 09:00');
    expect(result).toContain('10/3 15:30');
    expect(result).toHaveLength(12);
  });

  test.each(TZS)('%s でも既定（UTC 暦日）パスは chatbot フローと整合する', (tz) => {
    // startOfToday を渡さない既定経路は buildDateOptions / resolveReservationDateTime と
    // 同じ UTC 暦日規則を使う。now 未指定でも throw しない。
    const result = runInTz(tz, script(`buildTimeOptions(undefined, 'day_2').map(s => s.title)`));
    expect(result).toEqual(['09:00', '10:30', '14:00', '15:30']);
  });

  test.each(TZS)('明日は %s でも全スロットを返す', (tz) => {
    const result = runInTz(
      tz,
      script(`buildTimeOptions('${NOW}', 'day_2', jstOpts('${NOW}')).map(s => s.title)`),
    );
    expect(result).toEqual(['09:00', '10:30', '14:00', '15:30']);
  });
});

describe('domain conversation: buildTimeOptions の date/time フィールド', () => {
  // 回帰: フロントは option value に「表示タイトル」ではなく date|time を使う。
  // multiDay の title は 'M/D HH:MM' で年を含まないため、title を解析すると
  // Number('10/2 09') => NaN となり予約作成が失敗していた。
  const LATE = '2026-10-01T07:00:00.000Z'; // JST 2026-10-01 16:00 → multiDay 経路

  test('multiDay スロットは title と別に date/time を持つ', async () => {
    const { buildTimeOptions, startOfJstDayUtc, JST_OFFSET_MS } = await import(
      './conversation.js'
    );
    const slots = buildTimeOptions(LATE, 'day_1', {
      startOfToday: startOfJstDayUtc(LATE),
      dayBasisOffsetMs: JST_OFFSET_MS,
    });

    expect(slots).toHaveLength(12);
    for (const slot of slots) {
      // time は必ず 'HH:MM'（title を Parsing したものではない）
      expect(slot.time).toMatch(/^\d{2}:\d{2}$/);
      // date は年を含む 'YYYY-MM-DD'
      expect(slot.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // title は表示専用で、日付ラベル + time と一致する
      expect(slot.title).toMatch(new RegExp(`^\\d+/\\d+ ${slot.time}$`));
      // id には day オフセットが含まれる
      expect(slot.id).toMatch(/_day\d$/);
    }

    // 1件目: JST 10/1 09:00
    expect(slots[0]).toMatchObject({ title: '10/1 09:00', time: '09:00', date: '2026-10-01' });
    // 最終: JST 10/3 15:30
    expect(slots[11]).toMatchObject({ title: '10/3 15:30', time: '15:30', date: '2026-10-03' });
  });

  test('単一日のスロットも date/time を持つ（title と time は一致）', async () => {
    const { buildTimeOptions, startOfJstDayUtc, JST_OFFSET_MS } = await import(
      './conversation.js'
    );
    const NOW = '2026-10-01T17:40:00.000Z'; // JST 2026-10-02 02:40
    const slots = buildTimeOptions(NOW, 'day_2', {
      startOfToday: startOfJstDayUtc(NOW),
      dayBasisOffsetMs: JST_OFFSET_MS,
    });

    expect(slots).toHaveLength(4);
    for (const slot of slots) {
      expect(slot.title).toBe(slot.time);
      expect(slot.date).toBe('2026-10-03'); // JST+1
    }
  });

  test('不正な selectedDate でも date/time を返す', async () => {
    const { buildTimeOptions } = await import('./conversation.js');
    const slots = buildTimeOptions('2026-10-01T00:00:00.000Z', 'garbage');
    expect(slots).toHaveLength(4);
    for (const slot of slots) {
      expect(slot.time).toMatch(/^\d{2}:\d{2}$/);
      expect(slot.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('domain conversation: startOfJstDayUtc', () => {
  test('JST 0:00 を UTC instant で返す', async () => {
    const { startOfJstDayUtc } = await import('./conversation.js');
    // 2026-10-01T20:00Z = JST 2026-10-02 05:00 → JST 0:00 = 2026-10-01T15:00Z
    expect(startOfJstDayUtc('2026-10-01T20:00:00.000Z').toISOString()).toBe(
      '2026-10-01T15:00:00.000Z',
    );
  });

  test('JST 0:00 をまたぐ時刻でも同じ日を返す', async () => {
    const { startOfJstDayUtc } = await import('./conversation.js');
    // 2026-10-01T14:59Z = JST 2026-10-01 23:59 → JST 0:00 = 2026-09-30T15:00Z
    expect(startOfJstDayUtc('2026-10-01T14:59:00.000Z').toISOString()).toBe(
      '2026-09-30T15:00:00.000Z',
    );
  });

  test('不正値は RangeError を投げる', async () => {
    const { startOfJstDayUtc } = await import('./conversation.js');
    expect(() => startOfJstDayUtc('not-a-date')).toThrow(RangeError);
  });
});
