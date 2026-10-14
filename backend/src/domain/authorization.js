/**
 * 認可判定（純粋関数 / 要件 5.1・5.2・5.3・5.4 / Property 7）
 *
 * ロール・操作・所有関係の組から操作の可否を判定する。
 * 副作用を持たない純粋関数として実装し、入力を変更しない。
 *
 * 判定規則:
 *  - 管理者 (administrator): すべての操作を許可する（要件 5.2）
 *  - スタッフ (staff): 自身に割り当てられた予約に対する操作のみ許可する（要件 5.3）
 *    所有関係 (ownership) は、操作者 (userId) が対象予約の担当スタッフ
 *    (assignedStaffId) と一致する場合に「所有」とみなす。
 *  - それ以外（未知のロール・非所有・不正入力）はすべて拒否する（要件 5.4）
 */

import { Role } from './constants.js';

/**
 * @typedef {import('./types.js').Ownership} Ownership
 */

/**
 * スタッフが対象予約を所有している（自身に割り当てられている）かを判定する。
 *
 * `ownership.userId` と `ownership.assignedStaffId` の双方が非空文字列で
 * 一致する場合のみ true。いずれかが欠落・空・不一致の場合は false。
 *
 * @param {Ownership} [ownership] - 所有関係コンテキスト
 * @returns {boolean}
 */
function ownsReservation(ownership) {
  if (ownership === null || typeof ownership !== 'object') {
    return false;
  }

  const { userId, assignedStaffId } = ownership;

  if (typeof userId !== 'string' || userId.length === 0) {
    return false;
  }
  if (typeof assignedStaffId !== 'string' || assignedStaffId.length === 0) {
    return false;
  }

  return userId === assignedStaffId;
}

/**
 * ロール・操作・所有関係から操作の可否を判定する純粋関数。
 *
 * @param {string} role - 操作者のロール（Role のいずれか）
 * @param {string} action - 実行しようとする操作（AuthAction のいずれか）
 * @param {Ownership} [ownership] - 対象予約との所有関係コンテキスト
 * @returns {boolean} 操作が許可される場合 true、拒否される場合 false
 */
export function canAccess(role, action, ownership) {
  // 管理者は全操作を許可（要件 5.2）
  if (role === Role.ADMINISTRATOR) {
    return true;
  }

  // スタッフは自身に割り当てられた予約に対する操作のみ許可（要件 5.3）
  if (role === Role.STAFF) {
    return ownsReservation(ownership);
  }

  // 未知のロール・不正入力はすべて拒否（要件 5.4）
  return false;
}
