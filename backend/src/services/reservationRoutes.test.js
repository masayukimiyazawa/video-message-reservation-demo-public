/**
 * reservationRoutes テスト（HTTP レベル / 予約削除）
 *
 * 既存規約に従い supertest は導入せず、Node 標準 http で実サーバーを立てて往復する。
 * authorize は注入してバイパスし、認可そのものは authMiddleware.test.js の責務とする。
 * ここでは「DELETE /reservations/:id が存在し、サービスの結果コードを
 * 正しい HTTP ステータスへ写すこと」を検証する。
 *
 * @module services/reservationRoutes.test
 */

import http from 'node:http';

import express from 'express';

import { createReservationRouter } from './reservationRoutes.js';
import { ReservationErrorCode } from './reservationService.js';

/** authorize をバイパスするパススルーミドルウェア（テスト用）。 */
const passThroughAuthorize = () => (_req, _res, next) => next();

/**
 * テスト用 app を組み立てる。
 * @param {object} [opts]
 * @param {object} [opts.reservationService] 差し込むサービス
 * @returns {{ app: import('express').Express, calls: object }}
 */
function makeApp({ reservationService } = {}) {
  const calls = { deleted: [] };

  const service = reservationService ?? {
    async deleteReservation(id) {
      calls.deleted.push(id);
      return { ok: true, reservation: { reservationId: id } };
    },
    async listReservations() {
      return { ok: true, reservations: [] };
    },
  };

  const app = express();
  app.use(express.json());
  app.use(
    '/reservations',
    createReservationRouter({ reservationService: service, authorize: passThroughAuthorize }),
  );
  // ハンドラから next(err) された場合の最終エラーハンドラ。
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error', message: err?.message });
  });
  return { app, calls };
}

/**
 * DELETE /reservations/:id を送る（Node 標準 http）。
 * @param {import('express').Express} app
 * @param {string} id 予約 ID
 * @returns {Promise<{ status: number, json: object|null }>}
 */
function deleteReservation(app, id) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'DELETE',
          path: `/reservations/${encodeURIComponent(id)}`,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            server.close(() => {
              resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null });
            });
          });
        },
      );
      req.on('error', (err) => server.close(() => reject(err)));
      req.end();
    });
  });
}

describe('services reservationRoutes（DELETE /reservations/:id）', () => {
  test('予約を削除して 200 と予約情報を返す', async () => {
    const { app, calls } = makeApp();

    const { status, json } = await deleteReservation(app, 'r-1');

    expect(status).toBe(200);
    expect(json).toEqual({ reservation: { reservationId: 'r-1' } });
    expect(calls.deleted).toEqual(['r-1']);
  });

  test('not_found は 404 に写す', async () => {
    const { app } = makeApp({
      reservationService: {
        async deleteReservation() {
          return { ok: false, code: ReservationErrorCode.NOT_FOUND };
        },
      },
    });

    const { status, json } = await deleteReservation(app, 'missing');

    expect(status).toBe(404);
    expect(json).toMatchObject({ ok: false, code: ReservationErrorCode.NOT_FOUND });
  });

  test('store_error は 500 に写す', async () => {
    const { app } = makeApp({
      reservationService: {
        async deleteReservation() {
          return { ok: false, code: ReservationErrorCode.STORE_ERROR, message: 'MongoDB down' };
        },
      },
    });

    const { status } = await deleteReservation(app, 'r-1');

    expect(status).toBe(500);
  });

  test('サービスの例外は next(err) へ渡し 500 になる', async () => {
    const { app } = makeApp({
      reservationService: {
        async deleteReservation() {
          throw new Error('boom');
        },
      },
    });

    const { status, json } = await deleteReservation(app, 'r-1');

    expect(status).toBe(500);
    expect(json).toMatchObject({ error: 'internal_error', message: 'boom' });
  });

  test('PATCH（キャンセル）が従来どおり 200 を返す', async () => {
    const { app } = makeApp({
      reservationService: {
        async cancelReservation(id) {
          return { ok: true, reservation: { reservationId: id, status: 'cancelled' } };
        },
        async listReservations() {
          return { ok: true, reservations: [] };
        },
      },
    });

    const { status, json } = await new Promise((resolve, reject) => {
      const server = http.createServer(app);
      server.listen(0, () => {
        const { port } = server.address();
        const payload = JSON.stringify({ status: 'cancelled' });
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'PATCH',
            path: '/reservations/r-2',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              server.close(() => {
                resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null });
              });
            });
          },
        );
        req.on('error', (err) => server.close(() => reject(err)));
        req.write(payload);
        req.end();
      });
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ reservation: { reservationId: 'r-2', status: 'cancelled' } });
  });
});
