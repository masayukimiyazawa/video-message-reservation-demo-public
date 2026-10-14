import { useCallback, useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client.js';
import useAutoRefresh from '../../hooks/useAutoRefresh.js';
import { isTranscriptionPending } from './mediaPending.js';

/**
 * 話者分離文字起こし表示パネル（タスク 17.2 / 要件 8.4）。
 * api.getTranscription(archiveId) の結果（SpeakerTranscript[]）を
 * 話者（channel / streamId）単位に区別して表示する。
 * 文字起こし一覧も表示する。
 *
 * SpeakerTranscript の形状（design.md）:
 *   { channel, streamId, speakerLabel, segments: [{ start, end, text }] }
 *
 * 表示は左右分割:
 *   - 左: ゲスト（携帯ユーザー / Guest）
 *   - 右: 管理者
 *
 * @param {object} props
 * @param {string} [props.defaultArchiveId] 直近の録画から引き継いだアーカイブ ID
 */
function TranscriptionPanel({ defaultArchiveId = '' }) {
  const { t } = useTranslation();
  const [archiveId, setArchiveId] = useState(defaultArchiveId);
  const [transcript, setTranscript] = useState(null);
  const [transcriptions, setTranscriptions] = useState([]);
  const [transcriptionsLoading, setTranscriptionsLoading] = useState(false);
  const [transcriptionsError, setTranscriptionsError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const formatSec = (value) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return '';
    const mm = Math.floor(value / 60);
    const ss = Math.floor(value % 60);
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, { timeZone: 'Asia/Tokyo' });
  };

  const loadTranscriptions = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setTranscriptionsLoading(true);
    if (!silent) setTranscriptionsError('');
    try {
      const result = await api.getTranscriptions();
      setTranscriptions(result.transcriptions || []);
    } catch (err) {
      // バックグラウンド更新の一時的な失敗は表示中の一覧を壊さないよう無視する。
      if (!silent) {
        setTranscriptionsError(err instanceof ApiError ? t('admin.transcript.failed') : t('login.networkError'));
      }
    } finally {
      if (!silent) setTranscriptionsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadTranscriptions();
  }, [loadTranscriptions]);

  // まだ文字起こしが用意できていない録画の一覧が残る間だけ裏で再取得する（GAP 1）。
  const hasPendingTranscriptions = transcriptions.some(isTranscriptionPending);
  useAutoRefresh({
    enabled: hasPendingTranscriptions,
    onRefresh: () => loadTranscriptions({ silent: true }),
  });

  async function handleFetch(explicitId) {
    const id = String(explicitId ?? archiveId ?? defaultArchiveId ?? '').trim();
    if (!id) return;
    setLoading(true);
    setError('');
    setTranscript(null);
    try {
      const result = await api.getTranscription(id);
      // レスポンスは { transcript: SpeakerTranscript[] }。
      setTranscript(Array.isArray(result?.transcript) ? result.transcript : []);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(t('admin.transcript.failed'));
      } else {
        setError(t('login.networkError'));
      }
    } finally {
      setLoading(false);
    }
  }

  // 文字起こし削除ハンドラ
  const handleDeleteTranscription = useCallback(async (archiveId) => {
    if (!window.confirm(t('admin.transcript.confirmDelete'))) return;
    try {
      const result = await api.deleteTranscription(archiveId);
      if (result.ok) {
        // ローカル状態からも削除
        setTranscriptions((prev) => prev.filter((a) => a.id !== archiveId));
      } else {
        throw new Error(result.message || '削除に失敗しました');
      }
    } catch (err) {
      setTranscriptionsError(err instanceof ApiError ? err.message : t('admin.transcript.deleteFailed'));
    }
  }, [t]);

  // 話者をゲスト（左）と管理者（右）に分離
  const { guestSpeakers, adminSpeakers } = useMemo(() => {
    if (!transcript || !Array.isArray(transcript)) {
      return { guestSpeakers: [], adminSpeakers: [] };
    }
    const guest = [];
    const admin = [];
    for (const speaker of transcript) {
      const label = speaker.speakerLabel || '';
      // ゲスト判定: speakerLabel に "Guest" または "ゲスト" が含まれる、または role が guest
      const isGuest = /Guest|ゲスト/i.test(label);
      if (isGuest) {
        guest.push(speaker);
      } else {
        admin.push(speaker);
      }
    }
    return { guestSpeakers: guest, adminSpeakers: admin };
  }, [transcript]);

  const renderSpeakerColumn = (speakers, title, side) => {
    if (!speakers || speakers.length === 0) {
      return (
        <div className={`transcript-column transcript-column--${side}`}>
          <div className="transcript-column__header">
            <h3>{title}</h3>
          </div>
          <div className="transcript-column__empty">
            {t('admin.transcript.noSpeaker')}
          </div>
        </div>
      );
    }
    return (
      <div className={`transcript-column transcript-column--${side}`}>
        <div className="transcript-column__header">
          <h3>{title}</h3>
        </div>
        <div className="transcript-speakers">
          {speakers.map((speaker) => (
            <article
              key={speaker.streamId || speaker.channel}
              className="transcript-speaker"
            >
              <header className="transcript-speaker__header">
                <span className="transcript-speaker__label">
                  {speaker.speakerLabel ||
                    t('admin.transcript.speaker', {
                      channel: speaker.channel,
                    })}
                </span>
                {speaker.streamId ? (
                  <span className="transcript-speaker__stream">
                    {t('admin.transcript.stream')}: <code>{speaker.streamId}</code>
                  </span>
                ) : null}
              </header>
              <ul className="transcript-segments">
                {(speaker.segments || []).map((seg, idx) => (
                  <li key={idx} className="transcript-segment">
                    <span className="transcript-segment__time">
                      {formatSec(seg.start)}
                    </span>
                    <span className="transcript-segment__text">{seg.text}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    );
  };

  return (
    <section className="admin-panel admin-panel--transcription">
      <div className="admin-panel__header">
        <h2>{t('admin.transcription')}</h2>
      </div>

      <div className="transcription-controls">
        <label className="field">
          {t('admin.transcript.archiveId')}
          <input
            type="text"
            value={archiveId}
            placeholder={defaultArchiveId || t('admin.transcript.archivePlaceholder')}
            onChange={(e) => setArchiveId(e.target.value)}
            disabled={loading}
          />
        </label>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => handleFetch()}
          disabled={loading || !(archiveId || defaultArchiveId).trim()}
        >
          {loading ? t('common.loading') : t('admin.transcript.fetch')}
        </button>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {transcript != null && !error ? (
        transcript.length === 0 ? (
          <p className="admin-empty">{t('admin.transcript.empty')}</p>
        ) : (
          <div className="transcript-split-view">
            {renderSpeakerColumn(guestSpeakers, t('admin.transcript.guest'), 'left')}
            {renderSpeakerColumn(adminSpeakers, t('admin.transcript.admin'), 'right')}
          </div>
        )
      ) : null}

      {/* 文字起こし一覧 */}
      <div className="transcriptions-section">
        <h3>{t('admin.transcript.transcriptions')}</h3>
        <div className="transcriptions-controls">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => loadTranscriptions()}
            disabled={transcriptionsLoading}
          >
            {transcriptionsLoading ? t('common.loading') : t('admin.transcript.refresh')}
          </button>
        </div>
        {transcriptionsError && <p className="form-error">{transcriptionsError}</p>}
        {transcriptionsLoading ? (
          <p className="admin-empty">{t('common.loading')}</p>
        ) : transcriptions.length === 0 ? (
          <p className="admin-empty">{t('admin.transcript.noTranscriptions')}</p>
        ) : (
          <div className="transcriptions-list">
            {transcriptions.map((archive) => (
              <div key={archive.id} className="transcription-item">
                <div className="transcription-info">
                  <span className="transcription-id"><code>{archive.id}</code></span>
                  <span className="transcription-date">{new Date(archive.createdAt).toLocaleString(undefined, { timeZone: 'Asia/Tokyo' })}</span>
                  <span className="transcription-duration">{Math.floor((archive.duration || 0) / 60000)} min</span>
                  <span className="transcription-status">{archive.hasTranscription ? t('admin.transcript.ready') : t('admin.transcript.pending')}</span>
                </div>
                <div className="transcription-actions">
                  {archive.hasTranscription && (
                    <button
                      type="button"
                      className="btn btn--primary btn--small"
                      onClick={() => {
                        setArchiveId(archive.id);
                        handleFetch(archive.id);
                      }}
                    >
                      {t('admin.transcript.view')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--danger btn--small"
                    onClick={() => handleDeleteTranscription(archive.id)}
                    disabled={archive.status !== 'available'}
                    title={archive.status !== 'available' ? t('admin.transcript.deleteOnlyAvailable') : ''}
                  >
                    {t('admin.transcript.delete')}
                  </button>
                  {(archive.downloadUrl || archive.transcription?.url) && (
                    <a
                      href={archive.downloadUrl || archive.transcription?.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn--link btn--small"
                    >
                      {t('admin.transcript.downloadTranscription')}
                    </a>
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

export default TranscriptionPanel;