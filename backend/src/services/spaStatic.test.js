/**
 * フロントエンド SPA 配信の回帰テスト
 *
 * 実害の不具合:
 *   入室リンク `/join/:tokenId` は React Router のクライアントサイドルートであり、
 *   バックエンドには対応するルートがない。バックエンド（4000）だけを
 *   トンネル公開している構成では、リンクを開くと Express が
 *   `Cannot GET /join/xxx` を返して入室できなかった。
 *
 * 検証の要点:
 *   - /join/:tokenId などの SPA ルートが index.html を返す
 *   - 実アセット（/assets/*.js, *.css, favicon）が正しい MIME で配信される
 *   - API/Webhook パスは index.html を返さない（JSON のまま 401/404）
 *   - dist 不在時は配信せず null を返す（Vite dev server が担当する）
 *
 * @module services/spaStatic.test
 */

import http from 'node:http';

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createSpaStatic, isApiPath, API_PATH_PREFIXES } from './spaStatic.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = resolve(here, '../../../frontend/dist');
const HAS_DIST = existsSync(join(DIST_DIR, 'index.html'));

/** テスト用の最小 app を組み立てる（API ルートを模したうえで SPA を最后に取り付ける）。 */
function makeApp() {
  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/sessions/join/:tokenId', (_req, res) => res.status(404).json({ error: 'join_token_not_found' }));
  app.use('/reservations', express.Router().use((_req, res) => res.status(401).json({ error: 'unauthorized' })));

  const spa = createSpaStatic({ distDir: DIST_DIR });
  if (spa) {
    app.use(spa);
  }
  return app;
}

/** 指定パスを Node 標準 http で叩く。 */
function request(app, path) {
  return new Promise((resolvePromise, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const req = http.request({ host: '127.0.0.1', port, path }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          server.close(() => {
            resolvePromise({
              status: res.statusCode,
              type: res.headers['content-type'] ?? '',
              body: data,
            });
          });
        });
      });
      req.on('error', (err) => server.close(() => reject(err)));
      req.end();
    });
  });
}

describe('isApiPath', () => {
  test('API/Webhook パスは true', () => {
    for (const p of ['/health', '/api/health', '/auth/login', '/sessions/join/tok', '/reservations']) {
      expect(isApiPath(p)).toBe(true);
    }
  });

  test('SPA ルートは false', () => {
    for (const p of ['/', '/join/tok-abc', '/call/sess-1', '/admin', '/login']) {
      expect(isApiPath(p)).toBe(false);
    }
  });

  test('前方一致ではなくパス境界で判定する', () => {
    // /apiary は /api ではない
    expect(isApiPath('/apiary')).toBe(false);
    expect(isApiPath('/joined')).toBe(false);
    // 完全一致も true
    expect(isApiPath('/sessions')).toBe(true);
  });

  test('定義済みのプレフィックス一覧を保持する', () => {
    expect(API_PATH_PREFIXES).toContain('/auth');
    expect(API_PATH_PREFIXES).toContain('/webhooks');
    expect(API_PATH_PREFIXES).toContain('/socket.io');
  });
});

describe('createSpaStatic', () => {
  test('enabled=false なら null（配信しない）', () => {
    expect(createSpaStatic({ enabled: false })).toBeNull();
  });

  test('dist に index.html が無ければ null（Vite dev server に任せる）', () => {
    expect(createSpaStatic({ distDir: '/nonexistent/dist/path' })).toBeNull();
  });

  (HAS_DIST ? test : test.skip)('SPA ルートは index.html を返す', async () => {
    const app = makeApp();

    for (const path of ['/join/tok-abc', '/call/sess-1', '/admin', '/login', '/']) {
      const res = await request(app, path);
      expect(res.status).toBe(200);
      expect(res.type).toContain('text/html');
      // アプリの index.html であること
      expect(res.body).toContain('id="root"');
    }
  });

  (HAS_DIST ? test : test.skip)('API パスは index.html を返さない（JSON のまま）', async () => {
    const app = makeApp();

    const health = await request(app, '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: 'ok' });

    // 認証で弾かれる API は 401 JSON
    const reservations = await request(app, '/reservations');
    expect(reservations.status).toBe(401);
    expect(reservations.body).not.toContain('id="root"');

    // API の 404 も Express 既定のまま（index.html に化けない）
    const join = await request(app, '/sessions/join/unknown');
    expect(join.status).toBe(404);
    expect(join.body).not.toContain('id="root"');
  });

  (HAS_DIST ? test : test.skip)('実アセットは index.html ではなく実体を配信する', async () => {
    const app = makeApp();

    const favicon = await request(app, '/favicon.svg');
    expect(favicon.status).toBe(200);
    expect(favicon.type).toContain('image/svg+xml');
    expect(favicon.body).not.toContain('id="root"');
  });
});
