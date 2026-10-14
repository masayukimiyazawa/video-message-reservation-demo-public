/**
 * recordingRoutes 回帰テスト（GET /recordings・GET /transcriptions）
 *
 * 「管理画面に録画・文字起こしのダウンロードボタンが表示されない」不具合の
 * バックエンド側の根拠を固定する。
 *
 * 検証の要点:
 *  - GET /recordings は注入 videoClient の { ok, archives } をそのまま { archives } で返す
 *  - 外部 API 失敗（VIDEO_API_ERROR）は 502 に対応付ける
 *  - GET /transcriptions は、
 *      * hasTranscription が無くても transcription があれば含める（実 Vonage の一覧対策）
 *      * transcription.url を downloadUrl へ解決する
 *      * transcription.url が無い場合は getArchive で個別解決する
 *      * 文字起こしの無いアーカイブは除外する
 *  - GET /transcriptions/:archiveId は recordingService へ委譲する
 *
 * @module services/recordingRoutes.test
 */

import http from 'node:http';

import express from 'express';

import { createRecordingRouter, createTranscriptionRouter } from './recordingRoutes.js';

const passThroughAuthorize = () => (_req, _res, next) => next();

function makeApp({ videoClient, recordingService } = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    '/recordings',
    createRecordingRouter({
      videoClient,
      recordingService,
      authorize: passThroughAuthorize,
    }),
  );
  app.use(
    '/transcriptions',
    createTranscriptionRouter({
      videoClient,
      recordingService,
      authorize: passThroughAuthorize,
    }),
  );
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

function del(app, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        { host: '127.0.0.1', port, method: 'DELETE', path },
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

describe('DELETE /recordings/:archiveId（録画削除）', () => {
  test('削除成功は 200 { ok: true } を返す', async () => {
    const calls = [];
    const app = makeApp({
      recordingService: {
        async deleteRecording(archiveId) {
          calls.push(archiveId);
          return { ok: true };
        },
      },
      videoClient: {},
    });

    const { status, json } = await del(app, '/recordings/a1');

    expect(status).toBe(200);
    expect(calls).toEqual(['a1']);
    expect(json).toMatchObject({ ok: true });
  });

  test('ARCHIVE_NOT_DELETABLE は 409 を返す（期限切れ・処理中）', async () => {
    const app = makeApp({
      recordingService: {
        async deleteRecording() {
          return { ok: false, code: 'ARCHIVE_NOT_DELETABLE', message: '削除できません' };
        },
      },
      videoClient: {},
    });

    const { status, json } = await del(app, '/recordings/a1');

    expect(status).toBe(409);
    expect(json).toMatchObject({ code: 'ARCHIVE_NOT_DELETABLE' });
  });
});

describe('DELETE /transcriptions/:archiveId（文字起こし削除）', () => {
  test('削除成功は 200 { ok: true } を返す', async () => {
    const calls = [];
    const app = makeApp({
      recordingService: {
        async deleteRecording(archiveId) {
          calls.push(archiveId);
          return { ok: true };
        },
      },
      videoClient: {},
    });

    const { status, json } = await del(app, '/transcriptions/a1');

    expect(status).toBe(200);
    expect(calls).toEqual(['a1']);
    expect(json).toMatchObject({ ok: true });
  });

  test('ARCHIVE_NOT_DELETABLE は 409 を返す', async () => {
    const app = makeApp({
      recordingService: {
        async deleteRecording() {
          return { ok: false, code: 'ARCHIVE_NOT_DELETABLE', message: '削除できません' };
        },
      },
      videoClient: {},
    });

    const { status, json } = await del(app, '/transcriptions/a1');

    expect(status).toBe(409);
    expect(json).toMatchObject({ code: 'ARCHIVE_NOT_DELETABLE' });
  });
});

describe('GET /recordings（録画一覧）', () => {
  test('注入 videoClient の archives を { archives } で返す', async () => {
    const archives = [
      { id: 'a1', url: 'https://example.test/a1.mp4', status: 'available' },
      { id: 'a2', url: 'https://example.test/a2.mp4', status: 'available' },
    ];
    const app = makeApp({
      videoClient: { async getArchives() { return { ok: true, archives }; } },
    });

    const { status, json } = await get(app, '/recordings');

    expect(status).toBe(200);
    expect(json.archives).toHaveLength(2);
    expect(json.archives[0]).toMatchObject({ id: 'a1', url: 'https://example.test/a1.mp4' });
  });

  test('外部 API 失敗（VIDEO_API_ERROR）は 502 を返す', async () => {
    const app = makeApp({
      videoClient: {
        async getArchives() {
          return { ok: false, code: 'VIDEO_API_ERROR', message: 'boom' };
        },
      },
    });

    const { status, json } = await get(app, '/recordings');

    expect(status).toBe(502);
    expect(json).toMatchObject({ code: 'VIDEO_API_ERROR' });
  });

  test('文字起こしを持つ録画は transcription.url / downloadUrl を解決する（録画面のDLリンク）', async () => {
    const app = makeApp({
      videoClient: {
        async getArchives() {
          return {
            ok: true,
            archives: [
              {
                id: 'a1',
                url: 'https://example.test/a1.mp4',
                status: 'available',
                hasTranscription: true,
                transcription: { url: 'https://example.test/a1.zip', primaryLanguageCode: 'ja-JP' },
              },
              // 文字起こしを持たない録画は downloadUrl のみ
              { id: 'a2', url: 'https://example.test/a2.mp4', status: 'available' },
            ],
          };
        },
      },
    });

    const { status, json } = await get(app, '/recordings');

    expect(status).toBe(200);
    const a1 = json.archives.find((a) => a.id === 'a1');
    // downloadUrl は録画本体（mp4）を指し、文字起こしは transcription.url に保持される。
    expect(a1.downloadUrl).toBe('https://example.test/a1.mp4');
    expect(a1.transcription.url).toBe('https://example.test/a1.zip');
    expect(a1.hasTranscription).toBe(true);

    const a2 = json.archives.find((a) => a.id === 'a2');
    expect(a2.downloadUrl).toBe('https://example.test/a2.mp4');
    // 文字起こしが無い録画に hasTranscription/transcription を捏造しない。
    expect(a2.hasTranscription).toBeUndefined();
    expect(a2.transcription).toBeUndefined();
  });

  test('文字起こしの url が一覧に無い場合は getArchive で個別解決する（録画一覧）', async () => {
    const getArchiveCalls = [];
    const app = makeApp({
      videoClient: {
        async getArchives() {
          return {
            ok: true,
            archives: [
              { id: 'a1', url: 'https://example.test/a1.mp4', hasTranscription: true },
            ],
          };
        },
        async getArchive(archiveId) {
          getArchiveCalls.push(archiveId);
          return {
            id: archiveId,
            transcription: { url: 'https://example.test/a1.zip', primaryLanguageCode: 'en-US' },
          };
        },
      },
    });

    const { status, json } = await get(app, '/recordings');

    expect(status).toBe(200);
    expect(getArchiveCalls).toEqual(['a1']);
    expect(json.archives[0].transcription.url).toBe('https://example.test/a1.zip');
    expect(json.archives[0].downloadUrl).toBe('https://example.test/a1.mp4');
  });
});

describe('GET /transcriptions（文字起こし一覧）', () => {
  test('hasTranscription が無くても transcription があれば含め、downloadUrl を解決する', async () => {
    const app = makeApp({
      videoClient: {
        async getArchives() {
          return {
            ok: true,
            archives: [
              // 実 Vonage の一覧を模し hasTranscription を持たず transcription のみ
              {
                id: 't1',
                createdAt: '2026-10-03T02:00:00.000Z',
                duration: 120000,
                transcription: { url: 'https://example.test/t1.zip', primaryLanguageCode: 'ja-JP' },
              },
              // 文字起こし無しは除外
              { id: 'n1', status: 'available', url: 'https://example.test/n1.mp4' },
            ],
          };
        },
      },
    });

    const { status, json } = await get(app, '/transcriptions');

    expect(status).toBe(200);
    expect(json.transcriptions).toHaveLength(1);
    expect(json.transcriptions[0]).toMatchObject({
      id: 't1',
      hasTranscription: true,
      downloadUrl: 'https://example.test/t1.zip',
      language: 'ja-JP',
    });
    // フロントが参照する transcription.url も補完される
    expect(json.transcriptions[0].transcription.url).toBe('https://example.test/t1.zip');
  });

  test('transcription.url が無い場合は getArchive で個別解決する', async () => {
    const getArchiveCalls = [];
    const app = makeApp({
      videoClient: {
        async getArchives() {
          return {
            ok: true,
            archives: [{ id: 't2', hasTranscription: true, createdAt: '2026-10-03T02:00:00.000Z' }],
          };
        },
        async getArchive(archiveId) {
          getArchiveCalls.push(archiveId);
          return {
            id: archiveId,
            transcription: { url: 'https://example.test/t2.zip', primaryLanguageCode: 'en-US' },
          };
        },
      },
    });

    const { status, json } = await get(app, '/transcriptions');

    expect(status).toBe(200);
    expect(getArchiveCalls).toEqual(['t2']);
    expect(json.transcriptions[0]).toMatchObject({
      id: 't2',
      downloadUrl: 'https://example.test/t2.zip',
      language: 'en-US',
    });
  });

  test('外部 API 失敗（VIDEO_API_ERROR）は 502 を返す', async () => {
    const app = makeApp({
      videoClient: {
        async getArchives() {
          return { ok: false, code: 'VIDEO_API_ERROR', message: 'boom' };
        },
      },
    });

    const { status, json } = await get(app, '/transcriptions');

    expect(status).toBe(502);
    expect(json).toMatchObject({ code: 'VIDEO_API_ERROR' });
  });
});

describe('GET /transcriptions/:archiveId', () => {
  test('recordingService.fetchTranscription に委譲する', async () => {
    const fetchCalls = [];
    const app = makeApp({
      recordingService: {
        async fetchTranscription(archiveId) {
          fetchCalls.push(archiveId);
          return { ok: true, transcript: [{ channel: 0, segments: [] }] };
        },
      },
      videoClient: {},
    });

    const { status, json } = await get(app, '/transcriptions/arch-1');

    expect(status).toBe(200);
    expect(fetchCalls).toEqual(['arch-1']);
    expect(json.transcript).toHaveLength(1);
  });
});
