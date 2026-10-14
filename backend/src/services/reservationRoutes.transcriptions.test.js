/**
 * reservationRoutes（GET /reservations/:id/transcriptions）回帰テスト
 *
 * 実害の不具合:
 *   videoClient.getArchivesBySessionIdWithMock はアーカイブ配列を返すのに、
 *   ルート側が { ok, archives } 形式として扱っていたため `!result.ok` が常に真になり、
 *   文字起こし一覧が常に 500 になっていた。
 *
 * 検証の要点:
 *   - 配列を返す videoClient に対して 200 と { transcriptions: [...] } を返す
 *   - セッション不一致・文字起こし無しは除外する
 *   - 予約が存在しなければ 404
 *
 * @module services/reservationRoutes.transcriptions.test
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

describe('GET /reservations/:id/transcriptions', () => {
  test('配列を返す videoClient から文字起こし一覧を 200 で返す', async () => {
    const app = makeApp({
      reservationService: {
        async listReservations() {
          return { ok: true, reservations: [RESERVATION] };
        },
      },
      videoClient: {
        async getArchivesBySessionIdWithMock() {
          return [
            {
              id: 'arch-1',
              sessionId: 'sess-1',
              name: 'rec-1',
              hasTranscription: true,
              createdAt: '2026-10-03T02:00:00.000Z',
              transcription: {
                url: 'https://example.test/t1.json',
                primaryLanguageCode: 'ja-JP',
              },
            },
            // 文字起こし無しは除外
            { id: 'arch-2', sessionId: 'sess-1', hasTranscription: false },
            // 別セッションは除外
            {
              id: 'arch-3',
              sessionId: 'other',
              hasTranscription: true,
              transcription: { url: 'https://example.test/t3.json' },
            },
          ];
        },
      },
    });

    const { status, json } = await get(app, '/reservations/r-1/transcriptions');

    expect(status).toBe(200);
    expect(json.transcriptions).toHaveLength(1);
    expect(json.transcriptions[0]).toMatchObject({
      transcriptionId: 'arch-1',
      downloadUrl: 'https://example.test/t1.json',
      language: 'ja-JP',
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

    const { status } = await get(app, '/reservations/missing/transcriptions');

    expect(status).toBe(404);
  });
});
