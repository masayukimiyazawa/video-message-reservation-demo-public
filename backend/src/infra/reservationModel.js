/**
 * Reservation Mongoose モデル (インフラ層 / 要件 2.2)
 *
 * 設計書 Data Models の Reservation スキーマを Mongoose で実装する。
 * ドメイン層の定数（予約状態 enum・対応言語 {en, ja}）を再利用し、
 * enum 値の二重定義を避ける。副作用（DB 接続）はここでは行わず、
 * モデル定義のみを提供する。
 *
 * フィールド:
 *  - reservationId     予約 ID（一意）
 *  - contact           エンドユーザー連絡先（WhatsApp 番号）
 *  - reservationTime   予約時刻
 *  - service           対象サービス
 *  - status            予約状態（pending/confirmed/cancelled/completed）
 *  - language          対応言語（en/ja）
 *  - notified          予約時刻通知済みフラグ
 *  - reminderSent      リマインダー通知済みフラグ
 *  - sessionId         紐づく Vonage セッション ID
 *  - assignedStaffId   担当スタッフ（スタッフ権限判定用）
 *  - createdAt/updatedAt  タイムスタンプ（timestamps オプションで自動付与）
 */

import mongoose from 'mongoose';

import { RESERVATION_STATUSES, SUPPORTED_LANGUAGES } from '../domain/constants.js';

const { Schema, model } = mongoose;

/** @type {import('mongoose').Schema} */
export const ReservationSchema = new Schema(
  {
    reservationId: { type: String, required: true, unique: true }, // 予約 ID
    contact: { type: String, required: true }, // エンドユーザー連絡先（WhatsApp 番号）
    reservationTime: { type: Date, required: true }, // 予約時刻
    service: { type: String, required: true }, // 対象サービス
    status: {
      type: String,
      enum: RESERVATION_STATUSES, // pending/confirmed/cancelled/completed
      required: true,
    },
    language: {
      type: String,
      enum: SUPPORTED_LANGUAGES, // en/ja
      required: true,
    },
    notified: { type: Boolean, default: false }, // 予約時刻通知済みフラグ
    reminderSent: { type: Boolean, default: false }, // 事前リマインダー通知済みフラグ
    // 10分前リマインダーの通知済みフラグ。
    // reminderSent とは独立させる。共通のフラグを使うと、24時間前リマインダーが
    // 先に送信された時点で 10分前リマインダーが永久に対象外になってしまう。
    tenMinReminderSent: { type: Boolean, default: false },
    sessionId: { type: String }, // 紐づく Vonage セッション ID
    assignedStaffId: { type: String }, // 担当スタッフ（スタッフ権限判定用）
  },
  { timestamps: true }, // createdAt / updatedAt を自動付与
);

/**
 * Reservation モデル。
 * 既にコンパイル済みの場合は再利用する（テスト等でのモデル再定義エラー回避）。
 * @type {import('mongoose').Model}
 */
export const ReservationModel =
  mongoose.models.Reservation || model('Reservation', ReservationSchema);

export default ReservationModel;
