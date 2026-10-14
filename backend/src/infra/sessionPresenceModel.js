/**
 * SessionPresence Mongoose モデル (インフラ層)
 *
 * 会議室の在室状況を 1 セッション 1 レコードで保持する。
 * Vonage Video の接続イベント（connectionCreated / connectionDestroyed）ごとに
 * `connections` 配列を更新し、全員退室（0 件）になったことを判定する材料にする。
 *
 * フィールド:
 *  - sessionId  Vonage セッション ID（＝会議室）。一意
 *  - connections 現在の接続一覧（connectionId / userId / role / joinedAt）
 *  - openedAt 初めて誰か入室した時刻（null なら未使用）
 *  - closedAt  室を無効化した時刻（null なら有効）
 *
 * 判定規則は domain/sessionPresence.js が担う。
 */

import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/** @type {import('mongoose').Schema} */
export const ConnectionSchema = new Schema(
  {
    connectionId: { type: String, required: true }, // Vonage の接続 ID
    userId: { type: String, default: null }, // 話者分離の識別子（connection data 由来）
    role: { type: String, default: null }, // administrator / staff / guest
    joinedAt: { type: Date, required: true }, // 入室時刻
  },
  { _id: false },
);

/** @type {import('mongoose').Schema} */
export const SessionPresenceSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true }, // 会議室
    connections: { type: [ConnectionSchema], default: [] }, // 現在の在室接続
    openedAt: { type: Date, default: null }, // 初めて入室した時刻
    closedAt: { type: Date, default: null }, // 無効化済みならその時刻
  },
  { timestamps: true },
);

/**
 * SessionPresence モデル。既にコンパイル済みの場合は再利用する。
 * @type {import('mongoose').Model}
 */
export const SessionPresenceModel =
  mongoose.models.SessionPresence || model('SessionPresence', SessionPresenceSchema);

export default SessionPresenceModel;
