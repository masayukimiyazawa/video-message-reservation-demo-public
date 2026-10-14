/**
 * SessionPresence_Store (インフラ層)
 *
 * 会議室の在室状況の永続化を担うリポジトリ。
 * 入室時は配列へ追加、退出時は該当 connectionId だけを pulling で取り除く。
 *
 * なぜ「全削除」ではなく pulling なのか:
 *  複数参加者が同時に退出しても、他の参加者の記録を巻き添えにしないため。
 *  また `openedAt` を $min で「最初の 1 回だけ」記録することで、
 *  通话開始前に空室と誤認して室を閉じる事故を防ぐ。
 */

import { SessionPresenceModel as defaultSessionPresenceModel } from './sessionPresenceModel.js';

/**
 * プレーンオブジェクトへ変換する。
 * @param {object|null} doc
 * @returns {object|null}
 */
function toPlain(doc) {
  if (!doc) {
    return null;
  }
  const { _id, ...rest } = doc;
  return { id: String(_id), ...rest };
}

/**
 * SessionPresence_Store を生成する（テストではモデルを差し替えられる）。
 *
 * @param {object} [deps]
 * @param {import('mongoose').Model} [deps.model] SessionPresenceModel
 * @returns {{
 *   addConnection: (input: {sessionId: string, connectionId: string, userId?: string|null, role?: string|null, joinedAt: Date}) => Promise<object>,
 *   removeConnection: (input: {sessionId: string, connectionId: string}) => Promise<object|null>,
 *   findBySessionId: (sessionId: string) => Promise<object|null>,
 *   markClosed: (sessionId: string, closedAt: Date) => Promise<object|null>,
 * }}
 */
export function createSessionPresenceStore({ model = defaultSessionPresenceModel } = {}) {
  /**
   * 入室を記録する（upsert）。
   * `openedAt` は $min で最初にのみ設定され、既存の非 null 値は上書きされない。
   *
   * @param {{sessionId: string, connectionId: string, userId?: string|null, role?: string|null, joinedAt: Date}} input
   * @returns {Promise<object>} 更新後の在室状況
   */
  async function addConnection({ sessionId, connectionId, userId, role, joinedAt }) {
    const updated = await model
      .findOneAndUpdate(
        { sessionId },
        {
          $push: { connections: { connectionId, userId: userId ?? null, role: role ?? null, joinedAt } },
          $min: { openedAt: joinedAt },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .lean();
    return toPlain(updated);
  }

  /**
   * 退出を記録する。該当 connectionId が無ければ何もせず、既存レコードを返す。
   *
   * @param {{sessionId: string, connectionId: string}} input
   * @returns {Promise<object|null>}
   */
  async function removeConnection({ sessionId, connectionId }) {
    const updated = await model
      .findOneAndUpdate(
        { sessionId },
        { $pull: { connections: { connectionId } } },
        { new: true },
      )
      .lean();
    return toPlain(updated);
  }

  /**
   * 現在の在室状況を取得する。
   * @param {string} sessionId
   * @returns {Promise<object|null>}
   */
  async function findBySessionId(sessionId) {
    const found = await model.findOne({ sessionId }).lean();
    return toPlain(found);
  }

  /**
   * 室を無効化する（closedAt を設定）。2 回目以降は日時を保持したまま no-op になる。
   *
   * @param {string} sessionId
   * @param {Date} closedAt
   * @returns {Promise<object|null>}
   */
  async function markClosed(sessionId, closedAt) {
    const updated = await model
      .findOneAndUpdate({ sessionId, closedAt: null }, { $set: { closedAt } }, { new: true })
      .lean();
    return toPlain(updated);
  }

  return Object.freeze({ addConnection, removeConnection, findBySessionId, markClosed });
}

/** 既定の依存で構成した SessionPresence_Store。 */
export const sessionPresenceStore = createSessionPresenceStore();

export default sessionPresenceStore;
