/**
 * reservationRoutes（GET /reservations/:id/archives）回帰テスト
 *
 * 「終了後に録画ファイルがダウンロードできない」不具合の核心。
 * 元コミット 65f5951 で追加された予約単位の録画一覧は、Vonage の `url` を
 * フロントが期待する `downloadUrl` へマッピングする。この契約を固定する。
 *
 * 検証の要点:
 *   - Vonage の url → downloadUrl、id → archiveId にマップされる
 *   - 予約の sessionId に紐づくアーカイブのみ返す
 *   - 予約が存在しなければ 404
 *
 * @module services/reservationRoutes.archives.test
 */

import http from 'node:http';

import express from 'express';

import { createReservationRouter } from './reservationRoutes.js';

const passThroughAuthorize = () => (_req, _res, next) => next();

function makeApp({ reservationService, videoClient }) {
  const app = express();
  app.use(express.json());
  app.use(
    '/reservations',
    createReservationRouter({ reservationService, videoClient, authorize: passThroughAuthorize }),
  );
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_error', message: err?.message });
  });
  return app;
}

function get(app, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        { host: '127.0.0.1', port, method: 'GET', path },
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

const RESERVATION = {
  reservationId: 'r-1',
  sessionId: 'sess-1',
  contact: '819012345678',
  service: 'Consultation',
  status: 'confirmed',
  language: 'ja',
  reservationTime: '2026-10-03T01:30:00.000Z',
};

describe('GET /reservations/:id/archives', () => {
  test('Vonage の url を downloadUrl に、id を archiveId にマッピングして返す', async () => {
    const app = makeApp({
      reservationService: {
        async listReservations() {
          return { ok: true, reservations: [RESERVATION] };
        },
      },
      videoClient: {
        async getArchivesBySessionIdWithMock(sessionId) {
          // getArchivesBySessionIdWithMock はセッションで絞り込んだ配列を返す契約。
          return [
            {
              id: 'arch-1',
              sessionId,
              url: 'https://example.test/rec-1.mp4',
              name: 'rec-1',
              status: 'available',
              duration: 60000,
              createdAt: '2026-10-03T02:00:00.000Z',
            },
          ];
        },
      },
    });

    const { status, json } = await get(app, '/reservations/r-1/archives');

    expect(status).toBe(200);
    expect(json.archives).toHaveLength(1);
    expect(json.archives[0]).toMatchObject({
      id: 'arch-1',
      archiveId: 'arch-1',
      url: 'https://example.test/rec-1.mp4',
      downloadUrl: 'https://example.test/rec-1.mp4',
    });
  });

  test('予約が存在しなければ 404 を返す', async () => {
    const app = makeApp({
      reservationService: {
        async listReservations() {
          return { ok: true, reservations: [] };
        },
      },
      videoClient: {
        async getArchivesBySessionIdWithMock() {
          return [];
        },
      },
    });

    const { status, json } = await get(app, '/reservations/missing/archives');

    expect(status).toBe(404);
    expect(json).toMatchObject({ error: 'Reservation not found' });
  });
});
