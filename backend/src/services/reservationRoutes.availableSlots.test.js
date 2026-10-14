/**
 * GET /reservations/available-slots の「今日が 400 になる」不具合の回帰テスト
 *
 * 既往の不具合（実害）:
 *   サーバーが Asia/Tokyo で 15:00 JST 以降に動作していると、route 内の
 *   「今日」判定が JST 明日へずれる。その結果、JST 0:00 相当で处于する
 *   当日 (JST+0) のリクエストが 400 `Date out of range.` になり、
 *   管理画面の予約日時プルダウンが選択できない状態になっていた。
 *
 * なぜプロセス内テストでは再現しないか:
 *   ずれは「サーバー TZ が JST であること」と「JST 時刻が 15:00 以降」でしか
 *   発生しない。したがって子プロセスを TZ=Asia/Tokyo で起動し、
 *   さらに時計を固定する必要がある。ここでは両方を満たすハーネスを組む。
 *
 * 検証の要点:
 *   - JST+0 / +1 / +2 は 200
 *   - JST-1 / +3 は 400
 *   - 応答はサーバー TZ やプロセス TZ に依存しない
 *
 * @module services/reservationRoutes.availableSlots.test
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * TZ と固定時刻を指定して available-slots の応答コードを取得する子プロセス。
 *
 * 渡される nowIso は「JST での基準時刻」を表す。子プロセス内で
 * createReservationRouter に `now` を注入するため、テストから
 * 実行時刻に依存せず「今日」を決定できる。
 *
 * @param {string} tz 子プロセスの TZ
 * @param {string} nowIso 固定する基準 instant（ISO 8601）
 * @param {string} dateParam クエリの日付（YYYY-MM-DD）
 * @returns {Promise<{ status: number, json: object|null }>}
 */
async function queryAvailableSlots(tz, nowIso, dateParam, reservations = []) {
  const harness = `
    import http from 'node:http';
    import express from 'express';
    import { createReservationRouter } from ${JSON.stringify(
      path.join(__dirname, 'reservationRoutes.js'),
    )};

    // 実装が Date.now() を直接呼んでも再現できるよう、時計を固定する。
    // （依存注入 now: だけだと、Date.now() を直接読む旧実装では再現しない）
    const FIXED = new Date(${JSON.stringify(nowIso)}).getTime();
    const RealDate = Date;
    globalThis.Date = class FrozenDate extends RealDate {
      constructor(...args) {
        super(...(args.length === 0 ? [FIXED] : args));
      }
      static now() { return FIXED; }
    };

    const app = express();
    app.use('/reservations', createReservationRouter({
      reservationService: {
        async listReservations() {
          return { ok: true, reservations: ${JSON.stringify(reservations)} };
        },
      },
      authorize: () => (_req, _res, next) => next(),
      now: () => new globalThis.Date(FIXED),
    }));

    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      http.get({ host: '127.0.0.1', port, path: '/reservations/available-slots?date=' + ${JSON.stringify(
        dateParam,
      )} }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          server.close(() => {
            process.stdout.write(JSON.stringify({
              status: res.statusCode,
              json: data ? JSON.parse(data) : null,
            }));
          });
        });
      }).on('error', (e) => { server.close(); throw e; });
    });
  `;

  const out = execFileSync(process.execPath, ['--input-type=module', '-e', harness], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf-8',
    timeout: 15000,
  });
  return JSON.parse(out);
}

// 2026-10-02T08:40Z = JST 2026-10-02 17:40。
// 修正前の getNowJst() は「JST 壁時計の現在時刻」をさらに +9h ずらすため、
// JST 時刻が 15:00 以降だと日付が繰り上がり「今日」を JST 明日と誤判定していた。
// その結果 JST 2026-10-02（= JST+0）が 400 になっていた。
const NOW_AFTER_15_JST = '2026-10-02T08:40:00.000Z';
// JST 2026-10-02 の 0:00 相当 = UTC 2026-10-01T15:00Z
const JST_TODAY = '2026-10-02';
const TZS = ['Asia/Tokyo', 'UTC', 'America/New_York'];

describe('services reservationRoutes（GET /available-slots の日付範囲）', () => {
  test.each(TZS)('JST 15:00 以降でも %s で当日(JST+0)が 200', async (tz) => {
    const { status, json } = await queryAvailableSlots(tz, NOW_AFTER_15_JST, JST_TODAY);

    // 修正前は 400 になっていた（TIMEZONE 依存で再現）。
    expect(status).toBe(200);
    expect(Array.isArray(json.slots)).toBe(true);
  });

  test.each(TZS)('%s で JST+1 が 200', async (tz) => {
    const { status } = await queryAvailableSlots(tz, NOW_AFTER_15_JST, '2026-10-03');
    expect(status).toBe(200);
  });

  test.each(TZS)('%s で JST+2 が 200', async (tz) => {
    const { status } = await queryAvailableSlots(tz, NOW_AFTER_15_JST, '2026-10-04');
    expect(status).toBe(200);
  });

  test.each(TZS)('%s で JST+3 は 400（3日超は拒否）', async (tz) => {
    const { status, json } = await queryAvailableSlots(tz, NOW_AFTER_15_JST, '2026-10-05');
    expect(status).toBe(400);
    expect(json.error).toMatch(/out of range/i);
  });

  test.each(TZS)('%s で JST-1 は 400（過去日は拒否）', async (tz) => {
    const { status } = await queryAvailableSlots(tz, NOW_AFTER_15_JST, '2026-10-01');
    expect(status).toBe(400);
  });

  test.each(TZS)('%s で不正な日付形式は 400', async (tz) => {
    const { status } = await queryAvailableSlots(tz, NOW_AFTER_15_JST, 'not-a-date');
    expect(status).toBe(400);
  });

  test('日付欠落は 400', async () => {
    const { status } = await queryAvailableSlots('Asia/Tokyo', NOW_AFTER_15_JST, '');
    expect(status).toBe(400);
  });

  test.each(TZS)('%s で当日(JST+0)のスロットが date/time 付きで返る', async (tz) => {
    // 回帰: フロントは表示 title ではなく date|time を予約作成に使う。
    // 17:40 JST は 15:30 より後なので multiDay フォールバック（3日分）になる。
    const { status, json } = await queryAvailableSlots(tz, NOW_AFTER_15_JST, JST_TODAY);
    expect(status).toBe(200);
    expect(json.slots.length).toBeGreaterThan(0);
    for (const slot of json.slots) {
      expect(slot.time).toMatch(/^\d{2}:\d{2}$/);
      // 応答中のスロットはすべて当日(JST+0) 起点の3日ぶん
      expect(['2026-10-02', '2026-10-03', '2026-10-04']).toContain(slot.date);
      // 最初のスロットが当日であること
    }
    expect(json.slots[0].date).toBe(JST_TODAY);
  });

  test.each(TZS)('%s で JST+1 は全スロットが対象日の date になる', async (tz) => {
    const { status, json } = await queryAvailableSlots(tz, NOW_AFTER_15_JST, '2026-10-03');
    expect(status).toBe(200);
    expect(json.slots).toHaveLength(4);
    for (const slot of json.slots) {
      expect(slot.time).toMatch(/^\d{2}:\d{2}$/);
      expect(slot.date).toBe('2026-10-03');
    }
  });

  test('当日が past なら3日分のスロットがそれぞれ正しい date を持つ', async () => {
    // 17:40 JST は 15:30 より後なので multiDay フォールバックになる。
    const { status, json } = await queryAvailableSlots(
      'Asia/Tokyo',
      NOW_AFTER_15_JST,
      JST_TODAY,
    );
    expect(status).toBe(200);
    // 12 件 = 3 日 x 4 スロット、date は 3 日ぶん只会う。
    expect(json.slots).toHaveLength(12);
    expect([...new Set(json.slots.map((s) => s.date))]).toEqual([
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
  });

  test('予約済みの時刻は title ではなく time で除外される', async () => {
    // 回帰: title 付きスロットと 'HH:MM' の予約済み集合を比較していたため、
    // multiDay では常に不一致で予約済みなのに表示された。
    const { json } = await queryAvailableSlots(
      'Asia/Tokyo',
      NOW_AFTER_15_JST,
      JST_TODAY,
      [{ reservationTime: '2026-10-03T00:00:00.000Z' }], // = JST 10/3 09:00
    );
    // JST 10/3 09:00 のスロットは消える。
    expect(json.slots.some((s) => s.date === '2026-10-03' && s.time === '09:00')).toBe(false);
    // 同じ時刻の別日は残る。
    expect(json.slots.some((s) => s.date === '2026-10-02' && s.time === '09:00')).toBe(true);
  });

  test('JST 0:00 直後でも当日が 200（JST 境界がまたいでもずれない）', async () => {
    // 2026-10-01T15:01Z = JST 2026-10-02 00:01。JST 0:00 をまたいだ直後。
    const { status } = await queryAvailableSlots('Asia/Tokyo', '2026-10-01T15:01:00.000Z', '2026-10-02');
    expect(status).toBe(200);
  });

  test('UTC 15:00（JST 0:00）ちょうどでも当日が 200', async () => {
    // 2026-10-01T15:00Z = JST 2026-10-02 00:00 ちょうど。
    const { status } = await queryAvailableSlots('Asia/Tokyo', '2026-10-01T15:00:00.000Z', '2026-10-02');
    expect(status).toBe(200);
  });
});
