/**
 * Video 監視 Webhook ルーティング（会議室ライフサイクル・アーカイブ監視）
 *
 * Vonage Video API の Session Monitoring / Archive Monitoring コールバックを受ける Express Router。
 * - Session Monitoring: 接続の作成/破棄を roomLifecycleService に委譲し、全員退室で会議室を無効化
 * - Archive Monitoring: アーカイブ（録画）のステータス変更を受信し、リアルタイム通知・文字起こし自動取得を実施
 *
 * エンドポイント:
 *  - POST /webhooks/video-events        : Session Monitoring コールバック
 *  - POST /webhooks/video-archive-events: Archive Monitoring コールバック
 *
 * レスポンス方針:
 *  Vonage Webhook は 2xx を返せば受領完了とみなされる。ここで 5xx を返すと
 *  Vonage 側が再送し、重複処理の懸念を生む。そのため処理失敗も 200 を返し、
 *  詳細はサーバログにのみ記録する（at-least-once 前提で冪等に運用する）。
 *  署名検証失敗のみ 401 を返す（webhookSignature ミドルウェア）。
 *
 * 署名シークレット:
 *  - Session Monitoring: VONAGE_VIDEO_SESSION_MONITORING_SIGNATURE_SECRET
 *  - Archive Monitoring: VONAGE_VIDEO_ARCHIVE_MONITORING_SIGNATURE_SECRET
 *  （Vonage ダッシュボードでそれぞれ個別に設定されるため、別シークレットを使用）
 *
 * @module services/monitoringRoutes
 */

import { Router } from 'express';

import env from '../config/env.js';
import { parseConnectionEvent } from '../domain/sessionPresence.js';
import { createRoomLifecycleService } from './roomLifecycleService.js';
import { recordingService as defaultRecordingService } from './recordingService.js';
import { verifyVonageWebhook } from './webhookSignature.js';
import { statusEmitter as defaultStatusEmitter } from '../infra/statusEmitter.js';
import { sessionPresenceStore } from '../infra/sessionPresenceStore.js';
import { joinTokenStore } from '../infra/joinTokenStore.js';
import { reservationStore } from '../infra/reservationStore.js';
import { videoClient } from '../infra/videoClient.js';
import { roomLifecycleService as defaultRoomLifecycleService } from './roomLifecycleService.js';

// Session Monitoring 用署名検証ミドルウェア（専用シークレット）
const verifySessionMonitoringWebhook = verifyVonageWebhook({
  secret: env.vonage.videoSessionMonitoringSignatureSecret,
});

// Archive Monitoring 用署名検証ミドルウェア（専用シークレット）
const verifyArchiveMonitoringWebhook = verifyVonageWebhook({
  secret: env.vonage.videoArchiveMonitoringSignatureSecret,
});

/**
 * Video 監視 Webhook Router を生成する。テスト容易性のため依存を注入可能にする。
 *
 * @param {object} [deps]
 * @param {ReturnType<import('./roomLifecycleService.js').createRoomLifecycleService>} [deps.roomLifecycleService]
 * @param {ReturnType<import('./recordingService.js').createRecordingService>} [deps.recordingService]
 * @param {ReturnType<import('../infra/statusEmitter.js').createStatusEmitter>} [deps.statusEmitter]
 * @param {import('express').RequestHandler} [deps.verifySessionWebhook] Session Monitoring 署名検証
 * @param {import('express').RequestHandler} [deps.verifyArchiveWebhook] Archive Monitoring 署名検証
 * @param {{info?: Function, error?: Function}} [deps.logger]
 * @returns {import('express').Router}
 */
export function createMonitoringRouter({
  roomLifecycleService = defaultRoomLifecycleService,
  recordingService = defaultRecordingService,
  statusEmitter = defaultStatusEmitter,
  verifySessionWebhook = verifySessionMonitoringWebhook,
  verifyArchiveWebhook = verifyArchiveMonitoringWebhook,
  logger = console,
} = {}) {
  const router = Router();

  // roomLifecycleService が指定されていない場合、recordingService を含めて生成
  // roomLifecycleService の logger は関数 (msg, meta) => void を期待するため、
  // console.log をラップして渡す。recordingService は logger.error を使う。
  const lifecycleLogger = (msg, meta) => {
    if (logger?.info) logger.info(msg, meta);
    else console.log('[roomLifecycle]', msg, meta ?? '');
  };
  const lifecycleService = roomLifecycleService ?? createRoomLifecycleService({
    sessionPresenceStore,
    joinTokenStore,
    reservationStore,
    videoClient,
    recordingService,
    logger: lifecycleLogger,
  });

  // POST /webhooks/video-events: Video Session Monitoring コールバック
  router.post('/video-events', verifySessionWebhook, async (req, res, next) => {
    try {
      // 解析不能なペイロード（署名済みでも形式が違えば 200 で受け流す）。
      const parsed = parseConnectionEvent(req.body ?? {});
      if (!parsed) {
        if (logger.info) {
          logger.info('[monitoring] 解析できない Video イベントを受信しました。');
        }
        return res.status(200).json({ ok: true, handled: false });
      }

      const result = await lifecycleService.handleConnectionEvent(parsed);

      return res.status(200).json({
        ok: true,
        handled: result.handled,
        closed: result.closed,
      });
    } catch (err) {
      // Vonage へ 5xx を返すと再送されるため、ここでは 200 を返して
      // 再送の連鎖を防ぐ。根本原因の記録のみ行う。
      if (logger.error) {
        logger.error('[monitoring] Video イベントの処理に失敗しました:', err);
      }
      return res.status(200).json({ ok: true, handled: false, error: 'processing_failed' });
    }
  });

  // POST /webhooks/video-archive-events: Video Archive Monitoring コールバック
  // アーカイブ（録画）のステータス変更を Vonage から受信する
  router.post('/video-archive-events', verifyArchiveWebhook, async (req, res, next) => {
    try {
      const payload = req.body;

      // アーカイブイベントでなければ無視（他のモジュールのコールバックが来る可能性もあるため）
      if (payload?.event !== 'archive') {
        if (logger.info) {
          logger.info('[monitoring] アーカイブ以外のイベントを受信しました。', { event: payload?.event });
        }
        return res.status(200).json({ ok: true, handled: false });
      }

      const {
        id: archiveId,
        status,
        sessionId,
        reason,
        url: downloadUrl,
        size,
        duration,
        name,
        createdAt,
        outputMode,
        hasAudio,
        hasVideo,
      } = payload;

      if (!archiveId) {
        if (logger.warn) {
          logger.warn('[monitoring] archiveId が欠落したアーカイブイベントを受信しました。', payload);
        }
        return res.status(200).json({ ok: true, handled: false });
      }

      // 内部ステータスへのマッピング（Admin UI 用）
      const statusMap = {
        started: 'started',
        paused: 'paused',
        stopped: 'stopped',
        uploaded: 'uploaded',
        available: 'available',
        expired: 'expired',
        failed: 'start_failed', // 録画失敗として扱う
        streamAdded: 'stream_added',
        streamRemoved: 'stream_removed',
      };
      const internalStatus = statusMap[status] || status;

      // リアルタイムステータスを Admin UI へ送出（Socket.IO）
      statusEmitter.emitRecordingStatus({
        status: internalStatus,
        archiveId,
        sessionId,
        error: reason,
        downloadUrl,
        size,
        duration,
        name,
        createdAt,
        outputMode,
        hasAudio,
        hasVideo,
      });

      // アーカイブが利用可能になったら文字起こしを自動取得（ポーリング付きで待機）
      if (status === 'available' || status === 'uploaded') {
        // 非同期で実行（レスポンスをブロックしない）
        setImmediate(async () => {
          try {
            // fetchTranscriptionJson は内部でポーリングして完了を待つ
            const result = await recordingService.fetchTranscription(archiveId);
            if (result.ok) {
              statusEmitter.emitRecordingStatus({
                status: 'transcription_ready',
                archiveId,
                transcript: result.transcript,
              });
            } else {
              if (logger.error) {
                logger.error('[monitoring] 自動文字起こし取得に失敗しました。', { archiveId, error: result.message });
              }
              statusEmitter.emitRecordingStatus({
                status: 'transcription_failed',
                archiveId,
                error: result.message,
              });
            }
          } catch (err) {
            if (logger.error) {
              logger.error('[monitoring] 自動文字起こし取得中に例外が発生しました。', { archiveId, error: err?.message });
            }
            statusEmitter.emitRecordingStatus({
              status: 'transcription_failed',
              archiveId,
              error: err?.message ?? String(err),
            });
          }
        });
      }

      // 録画停止通知を受信したら録画を停止する（冪等: 既に停止済みなら Vonage が 404/409 相当を返す）
      if (status === 'stopped') {
        // 非同期で実行（レスポンスをブロックしない）
        setImmediate(async () => {
          try {
            const result = await recordingService.stopRecording(archiveId);
            if (result.ok) {
              if (result.alreadyStopped) {
                if (logger.info) {
                  logger.info('Archive Monitoring: 録画は既に停止済み', { archiveId });
                }
              } else {
                if (logger.info) {
                  logger.info('Archive Monitoring: 録画停止成功', { archiveId, sessionId });
                }
              }
            } else {
              // 既に停止済み (404/409 等) はエラーではなく正常系として扱う
              const isAlreadyStopped = result.alreadyStopped
                || result.message?.includes('404')
                || result.message?.includes('not found')
                || result.message?.includes('already stopped');
              if (isAlreadyStopped) {
                if (logger.info) {
                  logger.info('Archive Monitoring: 録画は既に停止済み', { archiveId });
                }
              } else {
                if (logger.info) {
                  logger.info('Archive Monitoring: 録画停止失敗', { archiveId, error: result.message });
                }
              }
            }
          } catch (err) {
            if (logger.error) {
              logger.error('[monitoring] Archive Monitoring: 録画停止中に例外発生', { archiveId, error: err?.message });
            }
          }
        });
      }

      // 失敗時のログ記録
      if (status === 'failed') {
        if (logger.error) {
          logger.error('[monitoring] アーカイブ録画に失敗しました。', { archiveId, sessionId, reason, outputMode });
        }
      }

      // 正常応答（Vonage へ 2xx を返して再送を防ぐ）
      return res.status(200).json({ ok: true, handled: true, status: internalStatus });
    } catch (err) {
      if (logger.error) {
        logger.error('[monitoring] Archive Monitoring イベントの処理に失敗しました:', err);
      }
      // エラーでも 200 を返して Vonage の再送を防ぐ
      return res.status(200).json({ ok: true, handled: false, error: 'processing_failed' });
    }
  });

  return router;
}

/** 既定の Video 監視 Webhook Router（実 roomLifecycleService 依存）。 */
export const monitoringRouter = createMonitoringRouter();

export default monitoringRouter;