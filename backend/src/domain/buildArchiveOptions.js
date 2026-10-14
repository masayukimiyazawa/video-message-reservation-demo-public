/**
 * アーカイブオプション構築 (要件 7.2 / 8.1 / Property 9)
 *
 * Recording_Service / Transcription_Service のドメインロジック。
 * 録画開始要求から Vonage Video API へ渡す ArchiveOptions を構築する純粋関数。
 * 副作用を持たず、入力を変更しない。
 *
 * 設計上の不変条件 (design: ArchiveOptions / Property 9):
 *   文字起こしを伴う場合 (`withTranscription === true`) は必ず
 *   - outputMode: 'individual'
 *   - hasAudio: true
 *   - hasTranscription: true
 *   - transcriptionProperties.primaryLanguageCode
 *   を設定する。Post-Call Transcription は individual stream archive でのみ
 *   利用可能であり、composed archive では利用できないため。
 */

import {
  SupportedLanguage,
  TRANSCRIPTION_LANGUAGE_CODE,
} from './constants.js';

/** 文字起こしを伴わない通常録画の既定出力モード。 */
const DEFAULT_OUTPUT_MODE = 'composed';

/** 文字起こし要時に強制される出力モード。 */
const TRANSCRIPTION_OUTPUT_MODE = 'individual';

/** primaryLanguageCode の既定値（言語未指定時のフォールバック）。 */
const DEFAULT_LANGUAGE_CODE = TRANSCRIPTION_LANGUAGE_CODE[SupportedLanguage.JA];

/**
 * 録画開始要求から primaryLanguageCode を解決する。
 *
 * 明示的な `primaryLanguageCode` が指定されていればそれを優先し、
 * なければ `language` (en/ja) を Vonage 用コード (en-US/ja-JP) に写像する。
 * いずれも解決できない場合は既定値 (ja-JP) を用いる。
 *
 * @param {Object} req
 * @returns {string}
 */
function resolvePrimaryLanguageCode(req) {
  if (isNonEmptyString(req.primaryLanguageCode)) {
    return req.primaryLanguageCode;
  }

  const mapped = TRANSCRIPTION_LANGUAGE_CODE[req.language];
  if (isNonEmptyString(mapped)) {
    return mapped;
  }

  return DEFAULT_LANGUAGE_CODE;
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
 * 録画開始要求から Vonage Video API 用の ArchiveOptions を構築する。
 *
 * @param {Object} req - 録画開始要求
 * @param {string} req.sessionId - 対象 Vonage セッション ID
 * @param {boolean} [req.withTranscription] - 文字起こしを伴うか
 * @param {('en'|'ja')} [req.language] - 対応言語 (primaryLanguageCode 写像に使用)
 * @param {string} [req.primaryLanguageCode] - 明示指定の Vonage 言語コード (language より優先)
 * @param {boolean} [req.hasVideo] - 映像を含めるか (既定 true)
 * @param {string} [req.name] - アーカイブ名
 * @param {string} [req.reservationId] - 予約 ID (アーカイブの metadata に含める)
 * @returns {import('./types.js').ArchiveOptions}
 *   Vonage Video API へ渡すアーカイブオプション。
 * @throws {Error} req が不正、または sessionId が欠落している場合。
 */
export function buildArchiveOptions(req) {
  if (req == null || typeof req !== 'object') {
    throw new Error('buildArchiveOptions: req は録画開始要求オブジェクトである必要があります');
  }

  if (!isNonEmptyString(req.sessionId)) {
    throw new Error('buildArchiveOptions: sessionId が欠落しています (要件 7.1)');
  }

  const withTranscription = req.withTranscription === true;
  // hasVideo は明示指定を尊重しつつ既定は true。
  const hasVideo = req.hasVideo === undefined ? true : req.hasVideo === true;

  /** @type {import('./types.js').ArchiveOptions} */
  const options = {
    sessionId: req.sessionId,
    // 文字起こし要時は音声必須。それ以外は要求を尊重しつつ既定 true。
    hasAudio: withTranscription ? true : (req.hasAudio === undefined ? true : req.hasAudio === true),
    hasVideo,
    // 文字起こし要時は必ず individual。それ以外は既定 composed。
    outputMode: withTranscription ? TRANSCRIPTION_OUTPUT_MODE : DEFAULT_OUTPUT_MODE,
  };

  if (isNonEmptyString(req.name)) {
    options.name = req.name;
  }

  // 予約 ID があれば metadata に含める（後から予約単位でアーカイブを検索可能にする）
  if (isNonEmptyString(req.reservationId)) {
    options.metadata = { reservationId: req.reservationId };
  }

  // 文字起こし要時のみ Post-Call Transcription を有効化する (要件 7.2 / 8.1)。
  if (withTranscription) {
    options.hasTranscription = true;
    options.transcriptionProperties = {
      primaryLanguageCode: resolvePrimaryLanguageCode(req),
    };
  }

  return options;
}
