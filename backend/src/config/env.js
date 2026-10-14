/**
 * 環境変数の読み込みと集約。
 * .env は dotenv で読み込む（backend/.env を想定）。
 * 個々のキーは .env.example を参照。
 */
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// backend/.env を明示的に読み込み（テスト実行時のカレントディレクトリによらない）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../.env') });

import { resolvePublicAppUrl } from './publicAppUrl.js';

const env = {
  port: Number(process.env.PORT) || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  // CORS 許可用のオリジン（開発時は Vite dev server のポート）。
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  // エンドユーザーが実際に開く入室リンクの公開オリジン。
  // WhatsApp で受け取ったリンクは利用者の端末（スマホ）で開かれるため、
  // localhost は到達できない。CORS 用の clientOrigin とは別に必ず設定すること。
  //   - テスト（Cloudflare クイックトンネル）: https://<ランダム>.trycloudflare.com
  //   - 本番（デプロイ先）: https://<デプロイドメイン>
  // 空、または localhost のまま本番を起動した場合は警告する（index.js）。
  publicAppUrl: resolvePublicAppUrl(process.env.PUBLIC_APP_URL),

  mongoUri: process.env.MONGODB_URI || '',
  mongoDbName: process.env.MONGODB_DB_NAME || 'video_reservation',

  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',

  vonage: {
    videoApplicationId: process.env.VONAGE_VIDEO_APPLICATION_ID || '',
    videoPrivateKeyPath: process.env.VONAGE_VIDEO_PRIVATE_KEY_PATH || '',
    apiKey: process.env.VONAGE_API_KEY || '',
    apiSecret: process.env.VONAGE_API_SECRET || '',
    applicationId: process.env.VONAGE_APPLICATION_ID || '',
    privateKeyPath: process.env.VONAGE_PRIVATE_KEY_PATH || '',
    whatsappFrom: process.env.VONAGE_WHATSAPP_FROM || '',
    // Messages API (WhatsApp) 用署名シークレット
    messagesSignatureSecret: process.env.VONAGE_MESSAGES_SIGNATURE_SECRET || '',
    // Video API (Session Monitoring) 用署名シークレット
    videoSessionMonitoringSignatureSecret: process.env.VONAGE_VIDEO_SESSION_MONITORING_SIGNATURE_SECRET || '',
    // Video API (Archive Monitoring) 用署名シークレット
    videoArchiveMonitoringSignatureSecret: process.env.VONAGE_VIDEO_ARCHIVE_MONITORING_SIGNATURE_SECRET || '',
    // Messages API のホスト。空なら SDK 既定（本番: https://api.nexmo.com）。
    // Sandbox でテストする場合は https://messages-sandbox.nexmo.com を指定する。
    messagesApiHost: process.env.VONAGE_MESSAGES_API_HOST || '',
    // Messages API Sandbox は custom/interactive メッセージ非対応（HTTP 422）。
    // true にするとインタラクティブ種別をプレーンテキストにフォールバックして送信する。
    interactiveFallbackText:
      process.env.WHATSAPP_INTERACTIVE_FALLBACK_TEXT === 'true',
  },

  notificationCron: process.env.NOTIFICATION_CRON || '* * * * *',
  // リマインダー通知スケジューラ（既定: 毎時 0 分）。本番ではより頻繁（例: */15 * * * *）も可。
  notificationReminderCron: process.env.NOTIFICATION_REMINDER_CRON || '0 * * * *',
  // リマインダーウィンドウ（ミリ秒）。既定: 24 時間前（予約時刻の 24h 前以内でリマインダー送信）。
  notificationReminderWindowMs: Number(process.env.NOTIFICATION_REMINDER_WINDOW_MS) || 24 * 60 * 60 * 1000,
  // 10分前リマインダー通知スケジューラ（既定: 毎分実行）。本番では */1 * * * * も可。
  notificationTenMinReminderCron: process.env.NOTIFICATION_TEN_MIN_REMINDER_CRON || '* * * * *',
  // 10分前リマインダーウィンドウ（ミリ秒）。既定: 10分前 ± 5分（計 10分間）。
  notificationTenMinReminderWindowMs: Number(process.env.NOTIFICATION_TEN_MIN_REMINDER_WINDOW_MS) || 10 * 60 * 1000,
};

export default env;
