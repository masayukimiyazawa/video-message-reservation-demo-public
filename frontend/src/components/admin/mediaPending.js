/**
 * 録画・文字起こしの「まだダウンロードできない」判定（GAP 1）。
 *
 * Vonage 側でアーカイブが `available` になるまで download URL が発行されない。
 * 管理画面は未完了アイテムが残る間だけバックグラウンド再取得し、
 * 全件そろえば停止する（useAutoRefresh と組み合わせて使う）。
 *
 * @module components/admin/mediaPending
 */

/** これ以上待っても URL が発行されない終端ステータス（ポーリング対象外）。 */
const TERMINAL_STATUSES = new Set(['available', 'failed', 'expired']);

/** URL（録画本体 or 正規化済み downloadUrl）を持っているか。 */
function hasDownloadUrl(item) {
  return Boolean(item?.url || item?.downloadUrl);
}

/** 終端ステータスか（failed/expired は待っても URL が出ない）。 */
function hasTerminalStatus(item) {
  return TERMINAL_STATUSES.has(item?.status);
}

/**
 * 録画アーカイブがまだ DL 可能でない（バックグラウンド更新の対象）か。
 * @param {object} archive
 * @returns {boolean}
 */
export function isRecordingPending(archive) {
  if (!archive || hasDownloadUrl(archive)) return false;
  return !hasTerminalStatus(archive);
}

/**
 * 文字起こし一覧アイテムがまだ DL 可能でないか。
 * @param {object} item
 * @returns {boolean}
 */
export function isTranscriptionPending(item) {
  if (!item) return false;
  if (item.hasTranscription || item.downloadUrl || item.transcription?.url) return false;
  return !hasTerminalStatus(item);
}

/**
 * 録画/文字起こしの配列に未完了アイテムが含まれるか。
 * @param {object[]} [archives]
 * @param {object[]} [transcriptions]
 * @returns {boolean}
 */
export function hasPendingMedia(archives = [], transcriptions = []) {
  return archives.some(isRecordingPending) || transcriptions.some(isTranscriptionPending);
}
