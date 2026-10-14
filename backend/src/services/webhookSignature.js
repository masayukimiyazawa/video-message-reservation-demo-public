/**
 * Vonage 署名付き Webhook の検証ミドルウェア（要件 1・設計 Error Handling）
 *
 * Vonage Messages API / Video API の Webhook は JWT（署名付き Webhook）で
 * 改ざん・なりすましを防止する。受信 Webhook は信頼できない外部入力として扱い、
 * `Authorization: Bearer <JWT>` ヘッダの JWT を署名シークレットで検証する。
 *
 * 検証成功時のみ後続ハンドラへ委譲し、失敗時は HTTP 401 を返す。
 *
 * 署名シークレット未設定時の扱い（fail-closed）:
 *  - 既定（NODE_ENV=production）では、リクエストを一切信用せず HTTP 503 で拒否する。
 *    検証できない状態で「検証通過」と見なさないことが最重要（認証バイパス防止）。
 *  - NODE_ENV が production でない開発環境では、利便性のためスキップを許す。
 *    この場合も警告ログを出力する。
 *  - `allowUnverified` で明示的に上書きできる（テスト・意図的な開発用）。
 *
 * @module services/webhookSignature
 */

import env from '../config/env.js';

/**
 * Authorization ヘッダから Bearer トークン（JWT）を取り出す。
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractBearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * @vonage/jwt の verifySignature を遅延読み込みする既定検証関数。
 * @param {string} token JWT
 * @param {string} secret 署名シークレット
 * @returns {Promise<boolean>}
 */
async function defaultVerify(token, secret) {
  const { verifySignature } = await import('@vonage/jwt');
  return verifySignature(token, secret);
}

/**
 * Webhook 署名検証ミドルウェアを生成する。
 *
 * @param {object} [options]
 * @param {string} [options.secret] 署名シークレット（必須。Messages: VONAGE_MESSAGES_SIGNATURE_SECRET, Video: VONAGE_VIDEO_SIGNATURE_SECRET）
 * @param {(token: string, secret: string) => (boolean|Promise<boolean>)} [options.verify]
 *   JWT 署名検証関数（既定は @vonage/jwt の verifySignature）
 * @param {{ warn?: Function, error?: Function }} [options.logger]
 * @param {boolean} [options.allowUnverified=env.nodeEnv !== 'production']
 *   署名シークレット未設定時に検証をスキップしてよい環境かどうか。
 *   既定は本番以外のみ true。false の場合は無条件に拒否する（fail-closed）。
 * @returns {import('express').RequestHandler}
 */
export function verifyVonageWebhook({
  secret = '',
  verify = defaultVerify,
  logger = console,
  allowUnverified = env.nodeEnv !== 'production',
} = {}) {
  return async function verifyVonageWebhookMiddleware(req, res, next) {
    // 署名シークレット未設定時。
    if (!secret) {
      if (allowUnverified) {
        if (logger.warn) {
          logger.warn(
            '[webhookSignature] 署名シークレットが未設定のため署名検証をスキップします。' +
              'この設定は本番で使用しないでください（認証バイパス）。',
          );
        }
        return next();
      }
      // fail-closed: 検証できない以上、リクエストを信用しない。
      if (logger.error) {
        logger.error(
          '[webhookSignature] 署名シークレットが未設定のため Webhook を拒否します（fail-closed）。',
        );
      }
      return res.status(503).json({
        error: 'webhook_verification_unavailable',
        message: 'Webhook 署名検証が利用できない状態です。',
      });
    }

    const token = extractBearerToken(req);
    if (!token) {
      return res
        .status(401)
        .json({ error: 'unauthorized', message: 'Webhook 署名トークンがありません。' });
    }

    try {
      const valid = await verify(token, secret);
      if (!valid) {
        return res
          .status(401)
          .json({ error: 'unauthorized', message: 'Webhook 署名の検証に失敗しました。' });
      }
    } catch (err) {
      if (logger.error) logger.error('[webhookSignature] 署名検証中にエラー:', err);
      return res
        .status(401)
        .json({ error: 'unauthorized', message: 'Webhook 署名の検証に失敗しました。' });
    }

    return next();
  };
}

export default verifyVonageWebhook;
