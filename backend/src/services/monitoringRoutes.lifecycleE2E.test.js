/**
 * monitoringRoutes × roomLifecycleService 統合（自動録画の E2E）テスト
 *
 * 既存の monitoringRoutes.test.js は roomLifecycleService をスタブし、
 * roomLifecycleService.test.js はルーターを通さずサービスを直接呼ぶ。
 * そのため「Vonage Webhook ペイロード → 実 roomLifecycleService →
 * recordingService.startRecording/stopRecording」という配線が分断されており、
 * 「会議開始時に確実に録画が開始される」ことを1本で保証できていなかった。
 *
 * 本テストは実 roomLifecycleService を偽ストアとともにルーターへ配線し、
 * ゲストの connectionCreated / connectionDestroyed を受けて
 * 自動録画開始（withTranscription:true・予約言語の継承）と会議終了時の
 * 録画停止がエンドツーエンドで成立することを検証する。
 *
 * @module services/monitoringRoutes.lifecycleE2E.test
 */

import http from 'node:http';

import express from 'express';

import { createMonitoringRouter } from './monitoringRoutes.js';
import { createRoomLifecycleService } from './roomLifecycleService.js';

/** 署名検証をバイパスするパススルー（テスト用）。 */
const passThroughVerifyWebhook = (_req, _res, next) => next();

/**
 * 偽ストア群を生成する。roomLifecycleService.test.js の signal 意味論に合わせる。
 * @param {{ reservations?: object[] }} [opts]
 */
function makeStores({ reservations = [] } = {}) {
  const presenceBySession = new Map();
  const calls = {
    addConnection: [],
    removeConnection: [],
    markClosed: [],
    updateStatus: [],
    startRecording: [],
    stopRecording: [],
    disconnectClient: [],
  };

  const sessionPresenceStore = {
    async addConnection({ sessionId, connectionId, userId, role, joinedAt }) {
      calls.addConnection.push({ sessionId, connectionId, userId, role, joinedAt });
      let presence = presenceBySession.get(sessionId);
      if (!presence) {
        presence = { sessionId, connections: [], openedAt: joinedAt, closedAt: null };
        presenceBySession.set(sessionId, presence);
      }
      presence.connections.push({ connectionId, userId, role, joinedAt });
      if (presence.openedAt == null) presence.openedAt = joinedAt;
      return presence;
    },
    async removeConnection({ sessionId, connectionId }) {
      calls.removeConnection.push({ sessionId, connectionId });
      const presence = presenceBySession.get(sessionId);
      if (!presence) return null;
      presence.connections = presence.connections.filter((c) => c.connectionId !== connectionId);
      return presence;
    },
    async findBySessionId(sessionId) {
      return presenceBySession.get(sessionId) ?? null;
    },
    async markClosed(sessionId, closedAt) {
      calls.markClosed.push({ sessionId, closedAt });
      const presence = presenceBySession.get(sessionId);
      if (!presence || presence.closedAt != null) return null;
      presence.closedAt = closedAt;
      return presence;
    },
  };

  const joinTokenStore = {
    async invalidateBySessionId() {
      return 1;
    },
    async isSessionInvalidated() {
      return false;
    },
  };

  const reservationStore = {
    async findBySessionId(sessionId) {
      return reservations.filter((r) => r.sessionId === sessionId);
    },
    async updateStatus(reservationId, status) {
      calls.updateStatus.push({ reservationId, status });
      const target = reservations.find((r) => r.reservationId === reservationId);
      if (target) target.status = status;
      return target;
    },
  };

  const videoClient = {
    async disconnectClient(sessionId, connectionId) {
      calls.disconnectClient.push({ sessionId, connectionId });
    },
  };

  const recordingService = {
    async startRecording(req) {
      calls.startRecording.push(req);
      return { ok: true, archive: { id: `arch-${req.sessionId}` } };
    },
    async stopRecording(archiveId) {
      calls.stopRecording.push(archiveId);
      return { ok: true };
    },
  };

  return { calls, sessionPresenceStore, joinTokenStore, reservationStore, videoClient, recordingService };
}

/**
 * 実 roomLifecycleService を配線した app を組み立てる。
 * @param {ReturnType<typeof makeStores>} stores
 */
function makeApp(stores) {
  const roomLifecycleService = createRoomLifecycleService({
    sessionPresenceStore: stores.sessionPresenceStore,
    joinTokenStore: stores.joinTokenStore,
    reservationStore: stores.reservationStore,
    videoClient: stores.videoClient,
    recordingService: stores.recordingService,
    clock: () => new Date('2026-01-01T01:00:00Z'),
    logger: () => {},
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/webhooks',
    createMonitoringRouter({
      roomLifecycleService,
      verifySessionWebhook: passThroughVerifyWebhook,
      logger: { info() {}, error() {}, warn() {} },
    }),
  );
  return app;
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

/** Vonage の connectionCreated ペイロードを組み立てる。 */
function connectionCreated({ sessionId, connectionId, data }) {
  return {
    sessionId,
    projectId: '123',
    event: 'connectionCreated',
    connection: { id: connectionId, createdAt: 1, data: JSON.stringify(data) },
  };
}

/** Vonage の connectionDestroyed ペイロードを組み立てる。 */
function connectionDestroyed({ sessionId, connectionId }) {
  return {
    sessionId,
    projectId: '123',
    event: 'connectionDestroyed',
    reason: 'clientDisconnected',
    connection: { id: connectionId, data: '' },
  };
}

describe('E2E: 会議開始時の自動録画（Webhook → roomLifecycleService → recordingService）', () => {
  test('ゲスト入室の Webhook で予約言語を継承して自動録画が開始される', async () => {
    const stores = makeStores({
      reservations: [
        { reservationId: 'r1', sessionId: 's1', status: 'confirmed', language: 'en' },
      ],
    });
    const app = makeApp(stores);

    const { status, json } = await postVideoEvents(
      app,
      connectionCreated({
        sessionId: 's1',
        connectionId: 'c-guest',
        data: { userId: 'guest-1', role: 'guest', displayName: 'Guest' },
      }),
    );

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, handled: true });

    expect(stores.calls.startRecording).toHaveLength(1);
    expect(stores.calls.startRecording[0]).toMatchObject({
      sessionId: 's1',
      withTranscription: true,
      language: 'en',
      reservationId: 'r1',
    });
  });

  test('管理者の入室 Webhook では自動録画しない', async () => {
    const stores = makeStores();
    const app = makeApp(stores);

    await postVideoEvents(
      app,
      connectionCreated({
        sessionId: 's1',
        connectionId: 'c-admin',
        data: { userId: 'admin', role: 'administrator' },
      }),
    );

    expect(stores.calls.startRecording).toHaveLength(0);
    expect(stores.calls.addConnection).toHaveLength(1);
  });

  test('最後のゲスト退室 Webhook で録画が停止される（会議終了）', async () => {
    const stores = makeStores({
      reservations: [
        { reservationId: 'r1', sessionId: 's1', status: 'confirmed', language: 'ja' },
      ],
    });
    const app = makeApp(stores);

    // 入室 → 自動録画開始（archiveId: arch-s1 が activeArchives に登録される）
    await postVideoEvents(
      app,
      connectionCreated({
        sessionId: 's1',
        connectionId: 'c-guest',
        data: { userId: 'guest-1', role: 'guest' },
      }),
    );

    // 退室 → 全員退室で室を閉じ、録画を停止する
    const { status, json } = await postVideoEvents(
      app,
      connectionDestroyed({ sessionId: 's1', connectionId: 'c-guest' }),
    );

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, handled: true, closed: true });
    expect(stores.calls.startRecording).toHaveLength(1);
    expect(stores.calls.stopRecording).toEqual(['arch-s1']);
  });
});
