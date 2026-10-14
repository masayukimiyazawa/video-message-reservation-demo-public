/**
 * User_Service（要件 5.1）
 *
 * 管理者/スタッフの新規作成を担うアプリケーション層。
 * 入力検証は domain/validateUserInput.js に委譲し、本モジュールは
 * 「検証 → 平文を bcrypt でハッシュ化 → UserModel へ 1 件挿入」だけを行う。
 *
 * 実装方針:
 *  - 平文パスワードをこのモジュールの外へ出さない。戻り値にも含めない。
 *  - ログイン側は authService が bcrypt.compare で照合するため、ここでは
 *    照合用のハッシュ（cost 付き）だけを保存する。
 *  - 依存（insertUser / hashPassword）を注入可能にし、DB と bcrypt を
 *    実行せずに意味論をテストする。
 */

import bcrypt from 'bcryptjs';

import { validateUserInput } from '../domain/validateUserInput.js';
import { Role } from '../domain/constants.js';
import { UserModel } from '../infra/userModel.js';

/** bcrypt の salt rounds。authService 側の compare と同一アルゴリズムになるため設定を持つ。 */
export const BCRYPT_SALT_ROUNDS = 12;

/** MongoDB の unique インデックス違反コード。userId の重複検出に使う。 */
const MONGO_DUPLICATE_KEY = 11000;

/**
 * ユーザー作成エラー。code で失敗要因を判別できるようにする。
 */
export class UserCreationError extends Error {
  /**
   * @param {string} [message]
   * @param {{ code?: string }} [options] INVALID_USER_INPUT / DUPLICATE_USER_ID / USER_CREATE_FAILED
   */
  constructor(message = 'ユーザーの作成に失敗しました。', { code = 'USER_CREATE_FAILED' } = {}) {
    super(message);
    this.name = 'UserCreationError';
    this.code = code;
  }
}

/**
 * 既定のハッシュ化。bcrypt のハッシュ文字列（$2b$...）を返す。
 * @param {string} password 平文パスワード
 * @returns {Promise<string>}
 */
async function defaultHashPassword(password) {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

/**
 * 既定の挿入。UserModel に 1 件だけ書き込み、passwordHash を除いた値を返す。
 * @param {{ userId: string, role: string, passwordHash: string }} record
 * @returns {Promise<{ userId: string, role: string }>}
 */
async function defaultInsertUser(record) {
  const created = await UserModel.create(record);
  return { userId: created.userId, role: created.role };
}

/**
 * 既定のパスワード再設定。userId をキーに passwordHash だけを差し替える。
 *
 * ロールは既存値を保持する（ログイン権限を勝手に入れ替えないため）。
 * returnDocument: 'after' により更新後のドキュメントを返すので、呼び出し側は
 * 「新規に作った」のか「既存を更新した」のかを受け取れた文書で判定できる。
 *
 * @param {{ userId: string, passwordHash: string }} record
 * @returns {Promise<{ userId: string, role: string }|null>}
 */
async function defaultUpsertUserPassword(record) {
  const updated = await UserModel.findOneAndUpdate(
    { userId: record.userId },
    { $set: { passwordHash: record.passwordHash } },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) {
    return null;
  }
  return { userId: updated.userId, role: updated.role };
}

/**
 * User_Service を生成する。依存を注入可能にし、テスト容易性を確保する。
 *
 * @param {object} [deps]
 * @param {(record: {userId: string, role: string, passwordHash: string}) => Promise<{userId: string, role: string}>} [deps.insertUser] 1 件挿入
 * @param {(password: string) => Promise<string>} [deps.hashPassword] 平文 → bcrypt ハッシュ
 * @param {(record: {userId: string, passwordHash: string}) => Promise<{userId: string, role: string}|null>} [deps.upsertUserPassword] 既存のパスワード差し替え（null は不在）
 * @returns {{
 *   createUser: (input: {userId: string, role: string, password: string}) => Promise<{userId: string, role: string}>,
 *   setUserPassword: (input: {userId: string, password: string}) => Promise<{created: boolean, user: {userId: string, role: string}}>
 * }}
 */
export function createUserService({
  insertUser = defaultInsertUser,
  hashPassword = defaultHashPassword,
  upsertUserPassword = defaultUpsertUserPassword,
} = {}) {
  /**
   * ユーザー（管理者/スタッフ）を新規作成する。
   *
   * @param {{ userId?: string, role?: string, password?: string }} input
   * @returns {Promise<{ userId: string, role: string }>} passwordHash を含まない
   * @throws {UserCreationError} 入力不正（INVALID_USER_INPUT）・userId 重複（DUPLICATE_USER_ID）時。
   *   ハッシュ化や永続化の予期しないインフラ障害は、そのまま伝播させる（握り潰さない）。
   */
  async function createUser(input) {
    const { password } = input ?? {};
    const result = validateUserInput(input);

    if (!result.ok) {
      throw new UserCreationError(result.errors.join(' / '), { code: 'INVALID_USER_INPUT' });
    }

    const passwordHash = await hashPassword(password);

    try {
      return await insertUser({
        userId: result.value.userId,
        role: result.value.role,
        passwordHash,
      });
    } catch (err) {
      if (err?.code === MONGO_DUPLICATE_KEY) {
        throw new UserCreationError(`userId「${result.value.userId}」は既に存在します。`, {
          code: 'DUPLICATE_USER_ID',
        });
      }
      throw err;
    }
  }

  /**
   * 既存ユーザーのパスワードを新しいハッシュへ差し替える。
   *
   * 平文が失われた管理者（= デモ用の管理者）の復旧経路として使う。
   * userId が存在しない場合はその userId で新規作成し、`created` で区別できる。
   *
   * セキュリティ上の注意:
   *  - ロールは変更しない。既存ユーザーの権限を勝手に変更しない。
   *  - userId の空白チェックは createUser と同じ規則で行う。
   *    （ログインが完全一致照合のため、「' admin'」のような別人を呼び違える事故を防ぐ）
   *
   * @param {{ userId?: string, password?: string }} input
   * @returns {Promise<{ created: boolean, user: { userId: string, role: string } }>}
   * @throws {UserCreationError} 入力不正（INVALID_USER_INPUT）・更新競合（DUPLICATE_USER_ID）時。
   *   ハッシュ化や永続化の予期しないインフラ障害は、そのまま伝播させる（握り潰さない）。
   */
  async function setUserPassword(input) {
    const { userId, password } = input ?? {};

    // role を渡すと role の検証で落ちるため、role は検証しない。
    const result = validateUserInput({ userId, role: Role.ADMINISTRATOR, password });

    if (!result.ok) {
      throw new UserCreationError(result.errors.join(' / '), { code: 'INVALID_USER_INPUT' });
    }

    const passwordHash = await hashPassword(password);

    try {
      const updated = await upsertUserPassword({
        userId: result.value.userId,
        passwordHash,
      });

      if (updated) {
        return { created: false, user: updated };
      }

      // 既存が居なければ、その userId で administrator として新規作成する。
      const createdUser = await insertUser({
        userId: result.value.userId,
        role: Role.ADMINISTRATOR,
        passwordHash,
      });
      return { created: true, user: createdUser };
    } catch (err) {
      if (err?.code === MONGO_DUPLICATE_KEY) {
        // findOneAndUpdate と create の間で別の実行が割り込んだ場合。
        throw new UserCreationError(
          `userId「${result.value.userId}」の更新に競合しました。時間をおいて再実行してください。`,
          { code: 'DUPLICATE_USER_ID' },
        );
      }
      throw err;
    }
  }

  return Object.freeze({ createUser, setUserPassword });
}
