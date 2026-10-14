/**
 * Auth ルーティング（要件 5.1）
 *
 * POST /auth/login を提供する Express Router。Auth_Service に認証・ロール判定・
 * JWT 発行を委譲し、結果を HTTP レスポンスへ変換する。
 *
 * レスポンス:
 *  - 200: { token, user: { userId, role } }
 *  - 400: 入力（userId/password）不足
 *  - 401: 認証失敗（ユーザー不在・パスワード不一致など）
 *  - 500: 予期しないサーバーエラー（トークン発行不能等）
 */

import { Router } from 'express';

import { authService as defaultAuthService, AuthenticationError } from './authService.js';

/**
 * Auth Router を生成する。テスト容易性のため Auth_Service を注入可能にする。
 *
 * @param {object} [deps]
 * @param {{ login: (c: {userId: string, password: string}) => Promise<object> }} [deps.authService]
 * @returns {import('express').Router}
 */
export function createAuthRouter({ authService = defaultAuthService } = {}) {
  const router = Router();

  // POST /auth/login: ログイン・ロール判定・JWT 発行（要件 5.1）
  router.post('/login', async (req, res, next) => {
    const { userId, password } = req.body ?? {};

    if (!userId || !password) {
      return res
        .status(400)
        .json({ error: 'bad_request', message: 'userId と password は必須です。' });
    }

    try {
      const result = await authService.login({ userId, password });
      return res.status(200).json(result);
    } catch (err) {
      if (err instanceof AuthenticationError) {
        return res.status(401).json({ error: 'unauthorized', message: err.message });
      }
      // 予期しないエラーは共通エラーハンドラへ委譲する。
      return next(err);
    }
  });

  return router;
}

/** 既定の Auth Router（実 Auth_Service 依存）。 */
export const authRouter = createAuthRouter();

export default authRouter;
