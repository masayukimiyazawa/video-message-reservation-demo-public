/**
 * Webhook 署名検証の「既定の挙動」を実環境で検証するテスト（fail-closed の回帰防止）。
 *
 * 単体のユニットテスト（webhookSignature.test.js）は `allowUnverified` を明示して
 * 分岐を検証する。ここでは明示しない（＝実際のアプリと同じ既定値）経路について、
 * NODE_ENV=production かつ VONAGE_SIGNATURE_SECRET 未設定の実プロセスで
 * 実際に HTTP リクエストを送り、503 で拒否されることを確認する。
 *
 * 併せて development では従来どおりスキップされること、
 * シークレット設定済みなら偽造 JWT が 401 になることも確認する。
 *
 * @module services/webhookSignature.default.test
 */

import { spawn } from 'node:child_process';

const SERVER_SOURCE = `
import http from 'node:http';
import express from 'express';
import { verifyVonageWebhook } from './src/services/webhookSignature.js';

const app = express();
app.use(express.json());
// Messages API 用シークレットを明示的に渡す
import env from './src/config/env.js';
app.post('/webhooks/inbound-message', verifyVonageWebhook({ secret: env.vonage.messagesSignatureSecret }), (req, res) => res.status(200).json({ ok: true }));

const server = http.createServer(app);
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }));
});
`;

/**
 * 指定した NODE_ENV / シークレット設定で実サーバーを起動し、Webhook へ POST して
 * レスポンスを返す。サーバープロセスは必ず kill する。
 *
 * @param {{ nodeEnv: string, withSecret: boolean }} options
 * @returns {Promise<{ status: number, body: any }>}
 */
async function postWebhook({ nodeEnv, withSecret }) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', SERVER_SOURCE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
      // dotenv は既存の process.env キーを上書きしないため、空文字で未設定相当にする。
      VONAGE_MESSAGES_SIGNATURE_SECRET: withSecret ? 'integration-test-secret' : '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('server start timeout')), 15_000);
      child.stdout.on('data', (d) => {
        buf += d;
        if (buf.includes('"port"')) {
          try {
            clearTimeout(timer);
            resolve(JSON.parse(buf).port);
          } catch {
            /* 出力途中なら次の data を待つ */
          }
        }
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`server exited early: ${code}\n${buf}`)));
    });

    const res = await fetch(`http://127.0.0.1:${port}/webhooks/inbound-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer forged.jwt.token' },
      body: JSON.stringify({ from: '447700900000' }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    child.kill('SIGKILL');
  }
}

describe('verifyVonageWebhook の既定の挙動（実プロセス）', () => {
  it(
    'NODE_ENV=production かつ署名シークレット未設定なら 503 で拒否する',
    async () => {
      const result = await postWebhook({ nodeEnv: 'production', withSecret: false });

      expect(result.status).toBe(503);
      expect(result.body).toEqual(
        expect.objectContaining({ error: 'webhook_verification_unavailable' }),
      );
    },
    30_000,
  );

  it(
    'NODE_ENV=development かつ署名シークレット未設定なら開発用スキップで 200',
    async () => {
      const result = await postWebhook({ nodeEnv: 'development', withSecret: false });

      expect(result.status).toBe(200);
    },
    30_000,
  );

  it(
    'NODE_ENV=production かつ署名シークレット設定済みなら、偽造 JWT は 401',
    async () => {
      const result = await postWebhook({ nodeEnv: 'production', withSecret: true });

      expect(result.status).toBe(401);
    },
    30_000,
  );
});
