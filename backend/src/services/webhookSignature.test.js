/**
 * Vonage Webhook 署名検証ミドルウェアのテスト
 *
 * 主な検証対象:
 *  - 署名シークレット未設定時の挙動が fail-closed であること
 *    （本番想定では 503 で拒否し、next() へ流さない）
 *  - 開発環境では従来どおりスキップを許可すること
 *  - トークン欠落・署名不一致・検証例外の拒否パス
 *
 * 本プロジェクトは native ESM（transform なし）のため `jest` グローバルは
 * 注入されない。既存のテストと同じく、自作のスパイ関数を使用する。
 *
 * @module services/webhookSignature.test
 */

import { verifyVonageWebhook } from './webhookSignature.js';

/** 呼び出しを記録する自作スパイ（jest.fn 相当）。 */
function makeSpy(impl) {
  const spy = async (...args) => {
    spy.calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  spy.calls = [];
  return spy;
}

/** 最小限の req と、status/json を記録する res、および next。 */
function createReqResNext({ authorization } = {}) {
  const req = { headers: authorization === undefined ? {} : { authorization } };
  const calls = { status: [], json: [], next: 0 };
  const res = {
    status(code) {
      calls.status.push(code);
      return res;
    },
    json(body) {
      calls.json.push(body);
      return res;
    },
  };
  const next = () => {
    calls.next += 1;
  };
  return { req, res, next, calls };
}

const silentLogger = { warn() {}, error() {} };

describe('verifyVonageWebhook', () => {
  describe('シークレット未設定時の fail-closed', () => {
    it('本番（allowUnverified=false）では 503 で拒否し next() を呼ばない', async () => {
      const middleware = verifyVonageWebhook({
        secret: '',
        allowUnverified: false,
        logger: silentLogger,
      });
      const { req, res, next, calls } = createReqResNext({
        authorization: 'Bearer any-token',
      });

      await middleware(req, res, next);

      expect(calls.status).toEqual([503]);
      expect(calls.next).toBe(0);
    });

    it('本番ではトークンが正しくても next() を通さない（偽装を完全に拒否）', async () => {
      const verify = makeSpy(() => true);
      const middleware = verifyVonageWebhook({
        secret: '',
        allowUnverified: false,
        verify,
        logger: silentLogger,
      });
      const { req, res, next, calls } = createReqResNext({
        authorization: 'Bearer any-token',
      });

      await middleware(req, res, next);

      expect(calls.next).toBe(0);
      expect(verify.calls).toHaveLength(0);
    });

    it('開発環境（allowUnverified=true）では従来どおりスキップして next() を呼ぶ', async () => {
      const middleware = verifyVonageWebhook({
        secret: '',
        allowUnverified: true,
        logger: silentLogger,
      });
      const { req, res, next, calls } = createReqResNext();

      await middleware(req, res, next);

      expect(calls.next).toBe(1);
      expect(calls.status).toEqual([]);
    });

    it('拒否レスポンスにシークレット等の内部情報を含めない', async () => {
      const middleware = verifyVonageWebhook({
        secret: '',
        allowUnverified: false,
        logger: silentLogger,
      });
      const { req, res, next, calls } = createReqResNext();

      await middleware(req, res, next);

      expect(calls.json[0]).toEqual(
        expect.objectContaining({ error: 'webhook_verification_unavailable' }),
      );
    });

    it('未設定の拒否は 401（要求元の認証失敗）ではなく 503（サーバ設定不備）で返す', async () => {
      const middleware = verifyVonageWebhook({
        secret: '',
        allowUnverified: false,
        logger: silentLogger,
      });
      const { req, res, next, calls } = createReqResNext();

      await middleware(req, res, next);

      expect(calls.status).not.toContain(401);
    });
  });

  describe('シークレット設定時の検証パス', () => {
    it('有効な署名は next() を呼ぶ', async () => {
      const middleware = verifyVonageWebhook({
        secret: 'test-secret',
        verify: makeSpy(() => true),
        logger: silentLogger,
      });
      const { req, res, next, calls } = createReqResNext({ authorization: 'Bearer good' });

      await middleware(req, res, next);

      expect(calls.next).toBe(1);
      expect(calls.status).toEqual([]);
    });

    it('Authorization ヘッダが無い場合は 401', async () => {
      const middleware = verifyVonageWebhook({
        secret: 'test-secret',
        verify: makeSpy(),
        logger: silentLogger,
      });
      const { req, res, next, calls } = createReqResNext();

      await middleware(req, res, next);

      expect(calls.status).toEqual([401]);
      expect(calls.next).toBe(0);
    });

    it('署名不一致は 401', async () => {
      const middleware = verifyVonageWebhook({
        secret: 'test-secret',
        verify: makeSpy(() => false),
        logger: silentLogger,
      });
      const { req, res, next, calls } = createReqResNext({ authorization: 'Bearer bad' });

      await middleware(req, res, next);

      expect(calls.status).toEqual([401]);
      expect(calls.next).toBe(0);
    });

    it('検証が例外を投げても 401（fail-closed）', async () => {
      const middleware = verifyVonageWebhook({
        secret: 'test-secret',
        verify: makeSpy(() => {
          throw new Error('boom');
        }),
        logger: silentLogger,
      });
      const { req, res, next, calls } = createReqResNext({ authorization: 'Bearer x' });

      await middleware(req, res, next);

      expect(calls.status).toEqual([401]);
      expect(calls.next).toBe(0);
    });

    it('検証には取り出したトークンを渡す', async () => {
      const verify = makeSpy(() => true);
      const middleware = verifyVonageWebhook({
        secret: 'test-secret',
        verify,
        logger: silentLogger,
      });
      const { req, res, next } = createReqResNext({ authorization: 'Bearer abc.def.ghi' });

      await middleware(req, res, next);

      expect(verify.calls).toEqual([['abc.def.ghi', 'test-secret']]);
    });
  });
});
