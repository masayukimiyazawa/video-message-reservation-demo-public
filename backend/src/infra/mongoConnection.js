/**
 * MongoDB Atlas 接続ヘルパー (インフラ層 / 要件 2.1・2.3)
 *
 * Mongoose を用いた MongoDB Atlas への接続確立・切断を担う。
 * 接続文字列は config/env.js の `mongoUri`（環境変数 MONGODB_URI）から取得する。
 *
 * 設計上の方針:
 *  - 接続失敗は握りつぶさず例外として送出する（要件 2.3）。
 *    呼び出し元（アプリケーション層）がエラー記録と失敗応答への変換を行う。
 *  - モデル定義（reservationModel.js 等）とは分離し、副作用（接続）を集約する。
 *  - 単一の Mongoose 既定コネクションを再利用する（同一プロセス内で多重接続しない）。
 */

import mongoose from 'mongoose';

import env from '../config/env.js';

/**
 * MongoDB Atlas へ接続する。
 *
 * 既に接続済み（readyState === 1）の場合は既存コネクションを再利用する。
 * `MONGODB_URI` が未設定、または接続に失敗した場合は例外を送出する。
 *
 * @param {object} [options] 追加の接続オプション
 * @param {string} [options.uri] 接続文字列（省略時は env.mongoUri）
 * @param {string} [options.dbName] データベース名（省略時は env.mongoDbName）
 * @param {import('mongoose').ConnectOptions} [options.connectOptions] Mongoose 接続オプション
 * @returns {Promise<import('mongoose').Connection>} 確立済みの Mongoose コネクション
 * @throws {Error} URI 未設定または接続失敗時
 */
export async function connectToDatabase(options = {}) {
  const uri = options.uri || env.mongoUri;
  const dbName = options.dbName || env.mongoDbName;

  if (!uri) {
    throw new Error(
      'MONGODB_URI が設定されていません。MongoDB Atlas への接続にはこの環境変数が必要です。',
    );
  }

  // 既に接続済みなら再利用（1 = connected）。
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  try {
    await mongoose.connect(uri, {
      dbName,
      ...(options.connectOptions || {}),
    });
    return mongoose.connection;
  } catch (err) {
    // 接続失敗は呼び出し元へ例外として伝播させる（要件 2.3）。
    throw new Error(`MongoDB Atlas への接続に失敗しました: ${err.message}`, { cause: err });
  }
}

/**
 * MongoDB Atlas との接続を切断する（テスト・グレースフルシャットダウン用）。
 * @returns {Promise<void>}
 */
export async function disconnectFromDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

/**
 * 現在の接続状態を返す。
 * 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
 * @returns {number}
 */
export function getConnectionState() {
  return mongoose.connection.readyState;
}

export default connectToDatabase;
