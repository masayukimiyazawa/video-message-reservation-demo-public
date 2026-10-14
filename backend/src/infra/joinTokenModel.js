/**
 * JoinToken Mongoose モデル (インフラ層)
 *
 * パスワードレス・ワンタイム入室リンクのトークンを保持する。
 * WhatsApp で通知したリンクがここの 1 レコードに対応し、初回クリックで
 * `consumedAt` が付き、会議室の終了処理で `invalidatedAt` が付く。
 *
 * フィールド:
 *  - tokenId       トークン本体（推測不能な乱数。一意）
 *  - reservationId 発行元の予約 ID
 *  - sessionId     対象の Vonage セッション ID（＝会議室）
 *  - expiresAt     有効期限（TTL インデックスで自動削除）
 *  - consumedAt    消費日時（null なら未消費）
 *  - invalidatedAt 無効化日時（null なら有効）
 *
 * `consumedAt` / `invalidatedAt` の判定規則は domain/joinLink.js が担う。
 */

import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/** @type {import('mongoose').Schema} */
export const JoinTokenSchema = new Schema(
  {
    tokenId: { type: String, required: true, unique: true }, // リンクのトークン
    reservationId: { type: String, required: true, index: true }, // 発行元の予約
    sessionId: { type: String, required: true, index: true }, // 対象会議室
    expiresAt: { type: Date, required: true }, // 有効期限（TTL の対象）
    consumedAt: { type: Date, default: null }, // 消費日時（null = 未消費）
    invalidatedAt: { type: Date, default: null }, // 無効化日時（null = 有効）
  },
  { timestamps: true }, // createdAt / updatedAt を自動付与
);

// 期限切れトークンは MongoDB の TTL インデックスで自動削除される。
JoinTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * JoinToken モデル。既にコンパイル済みの場合は再利用する。
 * @type {import('mongoose').Model}
 */
export const JoinTokenModel =
  mongoose.models.JoinToken || model('JoinToken', JoinTokenSchema);

export default JoinTokenModel;
