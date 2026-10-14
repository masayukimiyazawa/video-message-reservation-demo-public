/**
 * バックエンドのエントリーポイント。
 *
 * createApp(deps):
 *  - 副作用を持たない（DB 接続・Socket.IO・スケジューラ起動を行わない）。
 *  - すべての API ルーターをマウントする。依存（各ルーター）は注入可能で、
 *    既定では実サービスに配線された既定ルーターを用いる。テストではモックを注入できる。
 *
 * start():
 *  - HTTP サーバーと Socket.IO サーバーを同一サーバー上に立ち上げる。
 *  - Socket.IO の実 io を statusEmitter / Notification_Service に注入し、
 *    録画状態通知（recording:status）と予約時刻通知（reservation:due）を実配線する。
 *  - MongoDB Atlas へ接続し、node-cron による通知スケジューラを開始する。
 *
 * API ルーティング（設計 API 概要）:
 *  POST /auth/login                     公開
 *  POST /webhooks/inbound-message       Vonage 署名検証
 *  POST /webhooks/message-status        Vonage 署名検証
 *  POST /webhooks/video-events          Vonage 署名検証（Video 接続監視）
 *  GET  /reservations                   管理者/スタッフ（範囲制限）
 *  POST /reservations                   管理者/スタッフ
 *  PATCH /reservations/:id              管理者/スタッフ（所有）
 *  POST /sessions/:id/token             管理者/スタッフ
 *  POST /sessions/join/:tokenId         公開（WhatsApp 入室リンクの消費）
 *  POST /recordings/start               管理者/スタッフ
 *  POST /recordings/:archiveId/stop     管理者/スタッフ
 *  GET  /transcriptions/:archiveId      管理者/スタッフ
 */

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';

import env from './config/env.js';
import { describePublicAppUrlProblem } from './config/publicAppUrl.js';
import { authRouter } from './services/authRoutes.js';
import { chatbotRouter } from './services/chatbotRoutes.js';
import {
  createReservationRouter,
  reservationRouter as defaultReservationRouter,
} from './services/reservationRoutes.js';
import { sessionRouter as defaultSessionRouter } from './services/sessionRoutes.js';
import {
  recordingRouter as defaultRecordingRouter,
  transcriptionRouter as defaultTranscriptionRouter,
  createRecordingRouter,
  createTranscriptionRouter,
} from './services/recordingRoutes.js';
import {
  createRecordingService,
} from './services/recordingService.js';
import { formatDateTime } from './domain/conversation.js';
import { createNotificationService, RESERVATION_REMINDER_EVENT } from './services/notificationService.js';
import { createStatusEmitter } from './infra/statusEmitter.js';
import { whatsAppClient } from './services/whatsAppClient.js';
import { createMonitoringRouter, monitoringRouter as defaultMonitoringRouter } from './services/monitoringRoutes.js';
import { connectToDatabase } from './infra/mongoConnection.js';
import { createSpaStatic } from './services/spaStatic.js';

/**
 * CORS で許可するオリジンの一覧を組み立てる。
 *
 * - `CLIENT_ORIGIN`: フロントを別オリジン（Vite dev server）で動かす場合の許可先
 * - `PUBLIC_APP_URL`: バックエンドが SPA も同じオリジンで配信する構成の許可先
 *   （同一オリジンなら CORS は不要だが、別オリジン運用との併存に備えて含める）
 *
 * 未設定（空文字）は混入させない。
 *
 * @returns {string[]}
 */
function buildAllowedOrigins() {
  return [...new Set([env.clientOrigin, env.publicAppUrl].filter(Boolean))];
}

/**
 * Express アプリを生成する（副作用なし・テスト可能）。
 *
 * @param {object} [deps] ルーター注入用（テスト・start での io 配線に利用）。
 * @param {import('express').Router} [deps.reservationRouter]
 * @param {import('express').Router} [deps.sessionRouter]
 * @param {import('express').Router} [deps.recordingRouter]
 * @param {import('express').Router} [deps.transcriptionRouter]
 * @returns {import('express').Express}
 */
export function createApp(deps = {}) {
  const reservationRouter = deps.reservationRouter ?? defaultReservationRouter;
  const sessionRouter = deps.sessionRouter ?? defaultSessionRouter;
  const recordingRouter = deps.recordingRouter ?? defaultRecordingRouter;
  const transcriptionRouter = deps.transcriptionRouter ?? defaultTranscriptionRouter;
  const monitoringRouter = deps.monitoringRouter ?? defaultMonitoringRouter;

  const app = express();
  app.use(cors({ origin: buildAllowedOrigins() }));
  app.use(express.json());

  // ヘルスチェック（基盤疎通確認用）
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'vonage-video-reservation-backend' });
  });

  // API ヘルスチェック（フロントエンドのプロキシ経由用）
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'vonage-video-reservation-backend' });
  });

  // 認証（ログイン・JWT 発行 / 要件 5.1）— 公開
  app.use('/auth', authRouter);

  // Chatbot_Service（WhatsApp 受信/ステータス Webhook / 要件 1）— 署名検証
  app.use('/webhooks', chatbotRouter);

  // 予約 CRUD（要件 1.3・2.1・2.4）— authorize で保護
  app.use('/reservations', reservationRouter);

  // Video トークン発行（要件 4.1・8.2）— authorize で保護
  app.use('/sessions', sessionRouter);

  // Video Session Monitoring Webhook（要件: 室ライフサイクル）— 署名検証
  app.use('/webhooks', monitoringRouter);

  // 録画開始/停止（要件 7.1・7.3）— authorize で保護
  app.use('/recordings', recordingRouter);

  // 話者分離文字起こし取得（要件 8.2）— authorize で保護
  app.use('/transcriptions', transcriptionRouter);

  // 共通エラーハンドラ（ルーターが next(err) で委譲した予期しないエラー）
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    // eslint-disable-next-line no-console
    console.error('[backend] 未処理のエラー:', err);
    res.status(500).json({ error: 'internal_error', message: 'サーバー内部エラーが発生しました。' });
  });

  // フロントエンド SPA の配信（入室リンク /join/:tokenId を 1 つの公開オリジンで開けるように）。
  // API ルーターより後に置くことで、API パスは既存の応答を優先させる。
  // 共通エラーハンドラより前でもよいが、順序依存を避けるため最後に置く。
  const spaStatic = createSpaStatic();
  if (spaStatic) {
    app.use(spaStatic);
  }

  return app;
}

/**
 * WhatsApp 送信クライアントから Notification_Service 用の送信関数を構築する。
 * 予約レコードの contact（宛先）と language に応じた通知本文を送信する（要件 3.1・6.3）。
 *
 * 本関数は通知送信時に joinLinkService を呼び出して入室リンクを発行し、
 * その URL をメッセージ本文に含める。1 通ごとに 1 回リンクを発行するため、
 * 同じ予約に 2 回通知が飛んでも 2 つ目のリンクは別トークンになる（安全側）。
 *
 * @param {object} client whatsAppClient（sendText を持つ）
 * @returns {(reservation: object) => Promise<object>}
 */
function buildNotificationSender(client) {
  return async function sendReservationDueWhatsApp(reservation) {
    // 遅延 import で循環依存を避ける
    const { joinLinkService } = await import('./services/joinLinkService.js');

    const language = reservation?.language === 'ja' ? 'ja' : 'en';

    // 入室リンクを発行（トークン ID は joinLinkService 内で生成される）。
    const { url } = await joinLinkService.issueForReservation({
      reservationId: reservation.reservationId,
      sessionId: reservation.sessionId,
      reservationTime: reservation.reservationTime,
    });

    const text =
      language === 'ja'
        ? `まもなくご予約のお時間です（${reservation?.service ?? ''}）。\n入室リンク: ${url}\n※このリンクは一度だけ有効です。`
        : `Your reservation (${reservation?.service ?? ''}) is starting soon.\nJoin link: ${url}\n※This link is one-time only.`;

    return client.sendText({ to: reservation?.contact, text });
  };
}

/**
 * WhatsApp 送信クライアントからリマインダー通知用の送信関数を構築する。
 * 予約時刻の前（リマインダーウィンドウ内）に送信する通知で、入室リンクは含めず
 * 予約のリマインドのみを行う（要件 3.1・6.3）。
 *
 * @param {object} client whatsAppClient（sendText を持つ）
 * @returns {(reservation: object) => Promise<object>}
 */
function buildReminderNotificationSender(client) {
  return async function sendReservationReminderWhatsApp(reservation) {
    const language = reservation?.language === 'ja' ? 'ja' : 'en';

    const text =
      language === 'ja'
        ? `ご予約のお時間が近づいています（${reservation?.service ?? ''}）。\n予約時刻: ${formatDateTime(reservation?.reservationTime, language)}\nご準備をお願いいたします。`
        : `Your reservation (${reservation?.service ?? ''}) is coming up.\nTime: ${formatDateTime(reservation?.reservationTime, language)}\nPlease prepare for your appointment.`;

    return client.sendText({ to: reservation?.contact, text });
  };
}

/**
 * 10分前リマインダー／手動再通知用の送信関数を構築する。
 *
 * `Notification_Service` は `sendTenMinReminderWhatsApp(reservation, outMessage)` の
 * 2 引数で呼び出す。`outMessage` はドメインの OutMessage（REPLY_BUTTON 等）なので
 * `sendOutMessage` を通し、送信失敗時は例外を投げて呼び出し側の失敗判定に乗せる。
 * （`sendText` は失敗を握りつぶして `{ok:false}` を返すだけなので判定に使えない）
 *
 * @param {object} client whatsAppClient（sendOutMessage を持つ）
 * @returns {(reservation: object, outMessage: object) => Promise<object>}
 */
function buildTenMinReminderSender(client) {
  return async function sendTenMinReminderWhatsApp(reservation, outMessage) {
    const language = reservation?.language === 'ja' ? 'ja' : 'en';
    const result = await client.sendOutMessage(outMessage, {
      to: reservation?.contact,
      language,
    });
    if (!result?.ok) {
      throw new Error(result?.error ?? 'WhatsApp 送信に失敗しました');
    }
    return result;
  };
}

/**
 * サーバーを起動する。
 *
 * - HTTP サーバーと Socket.IO を同一サーバー上に立ち上げる。
 * - 実 io を statusEmitter（recording:status）と Notification_Service
 *   （reservation:due）に注入し、io 配線済みのルーター／サービスで app を構築する。
 * - MongoDB Atlas へ接続し、node-cron の通知スケジューラを開始する（import 時ではなく
 *   ここで開始し、createApp を副作用フリーに保つ）。
 *
 * @returns {Promise<{ server: import('http').Server, io: import('socket.io').Server }>}
 */
export async function start() {
  // 起動時の配線には循環依存がある:
  //   io は http サーバーを必要とし、http サーバー（http.createServer(app)）は
  //   app を必要とし、app は io 配線済みのルーター／サービスを必要とする。
  //
  // これを、以下の 2 点を利用して解消する:
  //   - Socket.IO は「リクエストハンドラ（app）を持つ http サーバー」に後から attach できる。
  //   - statusEmitter / notificationService は io.emit を「構築時」ではなく
  //     「実行時（リクエスト処理・cron）」にのみ呼び出す。
  //
  // そこで、遅延バインドの io ホルダ（ioRef）経由でサービスへ emit を渡し、
  //   サービス → ルーター → app を先に構築 → app をハンドラとして http サーバーを生成
  //   （http.createServer(app)：request リスナは app 1 個のみ）→ その同一サーバーに
  //   実 io を attach → ioRef へ実体を差し込む、という順序で配線する。
  //
  // これにより request リスナが app の 1 個だけになり、Socket.IO の engine.io ハンドラと
  // Express が同一 res を二重処理する（ERR_HTTP_HEADERS_SENT / res.status is not a function）
  // 不具合を回避できる。
  const ioRef = { io: null };
  const emit = (event, payload) => {
    ioRef.io?.emit(event, payload);
  };

  // 1) 実行時に ioRef を参照する emit を注入したステータスエミッタと
  //    Recording_Service を構築（要件 7.4・7.5・8.5）。
  const statusEmitter = createStatusEmitter({ io: { emit } });
  const recordingService = createRecordingService({ statusEmitter });

  // 2) 同じく遅延バインドの emit と WhatsApp 送信を注入した Notification_Service を構築
  //    （要件 3.1・3.2・3.4・リマインダー通知）。
  const notificationService = createNotificationService({
    emit,
    sendWhatsApp: buildNotificationSender(whatsAppClient),
    sendReminderWhatsApp: buildReminderNotificationSender(whatsAppClient),
    // 手動再通知（sendManualJoinLink）と10分前リマインダーは sendTenMinReminderWhatsApp
    // を共有する。未注入だと未設定スタブが例外を投げて常に送信失敗になる。
    sendTenMinReminderWhatsApp: buildTenMinReminderSender(whatsAppClient),
  });

  // 3) io 配線済みのルーターで app を構築する。
  const app = createApp({
    recordingRouter: createRecordingRouter({ recordingService }),
    transcriptionRouter: createTranscriptionRouter({ recordingService }),
    monitoringRouter: createMonitoringRouter({ recordingService, statusEmitter }),
    // 通知サービスはここで構築済みの実体を渡す（router の既定値は未配線のフォールバック）。
    reservationRouter: createReservationRouter({ notificationService }),
  });

  // 4) app をリクエストハンドラとして http サーバーを生成する。
  //    これにより 'request' リスナは app の 1 個のみとなる（二重処理を防止）。
  const server = http.createServer(app);

  // 5) 同一サーバーへ Socket.IO を attach し、ioRef へ実体を差し込む。
  //    engine.io は /socket.io/ のみを横取りし、通常の HTTP リクエストは app が処理する。
  const io = new SocketIOServer(server, {
    cors: { origin: buildAllowedOrigins() },
  });
  ioRef.io = io;

  // 6) MongoDB Atlas へ接続（失敗しても通知スケジューラ等の起動は試みる）。
  try {
    await connectToDatabase();
    // eslint-disable-next-line no-console
    console.log('[backend] MongoDB Atlas へ接続しました。');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[backend] MongoDB Atlas への接続に失敗しました:', err);
  }

  // 7) node-cron による通知スケジューラを開始する（要件 3.1・3.2）。
  notificationService.startNotificationScheduler();
  // リマインダー通知スケジューラを開始する（要件 3.1）。
  notificationService.startReminderScheduler();
  // 10分前リマインダー通知スケジューラを開始する（要件 3.1・3.4）。
  notificationService.startTenMinReminderScheduler();

  // 8) 待ち受け開始。
  server.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`backend listening on port ${env.port} (${env.nodeEnv})`);

    // 本番で必須の署名シークレット未設定を起動時に明示する。
    // webhookSignature は fail-closed（503 拒否）なので、放置すると
    // 「Vonage からの Webhook が静かに届かなくなる」だけになる。起動時に警告を出す。
    if (env.nodeEnv === 'production' && !env.vonage.messagesSignatureSecret) {
      // eslint-disable-next-line no-console
      console.error(
        '[backend] 警告: VONAGE_MESSAGES_SIGNATURE_SECRET が未設定です。' +
          'fail-closed により受信 Webhook はすべて 503 で拒否され、' +
          'WhatsApp 予約機能が動作しません。',
      );
    }

    // 入室リンクの公開 URL 診断。localhost を配信すると利用者のスマホから
    // 開けないため、起動時に明示する（通知発行時は fail-closed で拒否される）。
    const publicUrlProblem = describePublicAppUrlProblem(env.publicAppUrl);
    if (publicUrlProblem) {
      // eslint-disable-next-line no-console
      console.warn(
        `[backend] 警告: ${publicUrlProblem}\n` +
          `         現在の PUBLIC_APP_URL: ${env.publicAppUrl || '(未設定)'}\n` +
          `         （参考: テスト = https://<ランダム>.trycloudflare.com / 本番 = デプロイ先の公開 URL）`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(`[backend] public app url: ${env.publicAppUrl}`);
    }
  });

  return { server, io };
}

// 直接起動された場合のみサーバーを立ち上げる（テスト時の副作用回避）
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[backend] 起動に失敗しました:', err);
    process.exit(1);
  });
}
