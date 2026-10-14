/**
 * JoinToken_Store (インフラ層)
 *
 * ワンタイム入室リンクの永続化を担うリポジトリ。
 * 副作用（DB アクセス）をこの層に閉じ込め、サービス層は意味論だけを扱う。
 *
 * 原子性についての設計:
 *  - `consume` は「未消費かつ期限内のトークン」のときだけ `consumedAt` を書き込む
 *    `findOneAndUpdate` で行う。これにより 2 人が同時にリンクをクリックしても
 *    片方だけが成功する（一度だけ有効이라는要件を満たす）。
 *  - `invalidateBySessionId` は室の無効化時に、残った未消費リンクをまとめて無効化する。
 */

import { JoinTokenModel as defaultJoinTokenModel } from './joinTokenModel.js';

/**
 * プレーンオブジェクトへ変換する（_id を除外し、Date は保持）。
 * @param {object|null} doc Mongoose ドキュメント
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
 * JoinToken_Store を生成する（テストではモデルを差し替えられる）。
 *
 * @param {object} [deps]
 * @param {import('mongoose').Model} [deps.model] JoinTokenModel
 * @returns {{
 *   issue: (input: {tokenId: string, reservationId: string, sessionId: string, expiresAt: Date}) => Promise<object>,
 *   findByTokenId: (tokenId: string) => Promise<object|null>,
 *   consume: (tokenId: string, now: Date) => Promise<object|null>,
 *   invalidateBySessionId: (sessionId: string, now: Date) => Promise<number>,
 *   isSessionInvalidated: (sessionId: string) => Promise<boolean>,
 * }}
 */
export function createJoinTokenStore({ model = defaultJoinTokenModel } = {}) {
  /**
   * 入室トークンを発行する。
   * @param {{tokenId: string, reservationId: string, sessionId: string, expiresAt: Date}} input
   * @returns {Promise<object>} 保存後のレコード
   */
  async function issue({ tokenId, reservationId, sessionId, expiresAt }) {
    const created = await model.create({
      tokenId,
      reservationId,
      sessionId,
      expiresAt,
      consumedAt: null,
      invalidatedAt: null,
    });
    return toPlain(created.toObject ? created.toObject() : created);
  }

  /**
   * トークンを ID で引き直す。
   * @param {string} tokenId
   * @returns {Promise<object|null>}
   */
  async function findByTokenId(tokenId) {
    const found = await model.findOne({ tokenId }).lean();
    return toPlain(found);
  }

  /**
   * トークンを消費済みにする（未消費かつ期限内のときだけ成功する）。
   *
   * 条件に `consumedAt: null` を含めることで、同時クリック時の一方だけが成功する。
   *
   * @param {string} tokenId
   * @param {Date} now 消費判定の基準時刻
   * @returns {Promise<object|null>} 消費できた場合は更新後のレコード、それ以外は null
   */
  async function consume(tokenId, now) {
    const updated = await model
      .findOneAndUpdate(
        { tokenId, consumedAt: null, invalidatedAt: null, expiresAt: { $gt: now } },
        { $set: { consumedAt: now } },
        { new: true },
      )
      .lean();
    return toPlain(updated);
  }

  /**
   * 室が無効化されたタイミングで、その室の未消費トークンをすべて無効化する。
   * @param {string} sessionId
   * @param {Date} now
   * @returns {Promise<number>} 無効化した件数
   */
  async function invalidateBySessionId(sessionId, now) {
    const result = await model.updateMany(
      { sessionId, invalidatedAt: null },
      { $set: { invalidatedAt: now } },
    );
    return result?.modifiedCount ?? 0;
  }

  /**
   * その室に紐づくトークンが既に無効化されているかを返す。
   *
   * 在室記録（Session_Presence）が無い場合でも室の無効化を判定できるよう使う。
   * トークンが 1 件も無い場合は「無効化されていない（＝未使用）」を返す。
   *
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async function isSessionInvalidated(sessionId) {
    const tokens = await model.find({ sessionId }).lean();
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return false;
    }
    return tokens.every((t) => t.invalidatedAt != null);
  }

  return Object.freeze({
    issue,
    findByTokenId,
    consume,
    invalidateBySessionId,
    isSessionInvalidated,
  });
}

/** 既定の依存で構成した JoinToken_Store。 */
export const joinTokenStore = createJoinTokenStore();

export default joinTokenStore;
