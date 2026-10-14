/**
 * 認可ミドルウェア authorize(action)（要件 5.2・5.3・5.4）
 *
 * 各保護エンドポイントに適用する Express ミドルウェア。JWT を検証した上で、
 * ドメイン層の純粋関数 canAccess にロール・操作・所有関係を渡して可否を判定する。
 *
 * 判定と HTTP レスポンス:
 *  - Authorization ヘッダの Bearer トークンが無い / 不正 / 期限切れ → HTTP 401
 *  - canAccess が false（権限のない操作・非所有）→ HTTP 403（要件 5.4）
 *  - canAccess が true → next() で後続ハンドラへ委譲
 *
 * 所有関係（ownership）の導出:
 *  スタッフは自身に割り当てられた予約に対してのみ操作できる（要件 5.3）。
 *  対象予約の assignedStaffId とトークンの userId を突き合わせて ownership を構築する。
 *  対象予約の解決はエンドポイントごとに異なるため、resolveOwnership を注入可能にする。
 *  省略時は、request パラメータ / body から控えめに assignedStaffId を推定する。
 */

import jwt from 'jsonwebtoken';

import env from '../config/env.js';
import { canAccess } from '../domain/authorization.js';

/**
 * Authorization ヘッダから Bearer トークンを取り出す。
 * @param {import('express').Request} req
 * @returns {string|null} トークン文字列、無ければ null
 */
function extractBearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * 既定の所有関係リゾルバ。
 *
 * リクエストから対象予約の担当スタッフ ID（assignedStaffId）を推定し、
 * canAccess に渡す ownership コンテキストを構築する。管理者はどのみち全許可のため
 * ここでの推定精度は問わない。スタッフの場合、assignedStaffId が解決できないときは
 * ownership を「非所有」として扱い、canAccess により 403 となる。
 *
 * 推定順序:
 *  1) res.locals.reservation.assignedStaffId（上流ミドルウェアが予約を読み込み済みの場合）
 *  2) req.body.assignedStaffId
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ userId: string, role: string }} user 認証済みユーザー
 * @returns {{ userId: string, assignedStaffId: (string|undefined) }}
 */
function defaultResolveOwnership(req, res, user) {
  const assignedStaffId =
    res?.locals?.reservation?.assignedStaffId ?? req?.body?.assignedStaffId ?? undefined;

  return { userId: user.userId, assignedStaffId };
}

/**
 * authorize ミドルウェアファクトリ。
 *
 * @param {string} action 保護する操作（domain/constants.js の AuthAction のいずれか）
 * @param {object} [options]
 * @param {string} [options.secret=env.jwtSecret] JWT 検証シークレット
 * @param {(req: import('express').Request, res: import('express').Response, user: {userId: string, role: string}) => (object|Promise<object>)} [options.resolveOwnership]
 *   所有関係コンテキストの導出関数。エンドポイント固有の予約解決を差し込める。
 * @returns {import('express').RequestHandler}
 */
export function authorize(action, { secret = env.jwtSecret, resolveOwnership = defaultResolveOwnership } = {}) {
  // 未定義アクション（AuthAction の取りこぼし）を早期に検出する。
  // undefined のまま canAccess に渡すと、将来 canAccess が操作種別で判定する
  // ようになった際に「意図せず全許可/全拒否」になる危険がある。
  if (typeof action !== 'string' || action.length === 0) {
    throw new Error(
      'authorize: action（AuthAction のいずれか）が指定されていません。',
    );
  }

  return async function authorizeMiddleware(req, res, next) {
    // 1) JWT の取り出しと検証（無い/不正/期限切れは 401）
    const token = extractBearerToken(req);
    if (!token) {
      return res
        .status(401)
        .json({ error: 'unauthorized', message: '認証トークンがありません。' });
    }

    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch {
      return res
        .status(401)
        .json({ error: 'unauthorized', message: '認証トークンが不正または期限切れです。' });
    }

    if (!payload || typeof payload.userId !== 'string' || typeof payload.role !== 'string') {
      return res
        .status(401)
        .json({ error: 'unauthorized', message: '認証トークンの内容が不正です。' });
    }

    const user = { userId: payload.userId, role: payload.role };
    // 後続ハンドラが参照できるよう認証済みユーザーを添付する。
    req.user = user;

    // 2) 所有関係の導出（スタッフの範囲制限用 / 要件 5.3）
    let ownership;
    try {
      ownership = await resolveOwnership(req, res, user);
    } catch (err) {
      return next(err);
    }

    // 3) 認可判定（要件 5.2・5.3・5.4）
    if (!canAccess(user.role, action, ownership)) {
      return res
        .status(403)
        .json({ error: 'forbidden', message: 'この操作を実行する権限がありません。' });
    }

    return next();
  };
}

export default authorize;
