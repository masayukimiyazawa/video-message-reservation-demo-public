/**
 * サーバー起動（HTTP + Socket.IO 同居）統合テスト（要件: サーバー起動不具合の回帰防止）
 *
 * 背景（不具合）:
 *  以前の start() は `http.createServer()`（ハンドラなし）を生成後、
 *  `new SocketIOServer(server)` で engine.io の 'request' リスナを付与し、さらに
 *  `server.on('request', app)` で Express を「2 個目の 'request' リスナ」として追加していた。
 *  その結果、通常の HTTP リクエストに対し engine.io ハンドラと Express が同一 res を
 *  二重処理し、`ERR_HTTP_HEADERS_SENT`（expressInit で発生）→ 共通エラーハンドラで
 *  `res.status is not a function` → プロセス停止（ブラウザは ERR_CONNECTION_REFUSED）
 *  という連鎖でバックエンドがクラッシュしていた。
 *
 * 修正:
 *  app をリクエストハンドラとして `http.createServer(app)` を生成し（'request' リスナは app 1 個）、
 *  その同一サーバーへ Socket.IO を attach する。engine.io は /socket.io/ のみ横取りし、
 *  通常の HTTP リクエストは app が単独で処理する。
 *
 * 本テストは start() 全体（DB 接続・cron）を起動せず、start() が用いる配線の核心
 * （createApp → http.createServer(app) → Socket.IO attach）を再現し、以下を検証する:
 *  - GET /health が 200 を返し、連続リクエストでもサーバーが落ちない。
 *  - リクエストハンドラ中で発生した未処理例外が 500（共通エラーハンドラ）で返り、
 *    後続リクエストも 200 を返し続ける（プロセスが生存し続ける）。
 *  - Socket.IO を attach しても 'request' リスナは app の 1 個のみ（二重処理の回避）。
 *
 * 実装方針:
 *  supertest は導入せず Node 標準 http で実 HTTP リクエストを送る。
 *  Socket.IO はローカルの空きポートに attach し、外部接続やモックは行わない（ハーメティック）。
 *
 * @module services/serverStartup.integration.test
 */

import http from 'node:http';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';

import { createApp } from '../index.js';

/**
 * 指定サーバー（listen 済み）に対して GET を送り、ステータスとボディを取得する。
 * @param {number} port
 * @param {string} path
 * @returns {Promise<{ status: number, body: string }>}
 */
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('サーバー起動（HTTP + Socket.IO 同居）統合テスト（起動不具合の回帰防止）', () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {import('socket.io').Server} */
  let io;
  /** @type {number} */
  let port;

  beforeAll((done) => {
    // start() の核心配線を再現: 実 createApp() をハンドラに http サーバーを生成し、
    // 同一サーバーへ Socket.IO を attach する（'request' リスナは app の 1 個のみ）。
    const app = createApp();
    server = http.createServer(app);
    io = new SocketIOServer(server, { cors: { origin: '*' } });
    server.listen(0, () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    io.close();
    server.close(done);
  });

  test('GET /health が 200 を返し、連続リクエストでも落ちない', async () => {
    const first = await get(port, '/health');
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body).status).toBe('ok');

    const second = await get(port, '/health');
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body).status).toBe('ok');
  });

  test("Socket.IO を attach しても 'request' リスナは app の 1 個のみ（二重処理を回避）", () => {
    expect(server.listeners('request')).toHaveLength(1);
  });
});

describe('共通エラーハンドラ経由の 500 応答とプロセス生存（起動不具合の回帰防止）', () => {
  /** @type {import('http').Server} */
  let server;
  /** @type {import('socket.io').Server} */
  let io;
  /** @type {number} */
  let port;

  beforeAll((done) => {
    // throw するルートと、createApp 相当の末尾エラーハンドラを備えた最小 app を、
    // 実 start() と同じ「createServer(app) → io attach」順で立ち上げる。
    const app = express();
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    app.get('/boom', () => {
      throw new Error('意図的な未処理エラー（テスト）');
    });
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
      res.status(500).json({ error: 'internal_error' });
    });

    server = http.createServer(app);
    io = new SocketIOServer(server, { cors: { origin: '*' } });
    server.listen(0, () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    io.close();
    server.close(done);
  });

  test('未処理例外は 500 で返り、後続の /health は 200 を返し続ける', async () => {
    const boom = await get(port, '/boom');
    expect(boom.status).toBe(500);
    expect(JSON.parse(boom.body).error).toBe('internal_error');

    // プロセス（サーバー）が生存し、後続リクエストが正常応答する。
    const health = await get(port, '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).status).toBe('ok');
  });
});
