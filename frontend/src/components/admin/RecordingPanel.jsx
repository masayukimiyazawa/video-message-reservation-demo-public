import { useCallback, useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client.js';
import useAutoRefresh from '../../hooks/useAutoRefresh.js';
import { isRecordingPending } from './mediaPending.js';

/**
 * 録画操作パネル（タスク 17.2 / 要件 7.1・7.3・7.5）。
 * 録画開始/停止操作を提供し、Socket.IO `recording:status` に基づく録画状態を表示する。
 * 実際の API 呼び出し（api.startRecording/stopRecording）とステータス保持は
 * AdminPage が行い、ここは操作ハンドラと表示に専念する。
 *
 * @param {object} props
 * @param {{ status?: string, archiveId?: string, sessionId?: string, error?: string }|null} props.recordingStatus
 * @param {boolean} props.busy 進行中（開始/停止 API 呼び出し中）
 * @param {(opts: { sessionId: string, withTranscription: boolean }) => void} props.onStart
 * @param {(archiveId: string) => void} props.onStop
 * @param {string} [props.defaultSessionId] 選択中予約から引き継いだセッション ID
 * @param {(archiveId: string) => void} [props.onViewTranscription] 文字起こし表示への遷移ハンドラ
 * @param {object} props.socketClient Socket.IO クライアント（リアルタイムステータス受信用）
 */
function RecordingPanel({
  recordingStatus,
  busy = false,
  onStart,
  onStop,
  defaultSessionId = '',
  onViewTranscription,
  socketClient = null,
}) {
  const { t } = useTranslation();
  const [sessionId, setSessionId] = useState(defaultSessionId);
  const [withTranscription, setWithTranscription] = useState(true);
  const [archives, setArchives] = useState([]);
  const [archivesLoading, setArchivesLoading] = useState(false);
  const [archivesError, setArchivesError] = useState('');

  const status = recordingStatus?.status || 'idle';
  // 停止対象の archiveId は最新の recording:status から取得する。
  const activeArchiveId = recordingStatus?.archiveId || '';
  const isRecording = status === 'started' || status === 'starting';
  const isFailed = status === 'start_failed' || status === 'stop_failed';

  const handleStart = () => {
    const sid = (sessionId || defaultSessionId || '').trim();
    if (!sid) return;
    onStart({ sessionId: sid, withTranscription });
  };

  const loadArchives = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setArchivesLoading(true);
    if (!silent) setArchivesError('');
    try {
      const result = await api.getArchives();
      setArchives(result.archives || []);
    } catch (err) {
      // バックグラウンド更新の一時的な失敗は表示中の一覧を壊さないよう無視する。
      if (!silent) {
        setArchivesError(err instanceof ApiError ? t('admin.record.loadFailed') : t('login.networkError'));
      }
    } finally {
      if (!silent) setArchivesLoading(false);
    }
  }, [t]);

  // 録画削除ハンドラ
  const handleDeleteArchive = useCallback(async (archiveId) => {
    if (!window.confirm(t('admin.record.confirmDelete'))) return;
    try {
      const result = await api.deleteArchive(archiveId);
      if (result.ok) {
        // ローカル状態からも削除
        setArchives((prev) => prev.filter((a) => a.id !== archiveId));
      } else {
        throw new Error(result.message || '削除に失敗しました');
      }
    } catch (err) {
      setArchivesError(err instanceof ApiError ? err.message : t('admin.record.deleteFailed'));
    }
  }, [t]);

  useEffect(() => {
    loadArchives();
  }, [loadArchives]);

  // まだ available でない録画が残る間だけ裏で再取得する（Refresh 不要化 / GAP 1）。
  const hasPendingArchives = useMemo(
    () => archives.some(isRecordingPending),
    [archives],
  );
  useAutoRefresh({
    enabled: hasPendingArchives,
    onRefresh: () => loadArchives({ silent: true }),
  });

  const statusLabelKey = `admin.record.status.${status}`;

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, { timeZone: 'Asia/Tokyo' });
  };

  const formatDuration = (ms) => {
    if (!ms) return '';
    const sec = Math.floor(ms / 1000);
    const mm = Math.floor(sec / 60).toString().padStart(2, '0');
    const ss = (sec % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  };

  return (
    <section className="admin-panel admin-panel--recording">
      <div className="admin-panel__header">
        <h2>{t('admin.recording')}</h2>
        <span
          className={`recording-badge recording-badge--${status}`}
          role="status"
          aria-live="polite"
        >
          <span className="recording-badge__dot" aria-hidden="true" />
          {t(statusLabelKey, { defaultValue: t('admin.record.status.idle') })}
        </span>
      </div>

      {isFailed && recordingStatus?.error ? (
        <p className="form-error" role="alert">
          {recordingStatus.error}
        </p>
      ) : null}

      <div className="recording-controls">
        <label className="field">
          {t('admin.record.sessionId')}
          <input
            type="text"
            value={sessionId}
            placeholder={defaultSessionId || t('admin.record.sessionPlaceholder')}
            onChange={(e) => setSessionId(e.target.value)}
            disabled={busy || isRecording}
          />
        </label>

        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={withTranscription}
            onChange={(e) => setWithTranscription(e.target.checked)}
            disabled={busy || isRecording}
          />
          {t('admin.record.withTranscription')}
        </label>

        <div className="recording-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleStart}
            disabled={busy || isRecording || !(sessionId || defaultSessionId).trim()}
          >
            {t('admin.record.start')}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => onStop(activeArchiveId)}
            disabled={busy || !isRecording || !activeArchiveId}
          >
            {t('admin.record.stop')}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => loadArchives()}
            disabled={archivesLoading}
          >
            {archivesLoading ? t('common.loading') : t('admin.record.refresh')}
          </button>
        </div>
      </div>

      {activeArchiveId ? (
        <p className="admin-hint">
          {t('admin.record.archiveId')}: <code>{activeArchiveId}</code>
        </p>
      ) : null}

      {/* 録画一覧 */}
      <div className="archives-section">
        <h3>{t('admin.record.archives')}</h3>
        {archivesError && <p className="form-error">{archivesError}</p>}
        {archivesLoading ? (
          <p className="admin-empty">{t('common.loading')}</p>
        ) : archives.length === 0 ? (
          <p className="admin-empty">{t('admin.record.noArchives')}</p>
        ) : (
          <div className="archives-list">
            {archives.map((archive) => (
              <div key={archive.id} className="archive-item">
                <div className="archive-info">
                  <span className="archive-id"><code>{archive.id}</code></span>
                  <span className="archive-date">{formatDate(archive.createdAt)}</span>
                  <span className="archive-duration">{formatDuration(archive.duration)}</span>
                  <span className="archive-status archive-status--{archive.status}">{archive.status}</span>
                </div>
                <div className="archive-actions">
                  <div className="archive-download-group">
                    {archive.url && (
                      <a
                        href={archive.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn--secondary btn--small"
                      >
                        {t('admin.record.downloadRecording')}
                      </a>
                    )}
                    {archive.transcription?.url && (
                      <a
                        href={archive.transcription.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn--secondary btn--small"
                      >
                        {t('admin.record.downloadTranscription')}
                      </a>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn--danger btn--small"
                    onClick={() => handleDeleteArchive(archive.id)}
                    disabled={archive.status !== 'available'}
                    title={archive.status !== 'available' ? t('admin.record.deleteOnlyAvailable') : ''}
                  >
                    {t('admin.record.delete')}
                  </button>
                  {archive.status === 'available' && (
                    <button
                      type="button"
                      className="btn btn--primary btn--small"
                      onClick={() => onViewTranscription?.(archive.id)}
                    >
                      {t('admin.record.viewTranscription')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default RecordingPanel;