/**
 * ゲスト用 Video トークン発行 統合テスト（要件 4.1）
 *
 * 未ログインのエンドユーザー（モバイル等）が `POST /sessions/:id/guest-token` により
 * ビデオ通話へ参加できることを HTTP レベルで検証する。無制限の発行を防ぐため、
 * 該当セッションに対する有効（cancelled 以外）な予約が存在する場合のみトークンを
 * 発行する予約バックドな挙動を確認する。
 *
 * 実装方針:
 *  - supertest は導入せず、Node 標準 http で createSessionRouter を単体マウントした
 *    最小 Express アプリに実 HTTP リクエストを送る（既存 *.integration.test.js に倣う）。
 *  - sessionService.issueToken はスタブ（外部 Vonage を呼ばない）。
 *  - reservationStore はインメモリ実装を注入し、findBySessionId の戻り値を制御する。
 *  - guest-token ルートは authorize を付与しないため、認証ヘッダー無しで到達できる。
 *
 * @module services/session.guestToken.integration.test
 */

import http from 'node:http';
import express from 'express';

import { createSessionRouter } from './sessionRoutes.js';

/**
 * issueToken スタブ。呼び出しを記録し、定型のトークンを返す。
 * @param {{ token?: string, applicationId?: string, result?: object }} [opts]
 */
function makeSessionServiceStub(opts = {}) {
  const calls = [];
  return {
    calls,
    service: {
      async issueToken(sessionId, params) {
        calls.push([sessionId, params]);
        if (opts.result) return opts.result;
        return {
          ok: true,
          token: opts.token ?? 'guest-token-xyz',
          sessionId,
          applicationId: opts.applicationId ?? 'app-123',

        };
      },
    },
  };
}

/**
 * findBySessionId をインメモリで提供する reservationStore スタブ。
 * @param {object[]} reservations findBySessionId が返す配列
 */
function makeReservationStoreStub(reservations = []) {
  const calls = [];
  return {
    calls,
    store: {
      async findBySessionId(sessionId) {
        calls.push(sessionId);
        return reservations.filter((r) => r.sessionId === sessionId);
      },
    },
  };
}

/**
 * roomLifecycleService のスタブ。
 *
 * 室閉鎖判定（isRoomClosed）を既定では「未閉鎖」に固定し、実 MongoDB に
 * 接続しないようにする。外部接続を試みないことで、このテストは
 * ネットワークに依存せず（即ち 5 秒タイムアウトもしない）完結する。
 *
 * @param {boolean} [closed] 室を閉鎖済みに見なすか
 * @returns {{ service: object, calls: string[] }}
 */
function makeRoomLifecycleStub(closed = false) {
  const calls = [];
  return {
    calls,
    service: {
      async isRoomClosed(sessionId) {
        calls.push(sessionId);
        return closed;
      },
    },
  };
}

/**
 * Session Router を /sessions にマウントした最小アプリへ HTTP リクエストを送る。
 * @param {import('express').Router} router
 * @param {('GET'|'POST')} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<{ status: number, json: object }>}
 */
function request(router, method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/sessions', router);

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const payload = body ? JSON.stringify(body) : null;
      const headers = {};
      if (payload) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload);
      }
      const req = http.request(
        { host: '127.0.0.1', port, method, path, headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close(() => {
              resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null });
            });
          });
        },
      );
      req.on('error', (err) => {
        server.close(() => reject(err));
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('ゲスト用 Video トークン発行 統合テスト (POST /sessions/:id/guest-token / 要件 4.1)', () => {
  test('有効な予約があればゲスト publisher トークンを 200 で発行する', async () => {
    const { service, calls } = makeSessionServiceStub({ token: 'tok-1', applicationId: 'app-1' });
    const { store } = makeReservationStoreStub([
      { reservationId: 'r1', sessionId: 'sess-1', status: 'confirmed' },
    ]);
    const router = createSessionRouter({
      sessionService: service,
      reservationStore: store,
      roomLifecycleService: makeRoomLifecycleStub().service,
    });

    const res = await request(router, 'POST', '/sessions/sess-1/guest-token', {
      displayName: 'Alice',
    });

    expect(res.status).toBe(200);
    expect(res.json.token).toBe('tok-1');
    expect(res.json.sessionId).toBe('sess-1');
    // クライアント SDK の第 1 引数は partnerId として接続先ホストの解決に使われる。
    // Vonage Video アプリケーションのセッションなので applicationId を返す。
    expect(res.json.applicationId).toBe('app-1');
    expect(res.json.apiKey).toBeUndefined();

    // issueToken は guest ロール + publisher で呼ばれる。
    expect(calls).toHaveLength(1);
    const [sessionId, params] = calls[0];
    expect(sessionId).toBe('sess-1');
    expect(params.user.role).toBe('guest');
    expect(params.user.displayName).toBe('Alice');
    expect(params.role).toBe('publisher');
  });

  test('displayName 省略時は既定の Guest を用いる', async () => {
    const { service, calls } = makeSessionServiceStub();
    const { store } = makeReservationStoreStub([
      { reservationId: 'r1', sessionId: 'sess-1', status: 'pending' },
    ]);
    const router = createSessionRouter({
      sessionService: service,
      reservationStore: store,
      roomLifecycleService: makeRoomLifecycleStub().service,
    });

    const res = await request(router, 'POST', '/sessions/sess-1/guest-token');

    expect(res.status).toBe(200);
    expect(calls[0][1].user.displayName).toBe('Guest');
  });

  test('該当セッションの予約が存在しなければ 403 を返す', async () => {
    const { service, calls } = makeSessionServiceStub();
    const { store } = makeReservationStoreStub([]); // 予約なし
    const router = createSessionRouter({
      sessionService: service,
      reservationStore: store,
      roomLifecycleService: makeRoomLifecycleStub().service,
    });

    const res = await request(router, 'POST', '/sessions/sess-unknown/guest-token');

    expect(res.status).toBe(403);
    expect(res.json.error).toBe('forbidden');
    expect(res.json.message).toBe('No active reservation for this session');
    // トークンは発行しない。
    expect(calls).toHaveLength(0);
  });

  test('予約が cancelled のみの場合は 403 を返す', async () => {
    const { service, calls } = makeSessionServiceStub();
    const { store } = makeReservationStoreStub([
      { reservationId: 'r1', sessionId: 'sess-1', status: 'cancelled' },
    ]);
    const router = createSessionRouter({
      sessionService: service,
      reservationStore: store,
      roomLifecycleService: makeRoomLifecycleStub().service,
    });

    const res = await request(router, 'POST', '/sessions/sess-1/guest-token');

    expect(res.status).toBe(403);
    expect(res.json.error).toBe('forbidden');
    expect(calls).toHaveLength(0);
  });

  test('cancelled と有効な予約が混在する場合はトークンを発行する', async () => {
    const { service } = makeSessionServiceStub({ token: 'tok-mix' });
    const { store } = makeReservationStoreStub([
      { reservationId: 'r1', sessionId: 'sess-1', status: 'cancelled' },
      { reservationId: 'r2', sessionId: 'sess-1', status: 'confirmed' },
    ]);
    const router = createSessionRouter({
      sessionService: service,
      reservationStore: store,
      roomLifecycleService: makeRoomLifecycleStub().service,
    });

    const res = await request(router, 'POST', '/sessions/sess-1/guest-token');

    expect(res.status).toBe(200);
    expect(res.json.token).toBe('tok-mix');
  });

  test('トークン発行失敗（token_error）は 500 を返す', async () => {
    const { service } = makeSessionServiceStub({
      result: { ok: false, code: 'token_error', message: 'boom' },
    });
    const { store } = makeReservationStoreStub([
      { reservationId: 'r1', sessionId: 'sess-1', status: 'confirmed' },
    ]);
    const router = createSessionRouter({
      sessionService: service,
      reservationStore: store,
      roomLifecycleService: makeRoomLifecycleStub().service,
    });

    const res = await request(router, 'POST', '/sessions/sess-1/guest-token');

    expect(res.status).toBe(500);
    expect(res.json.code).toBe('token_error');
  });
});
