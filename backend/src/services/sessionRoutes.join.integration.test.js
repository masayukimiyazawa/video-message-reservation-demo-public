/**
 * WhatsApp 入室リンク消費 統合テスト（要件 4.1）
 *
 * `POST /sessions/join/:tokenId` が「WhatsApp の入室リンクを消費して入室する」経路で、
 * **必ずゲスト（role:'guest'）の publisher トークンを発行する**ことを HTTP レベルで
 * 固定する。これは「WhatsApp の参加ボタン/リンク経由の入室は常にゲスト扱いになる」という
 * 重要機能の根拠であり、ログイン済みの管理者がリンクを開いた場合も例外ではない
 * （このルートは authorize を持たず、常に guest ロールで issueToken する）。
 *
 * 実装方針（既存 *.integration.test.js に倣う）:
 *  - supertest は導入せず、Node 標準 http で createSessionRouter を単体マウントした
 *    最小 Express アプリに実 HTTP リクエストを送る。
 *  - sessionService.issueToken はスタブ（外部 Vonage を呼ばない）。
 *  - joinLinkService.redeem はスタブ（トークン消費の可否を制御する）。
 *  - roomLifecycleService.isRoomClosed はスタブ（既定: 未閉鎖）。
 *
 * @module services/sessionRoutes.join.integration.test
 */

import http from 'node:http';
import express from 'express';

import { createSessionRouter } from './sessionRoutes.js';
import { JoinLinkError } from './joinLinkService.js';
import { JoinTokenErrorCode } from '../domain/constants.js';

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
 * redeem をインメモリで提供する joinLinkService スタブ。
 * @param {{ result?: object, error?: Error }} [opts] 成功値または送出するエラー
 */
function makeJoinLinkServiceStub(opts = {}) {
  const calls = [];
  return {
    calls,
    service: {
      async redeem(tokenId) {
        calls.push(tokenId);
        if (opts.error) throw opts.error;
        return opts.result ?? { reservationId: 'r1', sessionId: 'sess-1' };
      },
    },
  };
}

/**
 * roomLifecycleService のスタブ（isRoomClosed を固定値にする）。
 * @param {boolean} [closed]
 */
function makeRoomLifecycleStub(closed = false) {
  return {
    service: {
      async isRoomClosed() {
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

describe('WhatsApp 入室リンク消費 統合テスト (POST /sessions/join/:tokenId / 要件 4.1)', () => {
  test('リンク消費に成功するとゲスト publisher トークンを 200 で発行する', async () => {
    const session = makeSessionServiceStub({ token: 'tok-guest', applicationId: 'app-1' });
    const joinLink = makeJoinLinkServiceStub();
    const router = createSessionRouter({
      sessionService: session.service,
      joinLinkService: joinLink.service,
      roomLifecycleService: makeRoomLifecycleStub().service,
    });

    const res = await request(router, 'POST', '/sessions/join/tok-abc', { displayName: 'Alice' });

    expect(res.status).toBe(200);
    expect(res.json.token).toBe('tok-guest');
    expect(res.json.sessionId).toBe('sess-1');
    // 消費したトークンに紐づく予約 ID を返す（フロントのゲスト入室記録に使う）。
    expect(res.json.reservationId).toBe('r1');
    expect(res.json.applicationId).toBe('app-1');

    // トークン ID が redeem に渡される。
    expect(joinLink.calls).toEqual(['tok-abc']);

    // **最重要**: どのユーザーが来ても guest ロール + publisher で発行される。
    expect(session.calls).toHaveLength(1);
    const [sessionId, params] = session.calls[0];
    expect(sessionId).toBe('sess-1');
    expect(params.user.role).toBe('guest');
    expect(params.user.displayName).toBe('Alice');
    expect(params.role).toBe('publisher');
  });

  test('displayName 省略時は既定の Guest を用いる', async () => {
    const session = makeSessionServiceStub();
    const router = createSessionRouter({
      sessionService: session.service,
      joinLinkService: makeJoinLinkServiceStub().service,
      roomLifecycleService: makeRoomLifecycleStub().service,
    });

    const res = await request(router, 'POST', '/sessions/join/tok-abc');

    expect(res.status).toBe(200);
    expect(session.calls[0][1].user.role).toBe('guest');
    expect(session.calls[0][1].user.displayName).toBe('Guest');
  });

  test('存在しないトークンは 404 を返し、トークンを発行しない', async () => {
    const session = makeSessionServiceStub();
    const joinLink = makeJoinLinkServiceStub({
      error: new JoinLinkError(JoinTokenErrorCode.NOT_FOUND),
    });
    const router = createSessionRouter({
      sessionService: session.service,
      joinLinkService: joinLink.service,
      roomLifecycleService: makeRoomLifecycleStub().service,
    });

    const res = await request(router, 'POST', '/sessions/join/missing');

    expect(res.status).toBe(404);
    expect(res.json.error).toBe(JoinTokenErrorCode.NOT_FOUND);
    expect(session.calls).toHaveLength(0);
  });

  test('使用済みトークンは 410 を返し、トークンを発行しない', async () => {
    const session = makeSessionServiceStub();
    const joinLink = makeJoinLinkServiceStub({
      error: new JoinLinkError(JoinTokenErrorCode.ALREADY_USED),
    });
    const router = createSessionRouter({
      sessionService: session.service,
      joinLinkService: joinLink.service,
      roomLifecycleService: makeRoomLifecycleStub().service,
    });

    const res = await request(router, 'POST', '/sessions/join/used');

    expect(res.status).toBe(410);
    expect(res.json.error).toBe(JoinTokenErrorCode.ALREADY_USED);
    expect(session.calls).toHaveLength(0);
  });

  test('会議室が無効化済みなら 410（room_closed）を返す', async () => {
    const session = makeSessionServiceStub();
    const router = createSessionRouter({
      sessionService: session.service,
      joinLinkService: makeJoinLinkServiceStub().service,
      roomLifecycleService: makeRoomLifecycleStub(true).service,
    });

    const res = await request(router, 'POST', '/sessions/join/tok-abc');

    expect(res.status).toBe(410);
    expect(res.json.error).toBe(JoinTokenErrorCode.ROOM_CLOSED);
    expect(session.calls).toHaveLength(0);
  });

  test('トークン発行失敗（validation_error）は 400 を返す', async () => {
    const session = makeSessionServiceStub({
      result: { ok: false, code: 'validation_error', message: 'bad' },
    });
    const router = createSessionRouter({
      sessionService: session.service,
      joinLinkService: makeJoinLinkServiceStub().service,
      roomLifecycleService: makeRoomLifecycleStub().service,
    });

    const res = await request(router, 'POST', '/sessions/join/tok-abc');

    expect(res.status).toBe(400);
    expect(res.json.code).toBe('validation_error');
  });
});
