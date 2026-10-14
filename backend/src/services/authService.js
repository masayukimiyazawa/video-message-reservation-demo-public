/**
 * Auth_Service（RBAC / JWT / 要件 5.1）
 *
 * ユーザーの認証（資格情報検証）・ロール判定・JWT 発行を担うアプリケーション層。
 * ドメイン層の認可判定（canAccess）とは責務を分離し、本モジュールは
 * 「誰であるか（認証）」と「トークン発行」に専念する。認可判定（「何が
 * できるか」）は domain/authorization.js の canAccess と authorize
 * ミドルウェア（authMiddleware.js）が担う。
 *
 * 実装方針:
 *  - パスワード照合には bcryptjs を用いる（保存済み User.passwordHash と比較）。
 *    ※ プロジェクトに既存のハッシュ実装が無かったため bcryptjs を採用（新規依存）。
 *  - JWT には userId と role を格納し、config/env.js の jwtSecret / jwtExpiresIn を用いる。
 *  - ユーザー取得は既定で infra の UserModel を用いるが、テスト容易性のため
 *    依存（userModel / verifyPassword）を注入可能にする。
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import env from '../config/env.js';
import { ROLES } from '../domain/constants.js';
import { UserModel } from '../infra/userModel.js';

/**
 * 認証エラー。資格情報が不正な場合（ユーザー不在・パスワード不一致・入力欠落）に送出する。
 * ルート層はこれを捕捉して HTTP 401 に変換する。
 */
export class AuthenticationError extends Error {
  constructor(message = '認証に失敗しました。') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/**
 * 平文パスワードと保存済みハッシュを照合する（既定実装 / bcryptjs）。
 * @param {string} password 平文パスワード
 * @param {string} passwordHash 保存済みハッシュ
 * @returns {Promise<boolean>}
 */
async function defaultVerifyPassword(password, passwordHash) {
  if (typeof password !== 'string' || typeof passwordHash !== 'string') {
    return false;
  }
  return bcrypt.compare(password, passwordHash);
}

/**
 * userId から User を取得する（既定実装 / Mongoose UserModel）。
 * @param {string} userId
 * @returns {Promise<{userId: string, role: string, passwordHash: string}|null>}
 */
async function defaultFindUserById(userId) {
  return UserModel.findOne({ userId }).lean();
}

/**
 * userId と role から JWT を発行する。
 *
 * @param {{ userId: string, role: string }} payload トークンに含める最小情報
 * @param {object} [options]
 * @param {string} [options.secret=env.jwtSecret] 署名シークレット
 * @param {string|number} [options.expiresIn=env.jwtExpiresIn] 有効期限
 * @returns {string} 署名済み JWT
 * @throws {Error} シークレット未設定時
 */
export function issueToken(
  { userId, role },
  { secret = env.jwtSecret, expiresIn = env.jwtExpiresIn } = {},
) {
  if (!secret) {
    throw new Error('JWT_SECRET が未設定のためトークンを発行できません。');
  }
  return jwt.sign({ userId, role }, secret, { expiresIn });
}

/**
 * Auth_Service を生成する。依存を注入可能にし、テスト容易性を確保する。
 *
 * @param {object} [deps]
 * @param {(userId: string) => Promise<object|null>} [deps.findUserById] ユーザー取得
 * @param {(password: string, hash: string) => Promise<boolean>} [deps.verifyPassword] パスワード照合
 * @param {string} [deps.jwtSecret] 署名シークレット
 * @param {string|number} [deps.jwtExpiresIn] トークン有効期限
 * @returns {{ login: (credentials: {userId: string, password: string}) => Promise<{token: string, user: {userId: string, role: string}}> }}
 */
export function createAuthService({
  findUserById = defaultFindUserById,
  verifyPassword = defaultVerifyPassword,
  jwtSecret = env.jwtSecret,
  jwtExpiresIn = env.jwtExpiresIn,
} = {}) {
  /**
   * ログイン処理: 資格情報を検証し、ロールを判定して JWT を発行する（要件 5.1）。
   *
   * @param {{ userId: string, password: string }} credentials
   * @returns {Promise<{ token: string, user: { userId: string, role: string } }>}
   * @throws {AuthenticationError} 入力欠落・ユーザー不在・パスワード不一致・不正ロール時
   */
  async function login(credentials) {
    const { userId, password } = credentials ?? {};

    if (typeof userId !== 'string' || userId.length === 0) {
      throw new AuthenticationError('userId は必須です。');
    }
    if (typeof password !== 'string' || password.length === 0) {
      throw new AuthenticationError('password は必須です。');
    }

    const user = await findUserById(userId);
    if (!user) {
      // ユーザーの存在有無を秘匿するため、一般的な認証失敗メッセージを返す。
      throw new AuthenticationError();
    }

    const passwordMatches = await verifyPassword(password, user.passwordHash);
    if (!passwordMatches) {
      throw new AuthenticationError();
    }

    // ロール（管理者/スタッフ）判定（要件 5.1）。想定外のロールは拒否する。
    if (!ROLES.includes(user.role)) {
      throw new AuthenticationError('ユーザーのロールが不正です。');
    }

    const token = issueToken(
      { userId: user.userId, role: user.role },
      { secret: jwtSecret, expiresIn: jwtExpiresIn },
    );

    return {
      token,
      user: { userId: user.userId, role: user.role },
    };
  }

  return Object.freeze({ login });
}

/** 既定の Auth_Service インスタンス（実インフラ依存）。 */
export const authService = createAuthService();

export default authService;
