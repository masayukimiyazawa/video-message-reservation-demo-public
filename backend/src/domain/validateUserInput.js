/**
 * ユーザー作成入力の検証 (要件 5.1)
 *
 * 管理者/スタッフを新規登録する seeding 経路が使う、純粋な入力検証。
 * I/O も SDK も Express も含まず、`./constants.js` だけを import する。
 *
 * 設計上の判断:
 *  - userId は前後の空白・内部空白を許さない。ログインは完全一致で照合するため、
 *    不可視な差異でログインできなくなる事故を防ぐ。
 *  - password は trim しない。前後空白も、利用者が意図したパスワードの一部として扱う。
 */

import { ROLES } from './constants.js';

/**
 * パスワードの最小文字数。
 * 平文保存はしない前提のため、bcrypt 化前の段階で弱いパスワードを弾く。
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * ユーザー作成入力を検証する。
 *
 * @param {{ userId?: unknown, role?: unknown, password?: unknown }} [input]
 * @returns {{
 *   ok: boolean,
 *   errors: readonly string[],
 *   value: Readonly<{ userId: string, role: string }>|null
 * }} 検証結果。`value` は正規化済み userId/role（ok が true のときのみ）。
 */
export function validateUserInput(input) {
  const errors = [];
  const { userId, role, password } = input ?? {};

  let normalizedUserId = null;
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    errors.push('userId は必須です。');
  } else if (userId !== userId.trim()) {
    errors.push('userId の前後に空白を含めることはできません。');
  } else if (/\s/.test(userId)) {
    errors.push('userId に空白を含めることはできません。');
  } else {
    normalizedUserId = userId;
  }

  const normalizedRole = ROLES.includes(role) ? role : null;
  if (normalizedRole === null) {
    errors.push(`role は ${ROLES.join(' / ')} のいずれかです。`);
  }

  if (typeof password !== 'string' || password.length === 0) {
    errors.push('password は必須です。');
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`password は ${MIN_PASSWORD_LENGTH} 文字以上で入力してください。`);
  }

  const ok = errors.length === 0;
  return Object.freeze({
    ok,
    errors: Object.freeze(errors),
    value: ok ? Object.freeze({ userId: normalizedUserId, role: normalizedRole }) : null,
  });
}
