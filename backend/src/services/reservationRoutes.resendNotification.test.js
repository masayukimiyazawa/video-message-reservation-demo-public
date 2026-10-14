/**
 * reservationRoutes テスト（HTTP レベル / 手動再通知）
 *
 * 既存規約に従い supertest は導入せず、Node 標準 http で実サーバーを立てて往復する。
 * authorize は注入してバイパスし、認可そのものは authMiddleware.test.js の責務とする。
 * ここでは「POST /reservations/:id/resend-notification が通知サービスへ委譲し、
 * 結果を正しい HTTP ステータスへ写すこと」を検証する。
 *
 * @module services/reservationRoutes.resendNotification.test
 */

import http from 'node:http';

import express from 'express';

import { createReservationRouter } from './reservationRoutes.js';

/** authorize をバイパスするパススルーミドルウェア（テスト用）。 */
const passThroughAuthorize = () => (_req, _res, next) => next();

const BASE_RESERVATION = {
  reservationId: 'r-1',
  contact: '819012345678',
  status: 'confirmed',
  service: 'Consultation',
  language: 'ja',
  sessionId: 'sess-1',
  reservationTime: '2026-10-03T01:30:00.000Z',
};

/**
 * テスト用 app を組み立てる。
 * @param {object} [opts]
 * @param {object[]} [opts.reservations] 一覧から返す予約
 * @param {object} [opts.notificationResult] sendManualJoinLink の戻り値
 * @returns {{ app: import('express').Express, calls: { resent: object[] } }}
 */
function makeApp({ reservations = [BASE_RESERVATION], notificationResult } = {}) {
  const calls = { resent: [] };

  const reservationService = {
    async listReservations() {
      return { ok: true, reservations };
    },
  };

  const notificationService = {
    async sendManualJoinLink(reservation) {
      calls.resent.push(reservation);
      if (notificationResult) return notificationResult;
      return { whatsappSent: true, joinUrl: 'https://example.test/join/tok-1' };
    },
  };

  const app = express();
  app.use(express.json());
  app.use(
    '/reservations',
    createReservationRouter({
      reservationService,
      notificationService,
      authorize: passThroughAuthorize,
    }),
  );
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error', message: err?.message });
  });
  return { app, calls };
}

/**
 * POST /reservations/:id/resend-notification を送る。
 * @param {import('express').Express} app
 * @param {string} id 予約 ID
 * @returns {Promise<{ status: number, json: object|null }>}
 */
function resendNotification(app, id) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/reservations/${encodeURIComponent(id)}/resend-notification`,
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

describe('services reservationRoutes（POST /reservations/:id/resend-notification）', () => {
  test('通知サービスへ委譲して 200 と joinUrl を返す', async () => {
    const { app, calls } = makeApp();

    const { status, json } = await resendNotification(app, 'r-1');

    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, joinUrl: 'https://example.test/join/tok-1' });
    // 対象予約がそのまま渡られていること
    expect(calls.resent).toHaveLength(1);
    expect(calls.resent[0]).toMatchObject({ reservationId: 'r-1', contact: '819012345678' });
  });

  test('存在しない予約は 404（通知を送らない）', async () => {
    const { app, calls } = makeApp();

    const { status, json } = await resendNotification(app, 'missing');

    expect(status).toBe(404);
    expect(json).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls.resent).toEqual([]);
  });

  test('キャンセル済み予約は 409（通知を送らない）', async () => {
    const { app, calls } = makeApp({
      reservations: [{ ...BASE_RESERVATION, status: 'cancelled' }],
    });

    const { status, json } = await resendNotification(app, 'r-1');

    expect(status).toBe(409);
    expect(json).toMatchObject({ ok: false, code: 'reservation_cancelled' });
    expect(calls.resent).toEqual([]);
  });

  test('WhatsApp 送信失敗は 502 に写す', async () => {
    const { app } = makeApp({ notificationResult: { whatsappSent: false, joinUrl: '' } });

    const { status, json } = await resendNotification(app, 'r-1');

    expect(status).toBe(502);
    expect(json).toMatchObject({ ok: false, code: 'notification_failed' });
  });
});
