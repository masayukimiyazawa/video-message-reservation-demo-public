/**
 * User Mongoose モデル (インフラ層 / 要件 5.1)
 *
 * 設計書 Data Models の User スキーマを Mongoose で実装する。
 * 管理者/スタッフのロールはドメイン層の定数（ROLES）を再利用する。
 *
 * フィールド:
 *  - userId        ユーザー ID（一意）
 *  - role          ロール（administrator/staff）
 *  - passwordHash  ハッシュ化済みパスワード
 */

import mongoose from 'mongoose';

import { ROLES } from '../domain/constants.js';

const { Schema, model } = mongoose;

/** @type {import('mongoose').Schema} */
export const UserSchema = new Schema({
  userId: { type: String, required: true, unique: true },
  role: {
    type: String,
    enum: ROLES, // administrator/staff
    required: true,
  },
  passwordHash: { type: String, required: true },
});

/**
 * User モデル。
 * 既にコンパイル済みの場合は再利用する。
 * @type {import('mongoose').Model}
 */
export const UserModel = mongoose.models.User || model('User', UserSchema);

export default UserModel;
