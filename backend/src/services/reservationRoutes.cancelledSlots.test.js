/**
 * キャンセル（削除）済み予約が参照系に残っていた不具合の回帰テスト
 *
 * 既往の不具合（実害）:
 *   管理画面の「予約済みスロット」一覧から削除した予約が削除後も表示され続け、
 *   同じ予約が「予約可能時間帯」からも除外された（= 永久に再予約できない）。
 *
 *   原因: キャンセル済み除外の規則が空き判定（toExistingSlots）にしかなく、
 *   GET /booked-slots と GET /available-slots は listReservations({}) の
 *   全件をそのまま扱っていた。削除ボタンは status='cancelled' への
 *   ソフト削除（PATCH）なので、レコードは残り両エンドポイントにも現れた。
 *
 * 検証の要点:
 *   - GET /booked-slots      … キャンセル済みを除外し、有効状態は従来どおり返す
 *   - GET /available-slots   … キャンセル済みは枠を占有しない（予約可能に戻る）
 *
 * 既存規約に従い supertest は導入せず、Node 標準 http で実サーバーを立てて往復する。
 * authorize は注入してバイパスする。
 *
 * @module services/reservationRoutes.cancelledSlots.test
 */

import http from 'node:http';

import express from 'express';

import { createReservationRouter } from './reservationRoutes.js';

/** authorize をバイパスするパススルーミドルウェア（テスト用）。 */
const passThroughAuthorize = () => (_req, _res, next) => next();

/** JST 2026-10-05 14:00 = UTC 2026-10-05T05:00Z */
const REPORTED_SLOT_UTC = '2026-10-05T05:00:00.000Z';
const REPORTED_DATE = '2026-10-05';

/**
 * GET /available-slots のテストで使う固定基準時刻。
 * = JST 2026-10-05 09:00。
 *
 * 「今日」は現在時刻より後のスロットしか返らないため、実行時刻に依存しないよう
 * 時計を固定し、対象日は JST 明日（day_2 = 全スロットが必ず返る）に置く。
 */
const FIXED_NOW_UTC = '2026-10-05T00:00:00.000Z';
/** JST 2026-10-06 14:00 = UTC 2026-10-06T05:00Z */
const TOMORROW_SLOT_UTC = '2026-10-06T05:00:00.000Z';
const TOMORROW_DATE = '2026-10-06';

/**
 * 実サーバーへ GET を送って JSON を取得する。
 * @param {import('express').Express} app
 * @param {string} path リクエストパス
 * @returns {Promise<{ status: number, json: object|null }>}
 */
function get(app, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      http
        .get({ host: '127.0.0.1', port, path }, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            server.close(() => {
              resolve({
                status: res.statusCode,
                json: data ? JSON.parse(data) : null,
              });
            });
          });
        })
        .on('error', (err) => {
          server.close();
          reject(err);
        });
    });
  });
}

/**
 * 予約リストを固定したテスト用 app を組み立てる。
 * @param {object[]} reservations
 * @param {Date} [now] 基準時刻を固定する（GET /available-slots の「今日」判定用）
 * @returns {import('express').Express}
 */
function makeApp(reservations, now) {
  const app = express();
  app.use(express.json());
  app.use(
    '/reservations',
    createReservationRouter({
      reservationService: {
        async listReservations() {
          return { ok: true, reservations };
        },
      },
      authorize: passThroughAuthorize,
      ...(now ? { now: () => now } : {}),
    }),
  );
  return app;
}

/** 予約レコードを作る（既定値は有効状態）。 */
function reservation(overrides = {}) {
  return {
    reservationId: 'r-1',
    reservationTime: REPORTED_SLOT_UTC,
    contact: '+81 902 1664 411',
    service: 'telemedicine',
    status: 'confirmed',
    language: 'ja',
    ...overrides,
  };
}

describe('services reservationRoutes（キャンセル済み予約の除外）', () => {
  describe('GET /booked-slots', () => {
    test('削除（キャンセル）済み予約を「予約済みスロット」に返さない', async () => {
      // 報告された事象: 削除済みなのに 2026-10-05 14:00 の行が表示され続けていた。
      const app = makeApp([reservation({ status: 'cancelled' })]);

      const { status, json } = await get(
        app,
        `/reservations/booked-slots?date=${REPORTED_DATE}`,
      );

      expect(status).toBe(200);
      expect(json.slots).toEqual([]);
    });

    test('確定済み予約は従来どおり「予約済みスロット」に返す', async () => {
      const app = makeApp([reservation({ status: 'confirmed' })]);

      const { status, json } = await get(
        app,
        `/reservations/booked-slots?date=${REPORTED_DATE}`,
      );

      expect(status).toBe(200);
      expect(json.slots).toHaveLength(1);
      expect(json.slots[0]).toMatchObject({
        time: '14:00',
        contact: '+81 902 1664 411',
        service: 'telemedicine',
        status: 'confirmed',
      });
    });

    test('完了（completed）済み予約は「予約済みスロット」に残る', async () => {
      // completed は枠を占有済みなので従来どおり表示対象。
      // 削除は cancelled への遷移であり completed は削除扱いしない。
      const app = makeApp([reservation({ status: 'completed' })]);

      const { json } = await get(app, `/reservations/booked-slots?date=${REPORTED_DATE}`);

      expect(json.slots).toHaveLength(1);
      expect(json.slots[0].status).toBe('completed');
    });

    test('キャンセル済みと有効状態が混在する場合、有効状態のみ返す', async () => {
      const app = makeApp([
        reservation({ reservationId: 'r-cancelled', status: 'cancelled' }),
        reservation({ reservationId: 'r-confirmed', status: 'confirmed' }),
        reservation({ reservationId: 'r-pending', status: 'pending' }),
      ]);

      const { json } = await get(app, `/reservations/booked-slots?date=${REPORTED_DATE}`);

      expect(json.slots.map((s) => s.reservationId).sort()).toEqual([
        'r-confirmed',
        'r-pending',
      ]);
    });
  });

  describe('GET /available-slots', () => {
    test('キャンセル済み予約のスロットは予約可能に戻る', async () => {
      // 修正前はキャンセル済みでも枠を占有していたため再予約できなかった。
      // 対象日は JST 明日（現在時刻に依存せず全スロットが返る）とする。
      const app = makeApp(
        [
          reservation({
            reservationId: 'r-cancelled',
            status: 'cancelled',
            reservationTime: TOMORROW_SLOT_UTC,
          }),
        ],
        new Date(FIXED_NOW_UTC),
      );

      const { status, json } = await get(
        app,
        `/reservations/available-slots?date=${TOMORROW_DATE}`,
      );

      expect(status).toBe(200);
      expect(json.slots.some((s) => s.date === TOMORROW_DATE && s.time === '14:00')).toBe(true);
    });

    test('確定済み予約のスロットは予約可能なまま除外される', async () => {
      const app = makeApp(
        [
          reservation({
            reservationId: 'r-confirmed',
            status: 'confirmed',
            reservationTime: TOMORROW_SLOT_UTC,
          }),
        ],
        new Date(FIXED_NOW_UTC),
      );

      const { status, json } = await get(
        app,
        `/reservations/available-slots?date=${TOMORROW_DATE}`,
      );

      expect(status).toBe(200);
      expect(json.slots.some((s) => s.date === TOMORROW_DATE && s.time === '14:00')).toBe(false);
      // 同じ日の他のスロットは残る（時刻単位の除外であり日全体を除外しない）。
      expect(json.slots.some((s) => s.date === TOMORROW_DATE && s.time === '09:00')).toBe(true);
    });
  });
});
