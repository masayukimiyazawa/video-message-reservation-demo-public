import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import { markGuestJoin } from '../api/guestJoin.js';
import '../styles/join.css';

/**
 * 入室ページ / JoinPage（新機能：WhatsApp 入室リンクの初回消費）。
 *
 * 流れ:
 *  1. URL パラメータ tokenId を取得する。
 *  2. `POST /sessions/join/:tokenId` を呼び出してトークンを消費し、
 *     ゲスト publisher トークン（token, sessionId, applicationId 等）を得る。
 *  3. 成功時: 取得した token/sessionId/applicationId を sessionStorage に保存し、
 *     `/call/:sessionId` へ遷移する。
 *  4. 失敗時: エラーコードに応じたメッセージを表示する（再クリック不可の説明も含む）。
 *
 * 同じタブでの刷新に対応するため、CallPage 側で sessionStorage から
 * 保存済みトークンを読み出し、再取得しないようにする（requirement: 同タブ刷新可）。
 */
export default function JoinPage() {
  const { t } = useTranslation();
  const { tokenId } = useParams();
  const navigate = useNavigate();

  const [status, setStatus] = useState('loading'); // loading | success | error
  const [errorCode, setErrorCode] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (!tokenId) {
      setStatus('error');
      setErrorCode('invalid');
      setErrorMessage(t('join.error.invalid'));
      return;
    }

    let cancelled = false;

    async function redeem() {
      try {
        const result = await api.redeemJoinToken(tokenId);
        if (cancelled) return;

        // 取得したトークン情報を sessionStorage に保存（同タブ刷新時はこれを使う）。
        // CallPage が読み出し、保存済みなら再取得せずに接続する。
        sessionStorage.setItem('vvr.joinToken', JSON.stringify({
          token: result.token,
          sessionId: result.sessionId,
          applicationId: result.applicationId,
          reservationId: result.reservationId,
        }));

        // WhatsApp リンク経由の参加であることを記録する。
        // Layout がこのフラグを見て管理/ログインの導線を隠す。
        markGuestJoin({ reservationId: result.reservationId, sessionId: result.sessionId });

        if (cancelled) return;
        navigate(`/call/${result.sessionId}`, { replace: true });
        setStatus('success');
      } catch (err) {
        if (cancelled) return;
        const apiError = err?.body || {};
        const code = apiError?.error || 'unknown';

        // バックエンドから返される拒否コードに応じてユーザー向けメッセージを出す。
        const messages = {
          join_token_not_found: t('join.error.notFound'),
          join_token_already_used: t('join.error.alreadyUsed'),
          join_token_expired: t('join.error.expired'),
          join_token_room_closed: t('join.error.roomClosed'),
          room_closed: t('join.error.roomClosed'),
          invalid_join_token: t('join.error.invalid'),
        };

        setStatus('error');
        setErrorCode(code);
        setErrorMessage(messages[code] || t('join.error.unknown'));
      }
    }

    redeem();

    return () => {
      cancelled = true;
    };
  }, [tokenId, navigate, t]);

  // 成功時は遷移するため、この JSX は loading/error 時にのみ見える。
  // ただし redirect が完了するまでの間も表示される。
  return (
    <section className="page page--join">
      <div className="join-container" role="status" aria-live="polite">
        {status === 'loading' && (
          <>
            <div className="join-spinner" aria-label={t('join.loading')} />
            <p className="join-message">{t('join.loading')}</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="join-success-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 12l2 2 4-4" />
              </svg>
            </div>
            <p className="join-message">{t('join.success')}</p>
          </>
        )}

        {status === 'error' && (
          <div className="join-error">
            <div className="join-error-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <p className="join-message">{errorMessage}</p>
            <details className="join-error-detail">
              <summary>{t('join.error.detailSummary')}</summary>
              <p>{t('join.error.detail', { code: errorCode })}</p>
            </details>
          </div>
        )}

        <p className="join-footer">
          {t('join.footer')}
        </p>
      </div>
    </section>
  );
}