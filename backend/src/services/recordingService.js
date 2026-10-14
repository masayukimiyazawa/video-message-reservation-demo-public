/**
 * Recording_Service / Transcription_Service (要件 7・8)
 *
 * Vonage Video API のアーカイブ（録画）開始・停止と、Post-Call Transcription の
 * 取得・整形を担うアプリケーション層のサービス。設計書 Components の
 * Recording_Service / Transcription_Service に対応し、以下を配線する。
 *
 *  - ドメイン: buildArchiveOptions(req)  … 文字起こし要時に individual + hasTranscription を強制 (要件 7.2・8.1)
 *  - ドメイン: groupBySpeaker(rawJson)   … 文字起こしを話者（channel/stream）単位へ整形 (要件 8.3)
 *  - インフラ: Vonage Video クライアント  … startArchive/stopArchive/fetchTranscriptionJson (要件 7.1・7.3・8.2)
 *  - インフラ: Socket.IO ステータスエミッタ … recording:status を Admin_UI へ送出 (要件 7.4・7.5・8.5)
 *
 * 状態通知 (recording:status):
 *  録画・文字起こしの状態が変化するたびに Socket.IO で recording:status を送出する。
 *  ペイロードは判別しやすいよう { status, archiveId?, sessionId?, ... } 形式に統一する。
 *  代表的な status:
 *    'starting' / 'started' / 'start_failed'          … 録画開始 (要件 7.1・7.4・7.5)
 *    'stopping' / 'stopped'  / 'stop_failed'           … 録画停止 (要件 7.3・7.5)
 *    'transcription_ready' / 'transcription_failed'    … 文字起こし取得 (要件 8.5)
 *
 * 結果の表現:
 *  公開メソッドは例外を投げず、判別可能な結果オブジェクトを返す。
 *    録画開始成功: { ok: true, archive }
 *    録画停止成功: { ok: true, archive }
 *    文字起こし成功: { ok: true, transcript }   // transcript は SpeakerTranscript[]
 *    失敗:          { ok: false, code, message }
 *
 * エラー方針 (要件 7.4・8.5):
 *  Vonage API 呼び出しや文字起こし取得が失敗した場合、失敗内容を記録した上で
 *  recording:status に失敗状態を送出し、構造化された失敗応答へ変換する。
 *  呼び出し元へは例外を伝播しない。
 *
 * @typedef {import('../domain/types.js').ArchiveOptions} ArchiveOptions
 * @typedef {import('../domain/types.js').SpeakerTranscript} SpeakerTranscript
 */

import { buildArchiveOptions } from '../domain/buildArchiveOptions.js';
import { groupBySpeaker } from '../domain/groupBySpeaker.js';
import { videoClient as defaultVideoClient } from '../infra/videoClient.js';
import { statusEmitter as defaultStatusEmitter } from '../infra/statusEmitter.js';
import { activeArchiveStore as defaultActiveArchiveStore } from '../infra/activeArchiveStore.js';

/**
 * サービスが返す失敗コード。API 層はこれを HTTP ステータスへ対応付ける。
 * @readonly
 * @enum {string}
 */
export const RecordingErrorCode = Object.freeze({
  VALIDATION_ERROR: 'validation_error',
  START_FAILED: 'start_failed',
  STOP_FAILED: 'stop_failed',
  TRANSCRIPTION_FAILED: 'transcription_failed',
});

/**
 * recording:status ペイロードの status 値。
 * @readonly
 * @enum {string}
 */
export const RecordingStatus = Object.freeze({
  STARTING: 'starting',
  STARTED: 'started',
  START_FAILED: 'start_failed',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  STOP_FAILED: 'stop_failed',
  TRANSCRIPTION_READY: 'transcription_ready',
  TRANSCRIPTION_FAILED: 'transcription_failed',
});

/**
 * Recording_Service / Transcription_Service を生成する。
 *
 * 依存（Vonage Video クライアント・Socket.IO ステータスエミッタ・ロガー）を
 * 注入可能にし、テスト容易性を確保する。既定では実インフラと console を用いる。
 *
 * @param {object} [deps]
 * @param {typeof defaultVideoClient} [deps.videoClient] Vonage Video クライアントラッパー
 * @param {typeof defaultStatusEmitter} [deps.statusEmitter] Socket.IO ステータスエミッタ
 * @param {typeof defaultActiveArchiveStore} [deps.activeArchiveStore] 進行中アーカイブストア
 * @param {{ error: Function, info?: Function }} [deps.logger] ロガー
 * @returns {{
 *   startRecording: (req: object) => Promise<object>,
 *   stopRecording: (archiveId: string) => Promise<object>,
 *   fetchTranscription: (archiveId: string) => Promise<object>,
 * }}
 */
export function createRecordingService(deps = {}) {
  const videoClient = deps.videoClient ?? defaultVideoClient;
  const statusEmitter = deps.statusEmitter ?? defaultStatusEmitter;
  const activeArchiveStore = deps.activeArchiveStore ?? defaultActiveArchiveStore;
  const logger = deps.logger ?? console;

  /**
   * recording:status を Admin_UI へ送出する（要件 7.4・7.5・8.5）。
   * 送出失敗はステータスエミッタ側で握りつぶされるため、ここでは呼ぶだけでよい。
   * @param {string} status RecordingStatus のいずれか
   * @param {object} [detail] 付随情報（archiveId / sessionId / error など）
   */
  function emitStatus(status, detail = {}) {
    statusEmitter.emitRecordingStatus({ status, ...detail });
  }

  /**
   * 録画開始 (要件 7.1・7.2・7.4・7.5)。
   *
   * 手順:
   *  1. buildArchiveOptions で ArchiveOptions を構築（withTranscription 時は必ず
   *     individual + hasTranscription + hasAudio が設定される / 要件 7.2・8.1）。
   *  2. recording:status に 'starting' を送出。
   *  3. Vonage Video クライアントで startArchive を実行。
   *  4. 成功時は 'started' を送出し { ok:true, archive } を返す。
   *  5. 失敗時は失敗を記録し 'start_failed' を送出、{ ok:false } を返す（要件 7.4）。
   *
   * @param {object} req 録画開始要求
   * @param {string} req.sessionId 対象 Vonage セッション ID
   * @param {boolean} [req.withTranscription] 文字起こしを伴うか
   * @param {('en'|'ja')} [req.language] 対応言語（primaryLanguageCode 写像に使用）
   * @param {string} [req.primaryLanguageCode] 明示指定の Vonage 言語コード
   * @param {string} [req.name] アーカイブ名
   * @returns {Promise<object>} 結果オブジェクト
   */
  async function startRecording(req) {
    /** @type {ArchiveOptions} */
    let options;
    try {
      // sessionId 欠落・不正 req はここで Error を投げる（ドメイン検証）。
      options = buildArchiveOptions(req);
    } catch (err) {
      logger.error('[Recording_Service] 録画開始要求の検証に失敗しました:', err);
      const detail = { sessionId: req?.sessionId, error: errorMessage(err) };
      emitStatus(RecordingStatus.START_FAILED, detail);
      return {
        ok: false,
        code: RecordingErrorCode.VALIDATION_ERROR,
        message: errorMessage(err),
      };
    }

    const { sessionId, ...archiveOptions } = options;

    emitStatus(RecordingStatus.STARTING, { sessionId });

    try {
      const archive = await videoClient.startArchive(sessionId, archiveOptions);
      // 進行中アーカイブとして登録する（要件 10: 全員退室時の確実な停止のため）。
      // 手動開始（POST /recordings/start）・自動開始（ゲスト入室）の両経路が
      // このサービスを通るため、ここで登録すれば経路に依らず停止できる。
      activeArchiveStore.set(sessionId, archive?.id);
      emitStatus(RecordingStatus.STARTED, {
        sessionId,
        archiveId: archive?.id,
        hasTranscription: options.hasTranscription === true,
      });
      return { ok: true, archive };
    } catch (err) {
      // 録画開始失敗を記録し、Admin_UI に失敗を通知する（要件 7.4）。
      logger.error('[Recording_Service] アーカイブ録画の開始に失敗しました:', err);
      emitStatus(RecordingStatus.START_FAILED, {
        sessionId,
        error: errorMessage(err),
      });
      return {
        ok: false,
        code: RecordingErrorCode.START_FAILED,
        message: errorMessage(err),
      };
    }
  }

  /**
   * 録画停止 (要件 7.3・7.5)。
   *
   * @param {string} archiveId 停止対象のアーカイブ ID
   * @returns {Promise<object>} 結果オブジェクト
   */
  async function stopRecording(archiveId) {
    if (!isNonEmptyString(archiveId)) {
      const message = 'stopRecording: archiveId が欠落しています';
      logger.error(`[Recording_Service] ${message}`);
      emitStatus(RecordingStatus.STOP_FAILED, { archiveId, error: message });
      return {
        ok: false,
        code: RecordingErrorCode.VALIDATION_ERROR,
        message,
      };
    }

    emitStatus(RecordingStatus.STOPPING, { archiveId });

    try {
      const result = await videoClient.stopArchive(archiveId);
      if (!result.ok) {
        // バリデーションエラーなど
        emitStatus(RecordingStatus.STOP_FAILED, {
          archiveId,
          error: result.message,
        });
        return {
          ok: false,
          code: result.code || RecordingErrorCode.STOP_FAILED,
          message: result.message,
        };
      }
      // 既に停止済み（409 対応）も含めて成功扱い
      if (result.alreadyStopped) {
        logger.info('[Recording_Service] アーカイブは既に停止済み（冪等）', { archiveId });
      }
      // 停止済みの進行中アーカイブ登録を削除する（要件 10）。
      activeArchiveStore.deleteByArchiveId(archiveId);
      emitStatus(RecordingStatus.STOPPED, { archiveId });
      return { ok: true, archive: result.archive };
    } catch (err) {
      logger.error('[Recording_Service] アーカイブ録画の停止に失敗しました:', err);
      emitStatus(RecordingStatus.STOP_FAILED, {
        archiveId,
        error: errorMessage(err),
      });
      return {
        ok: false,
        code: RecordingErrorCode.STOP_FAILED,
        message: errorMessage(err),
      };
    }
  }

  /**
   * アーカイブ（録画）を削除する。
   *
   * Vonage Video API のアーカイブ削除エンドポイントを呼び出す。
   * 既に削除済み（404）の場合はエラーとせず成功として扱う（冪等性確保）。
   * activeArchiveStore からも削除する。
   *
   * @param {string} archiveId
   * @returns {Promise<{ok: boolean, message?: string}>}
   */
  async function deleteRecording(archiveId) {
    if (!isNonEmptyString(archiveId)) {
      const message = 'deleteRecording: archiveId が欠落しています';
      logger.error('[Recording_Service] ' + message);
      emitStatus(RecordingStatus.STOP_FAILED, { archiveId, error: message });
      return {
        ok: false,
        code: RecordingErrorCode.VALIDATION_ERROR,
        message,
      };
    }

    try {
      const result = await videoClient.deleteArchive(archiveId);
      if (result.ok) {
        // activeArchiveStore からも削除
        activeArchiveStore.deleteByArchiveId(archiveId);
        logger.info('[Recording_Service] アーカイブ削除成功', { archiveId });
        emitStatus(RecordingStatus.STOPPED, { archiveId });
        return { ok: true };
      }
      return result;
    } catch (err) {
      // 404 (Not Found) は既に削除済みとみなし、成功として扱う（冪等性）
      if (err?.status === 404 || err?.statusCode === 404 || err?.message?.includes('404')) {
        logger.info('[Recording_Service] アーカイブは既に削除済み', { archiveId });
        return { ok: true };
      }
      logger.error('[Recording_Service] アーカイブ削除に失敗しました:', err);
      emitStatus(RecordingStatus.STOP_FAILED, { archiveId, error: errorMessage(err) });
      return {
        ok: false,
        code: RecordingErrorCode.STOP_FAILED,
        message: errorMessage(err),
      };
    }
  }

  return {
    startRecording,
    stopRecording,
    fetchTranscription,
    deleteRecording,
  };
  /**
   * Post-Call Transcription の取得と整形 (要件 8.1・8.2・8.3・8.5)。
   *
   * 手順:
   *  1. Vonage Video クライアントで文字起こし生 JSON を取得（要件 8.2）。
   *  2. groupBySpeaker で話者（channel/stream）単位に整形する（要件 8.3）。
   *  3. 成功時は 'transcription_ready' を送出し { ok:true, transcript } を返す。
   *  4. 取得/生成失敗時は失敗を記録し 'transcription_failed' を送出、
   *     { ok:false } を返す（要件 8.5）。
   *
   * @param {string} archiveId 対象アーカイブ ID
   * @returns {Promise<object>} 結果オブジェクト（transcript は SpeakerTranscript[]）
   */
  async function fetchTranscription(archiveId) {
    if (!isNonEmptyString(archiveId)) {
      const message = 'fetchTranscription: archiveId が欠落しています';
      logger.error(`[Transcription_Service] ${message}`);
      emitStatus(RecordingStatus.TRANSCRIPTION_FAILED, { archiveId, error: message });
      return {
        ok: false,
        code: RecordingErrorCode.VALIDATION_ERROR,
        message,
      };
    }

    try {
      const rawJson = await videoClient.fetchTranscriptionJson(archiveId);
      const transcript = groupBySpeaker(rawJson);
      emitStatus(RecordingStatus.TRANSCRIPTION_READY, {
        archiveId,
        speakerCount: transcript.length,
      });
      return { ok: true, transcript };
    } catch (err) {
      // 取得/生成失敗を記録し、Admin_UI に失敗状態を通知する（要件 8.5）。
      logger.error('[Transcription_Service] 文字起こしの取得/整形に失敗しました:', err);
      emitStatus(RecordingStatus.TRANSCRIPTION_FAILED, {
        archiveId,
        error: errorMessage(err),
      });
      return {
        ok: false,
        code: RecordingErrorCode.TRANSCRIPTION_FAILED,
        message: errorMessage(err),
      };
    }
  }

  return {
    startRecording,
    stopRecording,
    fetchTranscription,
  };
}

/**
 * 空でない文字列かどうかを判定する。
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 捕捉した例外から記録・通知用のメッセージ文字列を抽出する。
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * 既定の依存（実 Vonage Video クライアント・Socket.IO ステータスエミッタ・console）で
 * 構成した Recording_Service / Transcription_Service。API 層はこれをそのまま利用できる。
 */
export const recordingService = createRecordingService();

export default recordingService;
