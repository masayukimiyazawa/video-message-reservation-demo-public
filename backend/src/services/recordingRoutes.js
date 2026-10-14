/**
 * Recording / Transcription ルーティング（要件 7.1・7.3・8.2）
 *
 * 録画開始/停止と話者分離文字起こし取得を提供する Express Router。
 * authorize ミドルウェアで保護し（管理者/スタッフ）、Recording_Service /
 * Transcription_Service に委譲する。サービスの結果コードを HTTP ステータスへ
 * 対応付ける。
 *
 * エンドポイント（設計 API 概要）:
 *  - POST /recordings/start            録画開始（START_RECORDING）
 *  - POST /recordings/:archiveId/stop  録画停止（STOP_RECORDING）
 *  - GET  /recordings                  録画一覧取得（VIEW_RECORDING）
 *  - GET  /transcriptions/:archiveId    話者分離文字起こし取得（VIEW_TRANSCRIPTION）
 *  - GET  /transcriptions              文字起こし一覧取得（VIEW_TRANSCRIPTION）
 *
 * `/recordings` と `/transcriptions` はマウントパスが異なるため、Router を 2 つ提供する。
 *
 * 結果コード → HTTP 対応:
 *  - validation_error → 400
 *  - start_failed / stop_failed / transcription_failed → 502（外部 Vonage API 起因）
 *  - ARCHIVE_NOT_DELETABLE → 409（処理中・期限切れ等で削除不可）
 *
 * @module services/recordingRoutes
 */

import { Router } from 'express';

import { recordingService as defaultRecordingService } from './recordingService.js';
import { authorize as defaultAuthorize } from './authMiddleware.js';
import { AuthAction } from '../domain/constants.js';
import { videoClient as defaultVideoClient } from '../infra/videoClient.js';

/** Recording_Service / VideoClient の結果コード → HTTP ステータスの対応表。 */
const ERROR_STATUS = Object.freeze({
  validation_error: 400,
  start_failed: 502,
  stop_failed: 502,
  transcription_failed: 502,
  // VideoClient は外部 Vonage API 起因の失敗を大文字コードで返す（infra/videoClient.js）。
  VIDEO_API_ERROR: 502,
  // 409: アーカイブが available/uploaded でなく削除不可（処理中・期限切れ等）。
  ARCHIVE_NOT_DELETABLE: 409,
});

/**
 * サービスの失敗結果を適切な HTTP ステータスで返す。
 * @param {import('express').Response} res
 * @param {{ code?: string }} result
 * @returns {import('express').Response}
 */
function sendFailure(res, result) {
  const status = ERROR_STATUS[result?.code] ?? 500;
  return res.status(status).json(result);
}

/**
 * Recording Router（`/recordings`）を生成する。
 *
 * @param {object} [deps]
 * @param {ReturnType<import('./recordingService.js').createRecordingService>} [deps.recordingService]
 * @param {typeof defaultAuthorize} [deps.authorize]
 * @returns {import('express').Router}
 */
export function createRecordingRouter({
  recordingService = defaultRecordingService,
  authorize = defaultAuthorize,
  videoClient = defaultVideoClient,
} = {}) {
  const router = Router();

  // POST /recordings/start: 録画開始（要件 7.1・7.2）
  router.post('/start', authorize(AuthAction.START_RECORDING), async (req, res, next) => {
    try {
      const result = await recordingService.startRecording(req.body ?? {});
      if (result.ok) {
        return res.status(201).json({ archive: result.archive });
      }
      return sendFailure(res, result);
    } catch (err) {
      return next(err);
    }
  });

  // POST /recordings/:archiveId/stop: 録画停止（要件 7.3）
  router.post('/:archiveId/stop', authorize(AuthAction.STOP_RECORDING), async (req, res, next) => {
    try {
      const result = await recordingService.stopRecording(req.params.archiveId);
      if (result.ok) {
        return res.status(200).json({ archive: result.archive });
      }
      return sendFailure(res, result);
    } catch (err) {
      return next(err);
    }
  });

  // GET /recordings: 録画一覧取得（要件 7.4・管理画面用）
  router.get('/', authorize(AuthAction.VIEW_RECORDING), async (req, res, next) => {
    try {
      const result = await videoClient.getArchives();
      if (!result.ok) {
        return sendFailure(res, result);
      }
      // 録画本体の URL（downloadUrl）と、文字起こし URL（transcription.url）を明確に分離する。
      // 一覧 API は transcription の URL を含まないことが多いため、必要なら getArchive で解決する。
      const archives = await Promise.all(
        (result.archives || []).map(async (archive) => {
          const id = archive.id || archive.archiveId;
          // 録画本体のダウンロード URL
          const downloadUrl = archive.url ?? archive.downloadUrl;
          const base = {
            ...archive,
            id,
            archiveId: id,
            downloadUrl,
          };
          if (!(archive.hasTranscription || archive.transcription)) {
            return base;
          }
          const resolved = await resolveTranscribedArchive(archive, videoClient);
          // downloadUrl は録画本体（mp4）を保持。文字起こし URL は transcription.url に保持。
          return { ...resolved, downloadUrl };
        }),
      );
      return res.status(200).json({ archives });
    } catch (err) {
      return next(err);
    }
  });

  // GET /recordings/:archiveId: 録画詳細取得（任意）
  router.get('/:archiveId', authorize(AuthAction.VIEW_RECORDING), async (req, res, next) => {
    try {
      const result = await videoClient.getArchives();
      if (!result.ok) {
        return sendFailure(res, result);
      }
      const archive = (result.archives || []).find(
        (a) => a.archiveId === req.params.archiveId || a.id === req.params.archiveId,
      );
      if (!archive) {
        return res.status(404).json({ error: 'Archive not found' });
      }
      return res.status(200).json({ archive });
    } catch (err) {
      return next(err);
    }
  });

  // DELETE /recordings/:archiveId: 録画（アーカイブ）削除
  router.delete('/:archiveId', authorize(AuthAction.STOP_RECORDING), async (req, res, next) => {
    try {
      const result = await recordingService.deleteRecording(req.params.archiveId);
      if (result.ok) {
        return res.status(200).json({ ok: true, message: '録画を削除しました' });
      }
      return sendFailure(res, result);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

/**
 * 一覧レスポンス用に文字起こし可能なアーカイブを正規化する。
 *
 * 一覧 API（`getArchives`）は文字起こしの URL を含まないことが多いため、
 * 必要に応じて `getArchive` で個別解決する（予約単位の `/reservations/:id/transcriptions`
 * と同じフォールバック）。また実 Vonage の `listArchives` には `hasTranscription`
 * フィールドが存在しないため、`transcription` の有無で判定できるよう補正する。
 * これがないと本番で一覧が空になり、管理画面にダウンロード/表示ボタンが出ない。
 *
 * 重要: downloadUrl は「録画本体（mp4）」を指し、transcription.url は「文字起こし ZIP」を指す。
 * これらを混同しないよう明確に分離する。
 *
 * @param {object} archive Vonage アーカイブ
 * @param {typeof defaultVideoClient} videoClient
 * @returns {Promise<object>} 正規化済みアーカイブ
 */
async function resolveTranscribedArchive(archive, videoClient) {
  const id = archive.id || archive.archiveId;
  // 録画本体のダウンロード URL（mp4）
  const downloadUrl = archive.url ?? archive.downloadUrl;
  // 文字起こし URL（ZIP）
  let transcriptionUrl = archive.transcription?.url;
  let language = archive.transcription?.primaryLanguageCode || archive.language;

  // 一覧に transcription.url が無い場合、個別取得で解決を試みる
  if (!transcriptionUrl && id && typeof videoClient.getArchive === 'function') {
    try {
      const full = await videoClient.getArchive(id);
      if (full?.transcription) {
        transcriptionUrl = full.transcription.url;
        language = full.transcription.primaryLanguageCode || language;
      }
    } catch {
      // 個別取得に失敗しても一覧全体は返す。
    }
  }

  const transcription = transcriptionUrl ? { url: transcriptionUrl, primaryLanguageCode: language } : undefined;

  return {
    ...archive,
    id,
    archiveId: id,
    hasTranscription: !!transcriptionUrl,
    downloadUrl,          // 録画本体（mp4）
    language,
    transcription,        // { url, primaryLanguageCode } or undefined
  };
}

/**
 * Transcription Router（`/transcriptions`）を生成する。
 *
 * @param {object} [deps]
 * @param {ReturnType<import('./recordingService.js').createRecordingService>} [deps.recordingService]
 * @param {typeof defaultAuthorize} [deps.authorize]
 * @param {typeof defaultVideoClient} [deps.videoClient]
 * @returns {import('express').Router}
 */
export function createTranscriptionRouter({
  recordingService = defaultRecordingService,
  authorize = defaultAuthorize,
  videoClient = defaultVideoClient,
} = {}) {
  const router = Router();

  // GET /transcriptions/:archiveId: 話者分離文字起こし取得（要件 8.2・8.3）
  router.get('/:archiveId', authorize(AuthAction.VIEW_TRANSCRIPTION), async (req, res, next) => {
    try {
      const result = await recordingService.fetchTranscription(req.params.archiveId);
      if (result.ok) {
        return res.status(200).json({ transcript: result.transcript });
      }
      return sendFailure(res, result);
    } catch (err) {
      return next(err);
    }
  });

  // DELETE /transcriptions/:archiveId: 文字起こし（トランスクリプション）削除
  router.delete('/:archiveId', authorize(AuthAction.VIEW_TRANSCRIPTION), async (req, res, next) => {
    try {
      const result = await recordingService.deleteRecording(req.params.archiveId);
      if (result.ok) {
        return res.status(200).json({ ok: true, message: '文字起こしを削除しました' });
      }
      return sendFailure(res, result);
    } catch (err) {
      return next(err);
    }
  });

  // GET /transcriptions: 文字起こし一覧取得（要件 8.5・管理画面用）
  router.get('/', authorize(AuthAction.VIEW_TRANSCRIPTION), async (req, res, next) => {
    try {
      // 文字起こし一覧はアーカイブ一覧から取得（transcription ありのもの）。
      // 注入された videoClient を用いる（動的 import で DI を迂回しない）。
      const result = await videoClient.getArchives();
      if (!result.ok) {
        return sendFailure(res, result);
      }
      // 実 Vonage の一覧には hasTranscription が無いため transcription の有無で判定する。
      const source = (result.archives || []).filter((a) => a && (a.hasTranscription || a.transcription));
      const transcriptions = await Promise.all(
        source.map(async (archive) => {
          const normalized = await resolveTranscribedArchive(archive, videoClient);
          // /transcriptions エンドポイントでは、フロント互換のため downloadUrl を文字起こし URL にする。
          // （TranscriptionPanel は archive.downloadUrl || archive.transcription?.url を使用するため）
          if (normalized.transcription?.url) {
            return { ...normalized, downloadUrl: normalized.transcription.url };
          }
          return normalized;
        }),
      );
      return res.status(200).json({ transcriptions });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

/** 既定の Recording Router（実 Recording_Service 依存）。 */
export const recordingRouter = createRecordingRouter();

/** 既定の Transcription Router（実 Transcription_Service 依存）。 */
export const transcriptionRouter = createTranscriptionRouter();

export default recordingRouter;
