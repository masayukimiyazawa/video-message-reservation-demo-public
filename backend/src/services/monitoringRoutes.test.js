/**
 * monitoringRoutes テスト（HTTP レベル）
 *
 * Vonage Session Monitoring / Archive Monitoring コールバックの入口検証。
 * 既存規約に従い supertest は導入せず、Node 標準 http で実サーバーを立てて往復する。
 *
 * 検証の要点:
 *  - 接続イベントを roomLifecycleService へ委譲する
 *  - サービスの結果（closed）をそのまま返す
 *  - 解析不能なペイロードは 200 で受け流す
 *  - サービス側の処理失敗時も 200 を返す（Vonage の再送を誘発しない）
 *  - 署名検証は verifySessionWebhook / verifyArchiveWebhook に委譲し、401 ならハンドラを呼ばない
 *
 * @module services/monitoringRoutes.test
 */

import http from 'node:http';

import express from 'express';

import { createMonitoringRouter } from './monitoringRoutes.js';

/** 署名検証をバイパスするパススルーミドルウェア（テスト用）。 */
const passThroughVerifyWebhook = (_req, _res, next) => next();

/**
 * テスト用 app を組み立てる（Session Monitoring 用）。
 * @param {object} [opts]
 * @param {object} [opts.roomLifecycleService] 差し込むサービス
 * @param {import('express').RequestHandler} [opts.verifySessionWebhook] Session 署名検証
 * @param {object} [opts.logger]
 * @returns {{ app: import('express').Express, calls: object }}
 */
function makeSessionApp({ roomLifecycleService, verifySessionWebhook = passThroughVerifyWebhook, logger } = {}) {
  const calls = { events: [] };
  const service =
    roomLifecycleService ?? {
      async handleConnectionEvent(parsed) {
        calls.events.push(parsed);
        return { handled: true, closed: false };
      },
    };

  const app = express();
  app.use(express.json());
  app.use(
    '/webhooks',
    createMonitoringRouter({ roomLifecycleService: service, verifySessionWebhook, logger }),
  );
  return { app, calls };
}

/**
 * テスト用 app を組み立てる（Archive Monitoring 用）。
 * @param {object} [opts]
 * @param {object} [opts.recordingService] 差し込むサービス
 * @param {import('express').RequestHandler} [opts.verifyArchiveWebhook] Archive 署名検証
 * @param {object} [opts.logger]
 * @returns {{ app: import('express').Express, calls: object }}
 */
function makeArchiveApp({ recordingService, verifyArchiveWebhook = passThroughVerifyWebhook, logger } = {}) {
  const calls = { recording: [], status: [] };
  const service =
    recordingService ?? {
      async fetchTranscription(archiveId) {
        calls.recording.push(archiveId);
        return { ok: false, code: 'mock' };
      },
    };
  const statusEmitter = {
    emitRecordingStatus(payload) {
      calls.status.push(payload);
    },
  };

  const app = express();
  app.use(express.json());
  app.use(
    '/webhooks',
    createMonitoringRouter({ recordingService: service, verifyArchiveWebhook, logger, statusEmitter }),
  );
  return { app, calls };
}

/**
 * POST /webhooks/video-events に JSON を送る（Node 標準 http）。
 * @param {import('express').Express} app
 * @param {object} body
 * @returns {Promise<{ status: number, json: object|null }>}
 */
function postVideoEvents(app, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/webhooks/video-events',
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
}

describe('services monitoringRoutes（Video 監視 Webhook：Session Monitoring）', () => {
  test('connectionCreated をサービスへ委譲する', async () => {
    const { app, calls } = makeSessionApp();

    const { status, json } = await postVideoEvents(app, {
      sessionId: '2_MX4-session',
      projectId: '123',
      event: 'connectionCreated',
      connection: {
        id: 'c-1',
        data: JSON.stringify({ userId: 'admin', role: 'administrator' }),
      },
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, handled: true, closed: false });
    expect(calls.events[0]).toMatchObject({
      event: 'connectionCreated',
      sessionId: '2_MX4-session',
      connectionId: 'c-1',
      userId: 'admin',
      role: 'administrator',
    });
  });

  test('サービスの結果（closed）をそのまま返す', async () => {
    const { app } = makeSessionApp({
      roomLifecycleService: {
        async handleConnectionEvent() {
          return { handled: true, closed: true };
        },
      },
    });

    const { status, json } = await postVideoEvents(app, {
      sessionId: 's',
      event: 'connectionDestroyed',
      connection: { id: 'c' },
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, handled: true, closed: true });
  });

  test('解析不能なペイロードは 200 で受け流す（再送を誘発しない）', async () => {
    const { app, calls } = makeSessionApp();

    const { status, json } = await postVideoEvents(app, { foo: 'bar' });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, handled: false });
    expect(calls.events).toHaveLength(0);
  });

  test('空ボディでも 200', async () => {
    const { app } = makeSessionApp();

    const { status } = await postVideoEvents(app, {});

    expect(status).toBe(200);
  });

  test('サービス側の例外でも 200 を返す（再送の連鎖を防ぐ）', async () => {
    const { app } = makeSessionApp({
      roomLifecycleService: {
        async handleConnectionEvent() {
          throw new Error('MongoDB down');
        },
      },
      logger: { info() {}, error() {} },
    });

    const { status, json } = await postVideoEvents(app, {
      sessionId: 's',
      event: 'connectionDestroyed',
      connection: { id: 'c' },
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, error: 'processing_failed' });
  });

  test('署名検証ミドルウェアを先に通す', async () => {
    const order = [];
    const { app } = makeSessionApp({
      verifySessionWebhook: (_req, _res, next) => {
        order.push('verify');
        next();
      },
      roomLifecycleService: {
        async handleConnectionEvent() {
          order.push('service');
          return { handled: true, closed: false };
        },
      },
    });

    await postVideoEvents(app, {
      sessionId: 's',
      event: 'connectionCreated',
      connection: { id: 'c' },
    });

    expect(order).toEqual(['verify', 'service']);
  });

  test('署名検証が 401 を返したらハンドラは呼ばれない', async () => {
    let called = false;
    const { app } = makeSessionApp({
      verifySessionWebhook: (_req, res) => {
        res.status(401).json({ error: 'unauthorized' });
      },
      roomLifecycleService: {
        async handleConnectionEvent() {
          called = true;
          return { handled: true, closed: false };
        },
      },
    });

    const { status } = await postVideoEvents(app, {
      sessionId: 's',
      event: 'connectionCreated',
      connection: { id: 'c' },
    });

    expect(status).toBe(401);
    expect(called).toBe(false);
  });
});

describe('services monitoringRoutes（Video 監視 Webhook：Archive Monitoring）', () => {
  /**
   * POST /webhooks/video-archive-events に JSON を送る（Node 標準 http）。
   * @param {import('express').Express} app
   * @param {object} body
   * @returns {Promise<{ status: number, json: object|null }>}
   */
  function postArchiveEvents(app, body) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(app);
      server.listen(0, () => {
        const { port } = server.address();
        const payload = JSON.stringify(body);
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/webhooks/video-archive-events',
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
  }

  function makeArchiveApp({ recordingService, verifyArchiveWebhook = passThroughVerifyWebhook, logger } = {}) {
    const calls = { recording: [], status: [] };
    const service =
      recordingService ?? {
        async fetchTranscription(archiveId) {
          calls.recording.push(archiveId);
          return { ok: false, code: 'mock' };
        },
      };
    const statusEmitter = {
      emitRecordingStatus(payload) {
        calls.status.push(payload);
      },
    };

    const app = express();
    app.use(express.json());
    app.use(
      '/webhooks',
      createMonitoringRouter({ recordingService: service, verifyArchiveWebhook, logger, statusEmitter }),
    );
    return { app, calls };
  }

  test('archive status=available を受信し statusEmitter へ送出する', async () => {
    const { app, calls } = makeArchiveApp();

    const { status, json } = await postArchiveEvents(app, {
      event: 'archive',
      id: 'arch-123',
      status: 'available',
      sessionId: 'sess-1',
      url: 'https://example.com/archive.mp4',
      size: 123456,
      duration: 300,
      name: 'test recording',
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, handled: true });

    const emitted = calls.status[0];
    expect(emitted).toMatchObject({
      status: 'available',
      archiveId: 'arch-123',
      sessionId: 'sess-1',
      downloadUrl: 'https://example.com/archive.mp4',
      size: 123456,
      duration: 300,
    });
  });

  test('archive status=failed を受信し start_failed として送出する', async () => {
    const { app, calls } = makeArchiveApp();

    const { status, json } = await postArchiveEvents(app, {
      event: 'archive',
      id: 'arch-456',
      status: 'failed',
      sessionId: 'sess-2',
      reason: 'Internal server failure',
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, handled: true });

    const emitted = calls.status[0];
    expect(emitted).toMatchObject({
      status: 'start_failed',
      archiveId: 'arch-456',
      error: 'Internal server failure',
    });
  });

  test('event=archive 以外は無視される', async () => {
    const { app, calls } = makeArchiveApp();

    const { status, json } = await postArchiveEvents(app, {
      event: 'session',
      status: 'started',
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, handled: false });
    expect(calls.status).toHaveLength(0);
  });

  test('archiveId が欠落している場合は handled=false で 200 を返す', async () => {
    const { app, calls } = makeArchiveApp();

    const { status, json } = await postArchiveEvents(app, {
      event: 'archive',
      status: 'available',
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, handled: false });
    expect(calls.status).toHaveLength(0);
  });

  test('文字起こし取得を自動で呼び出す（available 時）', async () => {
    const { app, calls } = makeArchiveApp({
      recordingService: {
        async fetchTranscription(archiveId) {
          calls.recording.push(archiveId);
          return { ok: true, transcript: [{ channel: 0, segments: [] }] };
        },
      },
    });

    const { status, json } = await postArchiveEvents(app, {
      event: 'archive',
      id: 'arch-789',
      status: 'available',
      sessionId: 'sess-1',
    });

    expect(status).toBe(200);

    // 非同期で fetchTranscription が呼ばれるのを待つ
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.recording).toContain('arch-789');
    expect(calls.status.some((s) => s.status === 'transcription_ready')).toBe(true);
  });

  test('文字起こし取得失敗時は transcription_failed を送出する', async () => {
    const { app, calls } = makeArchiveApp({
      recordingService: {
        async fetchTranscription(archiveId) {
          calls.recording.push(archiveId);
          return { ok: false, message: 'not found' };
        },
      },
    });

    const { status, json } = await postArchiveEvents(app, {
      event: 'archive',
      id: 'arch-999',
      status: 'available',
      sessionId: 'sess-1',
    });

    expect(status).toBe(200);

    await new Promise((r) => setTimeout(r, 10));
    expect(calls.recording).toContain('arch-999');
    expect(calls.status.some((s) => s.status === 'transcription_failed')).toBe(true);
  });

  test('例外が発生しても 200 を返す（Vonage 再送防止）', async () => {
    const { app } = makeArchiveApp({
      recordingService: {
        async fetchTranscription() {
          throw new Error('DB down');
        },
      },
    });

    const { status, json } = await postArchiveEvents(app, {
      event: 'archive',
      id: 'arch-err',
      status: 'available',
      sessionId: 'sess-1',
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, handled: true });
  });

  test('status=stopped で録画停止を呼び、logger.info で記録する（TypeError 回帰）', async () => {
    const stopCalls = [];
    const infoCalls = [];
    const errorCalls = [];
    const { app } = makeArchiveApp({
      recordingService: {
        async stopRecording(archiveId) {
          stopCalls.push(archiveId);
          return { ok: true };
        },
      },
      logger: {
        info: (...args) => infoCalls.push(args),
        error: (...args) => errorCalls.push(args),
      },
    });

    const { status, json } = await postArchiveEvents(app, {
      event: 'archive',
      id: 'arch-stop',
      status: 'stopped',
      sessionId: 'sess-1',
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, handled: true });

    // setImmediate の非同期処理を待つ
    await new Promise((r) => setTimeout(r, 10));
    expect(stopCalls).toContain('arch-stop');
    // 旧実装は logger(...) を関数として呼び出し TypeError になっていた。logger.info で記録される。
    expect(infoCalls.length).toBeGreaterThan(0);
    expect(errorCalls).toHaveLength(0);
  });
});
