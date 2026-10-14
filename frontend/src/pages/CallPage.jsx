import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client.js';
import {
  initSession,
  connectSession,
  initPublisher,
  initScreenPublisher,
} from '../api/video.js';
import { getCurrentUser, isAdministrator } from '../api/auth.js';
import { isGuestJoin, clearGuestJoin } from '../api/guestJoin.js';
import {
  BACKGROUND_SKINS,
  DEFAULT_SKIN_ID,
  applyBackgroundSkin,
} from '../video/backgroundSkins.js';
import '../styles/call.css';

/**
 * ビデオ通話画面 / Video_Call_UI（タスク 16.1・16.2 / 要件 4.1・4.2・4.3・4.4・6.2）。
 *
 * - 要件 4.1: マウント時に `/sessions/:id/token` からトークンを取得し、Vonage Video
 *   Client SDK でセッションへ接続、ローカル音声・映像を publish、リモートストリームを
 *   subscribe する。
 * - 要件 4.2: CSS（フレックス/グリッド + メディアクエリ）でスマホ・PC 対応の
 *   レスポンシブ表示（styles/call.css）。
 * - 要件 4.3: 病院遠隔診療（telemedicine）テーマを含む背景スキンをセレクタから選択し
 *   `applyBackgroundSkin` で通話画面へ適用する。
 * - 要件 4.4: 接続失敗時に失敗メッセージと再接続ボタンを提示する。
 * - 要件 6.2: 表示テキストは i18n（選択言語）。
 */

/** JoinPage から保存されたトークンを sessionStorage から取得する。 */
function getStoredJoinToken(sessionId) {
  try {
    const raw = sessionStorage.getItem('vvr.joinToken');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.sessionId === sessionId) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** JoinPage のトークンを消費する（同タブ刷新時に二重消費を避ける）。 */
function consumeStoredJoinToken(sessionId) {
  try {
    const raw = sessionStorage.getItem('vvr.joinToken');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.sessionId === sessionId) {
      sessionStorage.removeItem('vvr.joinToken');
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// 接続ライフサイクルの状態。
const Status = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
  ENDED: 'ended',
  // モバイル/エンドユーザーが「トップへ戻る」で会議室から完全に退出した状態。
  LEFT: 'left',
});

export default function CallPage() {
  const { t } = useTranslation();
  const { sessionId } = useParams();
  const navigate = useNavigate();

  // 現在ユーザーが管理者かどうかを一度だけ判定する。
  // 画面/資料共有ボタンは管理者にのみ表示し、他の参加者（モバイル利用者など）は
  // 共有映像を閲覧するだけとする。
  const currentUser = getCurrentUser();
  const isAdmin = isAdministrator(currentUser);

  // WhatsApp 入室リンク経由のゲスト参加かどうかを判定する。
  // Layout がヘッダーを隠すために使う同一のフラグを使用する。
  const isGuest = isGuestJoin();

  // 入室経路をマウント時に一度だけ確定する。
  // handleHangUp で clearGuestJoin() されても退出先の判定がぶれないよう、
  // 「リンク経由で入室したか」を初期値として保持する。
  const [enteredAsGuest] = useState(() => isGuestJoin());

  // 退出時に管理画面へ戻すかどうか。入室経路で判定する:
  // - WhatsApp 入室リンク経由（ゲスト）は常に挨拶ページ（LEFT）へ。
  // - リンク経由でなく、ログイン済み（管理者/スタッフ）なら管理画面へ。
  const exitToAdmin = !enteredAsGuest && currentUser != null;

  const [status, setStatus] = useState(Status.IDLE);
  const [errorMessage, setErrorMessage] = useState('');
  const [skinId, setSkinId] = useState(DEFAULT_SKIN_ID);
  // カメラ ON/OFF 状態。publisher 生成時の publishVideo:true と一致させ既定は ON。
  const [cameraOn, setCameraOn] = useState(true);
  // マイク ON/OFF 状態。publisher 生成時の publishAudio:true と一致させ既定は ON。
  const [microphoneOn, setMicrophoneOn] = useState(true);
  // 画面/資料共有中かどうか（管理者のみ true になり得る）。
  // 管理画面の表示レイアウトの切り替え判定に使う。
  //   false … 共有前。相手映像を全面に表示し、自分は PiP（小窓）に置く。
  //   true  … 共有中。共有資料を主役（メイン）に、相手映像と自分を小画面で並べる。
  const [sharing, setSharing] = useState(false);
  // 非管理者（モバイル/エンドユーザー）が共有資料（screen ストリーム）を受信中かどうか。
  // true のときは共有資料をメイン（大）に、リモートカメラを小さな PiP に配置する。
  const [sharedActive, setSharedActive] = useState(false);
  // 再接続トリガー。インクリメントすると接続 effect が再実行される。
  const [connectAttempt, setConnectAttempt] = useState(0);

  const stageRef = useRef(null);
  const publisherContainerRef = useRef(null);
  const subscribersContainerRef = useRef(null);
  // 接続中断フラグ。接続処理（トークン取得・SDK 接続）が進行中に利用者が
  // 退出した場合、遅れて完了した接続が CONNECTED に戻らないよう各 await 境界で検査する。
  // effect 自身の cleanup が立てる `cancelled` とは別物で、クリック操作から無効化できる。
  const connectAbortedRef = useRef(false);
  // 共有映像（screen ストリーム）の表示先。非管理者（モバイル利用者など）が閲覧する主要領域。
  const sharedContainerRef = useRef(null);
  // 管理者自身の画面共有プレビューの表示先（管理者レイアウトのメイン領域）。
  // 管理者は自分の screen ストリームを streamCreated で受信しないため、
  // 共有資料はこの publisher プレビューから直接表示する。
  const sharedSelfRef = useRef(null);
  // 非管理者の共有者（想定外）向けのオフスクリーンなインジケータ。
  const screenIndicatorRef = useRef(null);

  // クリーンアップ対象の SDK オブジェクトを保持する。
  const sessionRef = useRef(null);
  const publisherRef = useRef(null);
  // 画面共有用の publisher（管理者のみ）。
  const screenPublisherRef = useRef(null);

  /**
   * 現在の SDK 接続・publisher を破棄する。effect の再実行/アンマウント時に呼ぶ。
   */
  const teardown = useCallback(() => {
    const publisher = publisherRef.current;
    if (publisher) {
      try {
        publisher.destroy();
      } catch {
        /* 破棄失敗は無視（既に破棄済みなど） */
      }
      publisherRef.current = null;
    }
    // 画面共有 publisher も破棄する。
    const screenPublisher = screenPublisherRef.current;
    if (screenPublisher) {
      try {
        screenPublisher.destroy();
      } catch {
        /* 破棄失敗は無視 */
      }
      screenPublisherRef.current = null;
    }
    setSharing(false);
    setSharedActive(false);
    const session = sessionRef.current;
    if (session) {
      try {
        session.disconnect();
      } catch {
        /* 破棄失敗は無視 */
      }
      sessionRef.current = null;
    }
    // リモート映像コンテナをクリア。
    if (subscribersContainerRef.current) {
      subscribersContainerRef.current.innerHTML = '';
    }
    // 共有映像コンテナもクリア。
    if (sharedContainerRef.current) {
      sharedContainerRef.current.innerHTML = '';
      delete sharedContainerRef.current.dataset.active;
    }
    // 管理者自身の共有プレビュー領域もクリア。
    if (sharedSelfRef.current) {
      sharedSelfRef.current.innerHTML = '';
    }
    // 管理者のオフスクリーンインジケータもクリア。
    if (screenIndicatorRef.current) {
      screenIndicatorRef.current.innerHTML = '';
    }
  }, []);

  // 接続ライフサイクル（要件 4.1・4.4）。
  useEffect(() => {
    if (!sessionId) {
      return undefined;
    }

    let cancelled = false;
    // 新規接続を開始するたびに中断フラグを解除する。
    connectAbortedRef.current = false;

    // effect の cleanup による中断と、利用者の操作による中断をまとめて判定する。
    function aborted() {
      return cancelled || connectAbortedRef.current;
    }

    async function connect() {
      setStatus(Status.CONNECTING);
      setErrorMessage('');
      try {
        // 1) sessionStorage から事前消費済みトークンを確認する（JoinPage 経由の遷移・同タブ刷新）。
        //    あれば再取得せずそのまま使う。なければ通常のトークン取得へフォールバック。
        const stored = getStoredJoinToken(sessionId);
        let token, applicationId;

        if (stored) {
          // JoinPage 経由（または同タブ刷新）で既にトークンを持っている。
          // sessionStorage からは「消費」せず、CallPage 終了時にのみ消費する。
          ({ token, applicationId } = stored);
        } else {
          // 通常フロー: ログイン済みは管理者用、未ログインはゲスト用エンドポイントを叩く。
          const currentUser = getCurrentUser();
          const result = currentUser
            ? await api.createSessionToken(sessionId)
            : await api.createGuestSessionToken(sessionId);
          ({ token, applicationId } = result);
        }
        if (aborted()) return;

        // 2) セッション初期化・接続。
        //    クライアント SDK の第 1 引数は partnerId として使われ、接続先 API ホストの
        //    解決に使われる。Vonage Video アプリケーションのセッションなので
        //    **アプリケーション ID（UUID）** を渡す。
        const session = await initSession(applicationId, sessionId);
        if (aborted()) {
          // 接続中に退出済みなら、生成済みのセッションを破棄してリークを防ぐ。
          try {
            session.disconnect();
          } catch {
            /* ignore */
          }
          return;
        }
        sessionRef.current = session;

        // リモートストリーム受信で subscribe（要件 4.1）。
        // 画面共有ストリーム（videoType === 'screen'）は全参加者（モバイル含む）が
        // 閲覧する専用の共有領域へ表示し、通常のカメラ映像はリモートグリッドへ表示する。
        session.on('streamCreated', (event) => {
          if (aborted()) return;
          const streamId = event.stream?.streamId || '';
          const isScreen = event.stream?.videoType === 'screen';

          const container = isScreen
            ? sharedContainerRef.current
            : subscribersContainerRef.current;
          if (!container) return;

          const tile = document.createElement('div');
          tile.dataset.streamId = streamId;
          if (isScreen) {
            // 共有資料（画面共有）を専用ビューへ表示する。
            tile.className = 'call-shared-view';
            tile.dataset.screen = 'true';
          } else {
            tile.className = 'call-tile call-tile--remote';
          }
          container.appendChild(tile);

          try {
            session.subscribe(event.stream, tile, {
              insertMode: 'append',
              width: '100%',
              height: '100%',
            });
          } catch {
            /* subscribe 失敗は個別タイルのみ影響 */
          }

          // 共有領域を表示状態にする。
          if (isScreen && sharedContainerRef.current) {
            sharedContainerRef.current.dataset.active = 'true';
            // 非管理者では共有資料を大きく、リモートカメラを小さな PiP に切り替える。
            if (!isAdmin) setSharedActive(true);
          }
        });

        // ストリーム終了でタイル/共有ビューを除去。
        session.on('streamDestroyed', (event) => {
          if (aborted()) return;
          const streamId = event.stream?.streamId || '';
          const isScreen = event.stream?.videoType === 'screen';
          const container = isScreen
            ? sharedContainerRef.current
            : subscribersContainerRef.current;
          if (!container) return;
          const tile = container.querySelector(
            `[data-stream-id="${streamId}"]`,
          );
          if (tile) tile.remove();
          // 共有領域に他の screen ストリームが残っていなければ非アクティブにする。
          if (isScreen && sharedContainerRef.current) {
            const remaining = sharedContainerRef.current.querySelector(
              '[data-screen="true"]',
            );
            if (!remaining) {
              delete sharedContainerRef.current.dataset.active;
              // 共有資料が終了したらリモートカメラを通常表示（領域いっぱい）に戻す。
              if (!isAdmin) setSharedActive(false);
            }
          }
        });

        // セッション切断は失敗として扱い再接続を促す（要件 4.4）。
        session.on('sessionDisconnected', (event) => {
          if (aborted()) return;
          if (event.reason && event.reason !== 'clientDisconnected') {
            setStatus(Status.FAILED);
            setErrorMessage(t('call.connectionFailed'));
          }
        });

        await connectSession(session, token);
        if (aborted()) return;

        // 3) ローカル映像・音声を publish（要件 4.1）。
        const publisher = await initPublisher(publisherContainerRef.current, {
          insertMode: 'append',
          width: '100%',
          height: '100%',
          publishAudio: true,
          publishVideo: true,
        });
        if (aborted()) {
          try {
            publisher.destroy();
          } catch {
            /* ignore */
          }
          return;
        }
        publisherRef.current = publisher;
        // 新しい publisher は publishVideo:true で生成されるため状態を ON に揃える。
        setCameraOn(true);

        await new Promise((resolve, reject) => {
          session.publish(publisher, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        if (aborted()) return;

        setStatus(Status.CONNECTED);
      } catch (err) {
        if (aborted()) return;
        // 接続失敗（トークン取得失敗含む）: 失敗メッセージと再接続 UI（要件 4.4）。
        setStatus(Status.FAILED);
        setErrorMessage(err?.message || t('call.connectionFailed'));
        teardown();
      }
    }

    connect();

    return () => {
      cancelled = true;
      connectAbortedRef.current = true;
      teardown();
      // ページ遷移時にもトークンを消費済みにする（同タブ刷新でない限り再使用は不可）。
      consumeStoredJoinToken(sessionId);
    };
  }, [sessionId, connectAttempt, teardown, t, isAdmin]);

  // 選択スキンを通話画面へ適用する（要件 4.3）。
  useEffect(() => {
    applyBackgroundSkin(skinId, stageRef.current);
  }, [skinId]);

  const handleReconnect = useCallback(() => {
    teardown();
    setConnectAttempt((n) => n + 1);
  }, [teardown]);

  // 通話を終了する（ハングアップ）。SDK 接続を破棄して ENDED 状態にする。
  // 接続が未完了（CONNECTING）のときも退出操作として再利用し、遅れて完了する接続が
  // CONNECTED に戻らないように中断フラグを立てる。
  // 自動再接続はしない（connectAttempt/sessionId を変更しないため接続 effect は再実行されない）。
  const handleHangUp = useCallback(() => {
    // 進行中の接続処理を無効化する（await 境界で aborted() が true になる）。
    connectAbortedRef.current = true;
    teardown();
    // JoinPage で保存したトークンは 1 回の通話で使い切る。通話終了時に消費する。
    consumeStoredJoinToken(sessionId);
    // ゲスト参加フラグをクリアして、ナビゲーションが復活するようにする。
    clearGuestJoin();
    setStatus(Status.ENDED);
  }, [teardown, sessionId]);

  // 通話画面から離脱する。
  // - 入室経路がリンク経由でなく、ログイン済み: 管理画面（/admin）へ戻る
  // - それ以外（ゲスト/未ログイン）: 「会議室から退出しました」専用画面（LEFT 状態）を表示
  const handleExitCall = useCallback(() => {
    if (exitToAdmin) {
      navigate('/admin', { replace: true });
    } else {
      // ゲスト/未ログインは専用の退出完了画面を表示する
      setStatus(Status.LEFT);
    }
  }, [navigate, exitToAdmin]);

  // 退出完了画面（LEFT）からトップページへ戻る。
  const handleGoHome = useCallback(() => {
    navigate('/', { replace: true });
  }, [navigate]);

  const handleSkinChange = useCallback((event) => {
    setSkinId(event.target.value);
  }, []);

  // カメラ ON/OFF を切り替え、Vonage publisher のローカル映像トラックを制御する。
  const handleToggleCamera = useCallback(() => {
    setCameraOn((prev) => {
      const next = !prev;
      publisherRef.current?.publishVideo(next);
      return next;
    });
  }, []);

  // マイク ON/OFF を切り替え、Vonage publisher のローカル音声トラックを制御する。
  const handleToggleMicrophone = useCallback(() => {
    setMicrophoneOn((prev) => {
      const next = !prev;
      publisherRef.current?.publishAudio(next);
      return next;
    });
  }, []);

  // 画面共有 publisher を破棄し、共有を停止する（内部ヘルパ）。
  const destroyScreenPublisher = useCallback(() => {
    const session = sessionRef.current;
    const screenPublisher = screenPublisherRef.current;
    if (screenPublisher) {
      try {
        session?.unpublish(screenPublisher);
      } catch {
        /* 既に unpublish 済みなどは無視 */
      }
      try {
        screenPublisher.destroy();
      } catch {
        /* 破棄失敗は無視 */
      }
      screenPublisherRef.current = null;
    }
    // プレビューの表示先（管理者はメイン領域 / それ以外はオフスクリーン）をクリアし、
    // 停止後に死んだ要素が残らないようにする。
    if (sharedSelfRef.current) {
      sharedSelfRef.current.innerHTML = '';
    }
    if (screenIndicatorRef.current) {
      screenIndicatorRef.current.innerHTML = '';
    }
  }, []);

  // 画面/資料共有を開始する（管理者のみ・接続中のみ）。
  const handleStartShare = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || screenPublisherRef.current) return;
    // 管理者は自分の screen ストリームを subscribe できないため、共有資料は自身の
    // publisher プレビューから直接メイン領域へ表示する。非管理者（想定外の共有者）は
    // オフスクリーンインジケータへ表示する。
    const previewTarget = isAdmin
      ? sharedSelfRef.current
      : screenIndicatorRef.current;
    try {
      // videoSource:'screen' によりブラウザの画面/ウィンドウ/タブ選択ダイアログが起動する。
      const screenPublisher = await initScreenPublisher(previewTarget, {
        insertMode: 'append',
        width: '100%',
        height: '100%',
        publishAudio: false,
      });
      screenPublisherRef.current = screenPublisher;

      // ブラウザ標準の「共有を停止」等で共有が終わったらクリーンアップする。
      screenPublisher.on?.('mediaStopped', () => {
        destroyScreenPublisher();
        setSharing(false);
      });
      screenPublisher.on?.('streamDestroyed', () => {
        destroyScreenPublisher();
        setSharing(false);
      });

      await new Promise((resolve, reject) => {
        session.publish(screenPublisher, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      setSharing(true);
    } catch {
      // 共有開始に失敗（ユーザーがダイアログをキャンセルした等）。状態を戻す。
      destroyScreenPublisher();
      setSharing(false);
    }
  }, [destroyScreenPublisher, isAdmin]);

  // 画面/資料共有を停止する。
  const handleStopShare = useCallback(() => {
    destroyScreenPublisher();
    setSharing(false);
  }, [destroyScreenPublisher]);

  const handleToggleShare = useCallback(() => {
    if (sharing) {
      handleStopShare();
    } else {
      handleStartShare();
    }
  }, [sharing, handleStartShare, handleStopShare]);

  return (
    <section className={`page page--call ${isGuest ? 'page--call--immersive' : ''}`}>
      {!isGuest && (
        <div className="call-header">
          <h1>{t('call.title')}</h1>
          <label className="call-skin-selector">
            <span>{t('call.background')}</span>
            <select
              value={skinId}
              onChange={handleSkinChange}
              aria-label={t('call.background')}
            >
              {BACKGROUND_SKINS.map((skin) => (
                <option key={skin.id} value={skin.id}>
                  {t(`call.skins.${skin.id}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className={`call-stage ${isGuest ? 'call-stage--immersive' : ''}`} ref={stageRef} data-status={status}>
        {status === Status.CONNECTING && (
          <div className="call-status call-status--connecting" role="status">
            <p className="call-status__message">{t('call.connecting')}</p>
            {/* 低速回線などで接続が長引く間に、利用者が取り消せるようにする。
                押下時は handleHangUp（接続中断フラグを立てる）で ENDED に遷移する。 */}
            <button
              type="button"
              className="call-reconnect-button call-reconnect-button--secondary"
              onClick={handleHangUp}
            >
              {t('call.cancelConnecting')}
            </button>
          </div>
        )}

        {status === Status.FAILED && (
          <div className="call-status call-status--failed" role="alert">
            <p className="call-error-message">
              {t('call.connectionFailed')}
            </p>
            {errorMessage && (
              <p className="call-error-detail">{errorMessage}</p>
            )}
            <button
              type="button"
              className="call-reconnect-button"
              onClick={handleReconnect}
            >
              {t('call.reconnect')}
            </button>
            {/* 再接続しない場合の脱出口。ゲストはヘッダーが隠れるため必須。 */}
            <button
              type="button"
              className="call-reconnect-button call-reconnect-button--secondary"
              onClick={handleExitCall}
            >
              {t('call.backToTop')}
            </button>
          </div>
        )}

        {status === Status.ENDED && (
          <div className="call-status call-status--ended" role="status">
            <p className="call-error-message">{t('call.ended')}</p>
            <button
              type="button"
              className="call-reconnect-button"
              onClick={handleReconnect}
            >
              {t('call.rejoin')}
            </button>
            {/* 通話画面から出る導線。これが無いとゲストはブラウザ戻る以外に脱离できない。 */}
            <button
              type="button"
              className="call-reconnect-button call-reconnect-button--secondary"
              onClick={handleExitCall}
            >
              {t('call.backToTop')}
            </button>
          </div>
        )}

        {/* モバイル/エンドユーザー専用: 会議室から退出完了画面（LEFT 状態） */}
        {status === Status.LEFT && !exitToAdmin && (
          <div className="call-status call-status--left" role="status">
            <p className="call-error-message">{t('call.leftRoom')}</p>
            <p className="call-error-detail">{t('call.leftRoomDescription')}</p>
            <button
              type="button"
              className="call-reconnect-button"
              onClick={handleReconnect}
            >
              {t('call.rejoin')}
            </button>
            <button
              type="button"
              className="call-reconnect-button call-reconnect-button--secondary"
              onClick={handleGoHome}
            >
              {t('call.backToTop')}
            </button>
          </div>
        )}

        {isAdmin ? (
          /* 管理者レイアウト: 資料共有の有無で表示レイアウトを切り替える。
             - 共有前 (data-sharing='false'): 相手映像を全面に表示し、自分は PiP（小窓）。
             - 共有中 (data-sharing='true'):  共有資料を主役（メイン）に、相手映像と
                                            自分を小画面で並べる（従来どおり）。

             3 つの描画先（subscribersContainerRef / publisherContainerRef /
             sharedSelfRef）は切替後も DOM から外さない。Vonage SDK は initPublisher /
             initScreenPublisher に渡した要素的内側に映像を埋め込むため、display:none で
             消すと共有開始・停止のたびに SDK の再初期化が必要になる。見た目の切り替えは
             CSS（call.css の data-sharing ルール）に集約する。
             管理者は自分の screen ストリームを streamCreated で受信しないため、
             共有資料は自身の publisher プレビュー（sharedSelfRef）から表示する。 */
          <div
            className="call-admin-layout"
            data-sharing={sharing ? 'true' : 'false'}
          >
            {/* メイン: 共有資料領域。共有中は自分の screen プレビューを表示。
                共有前は CSS で非表示にするため、プレースホルダーは出さない。 */}
            <div className="call-admin-main">
              <span className="call-shared-caption">
                {t('call.sharedDocument')}
              </span>
              <div className="call-admin-shared" ref={sharedSelfRef} />
              {sharing && (
                <p className="call-sharing-indicator" role="status">
                  {t('call.sharingIndicator')}
                </p>
              )}
            </div>

            {/* 映像列: 相手映像 + 自分の映像。共有前は全面（相手メイン / 自分は PiP）、
                共有中は右側の小画面列として機能する。 */}
            <div className="call-admin-side">
              <div
                className="call-admin-subview call-remotes"
                ref={subscribersContainerRef}
                aria-label={t('call.remoteView')}
              />
              <div
                className="call-admin-subview call-admin-subview--local"
                ref={publisherContainerRef}
                aria-label={t('call.selfView')}
              >
                <span className="call-subview-caption">
                  {t('call.selfView')}
                </span>
              </div>
            </div>

            {/* 非管理者向け共有領域は使わないが、共通のクリーンアップ対象として保持する。 */}
            <div
              className="call-shared"
              ref={sharedContainerRef}
              aria-hidden="true"
            />
          </div>
        ) : (
          /* 非管理者（モバイル/エンドユーザー）レイアウト: 受信した共有資料を主役に、
             リモートグリッドとローカル PiP を重ねる（現行動作を維持）。 */
          <>
            {/* 共有資料（画面共有）の表示領域。screen ストリーム受信時に data-active。 */}
            <div className="call-shared" ref={sharedContainerRef}>
              <span className="call-shared-caption">
                {t('call.sharedDocument')}
              </span>
            </div>

            {/* リモート参加者の映像グリッド（要件 4.1・4.2）。
               共有資料を受信中は小さな PiP（右上）に縮小し、共有資料の上に重ねる。 */}
            <div
              className={
                sharedActive ? 'call-remotes call-remotes--pip' : 'call-remotes'
              }
              ref={subscribersContainerRef}
              aria-label={t('call.remoteParticipants')}
            />

            {/* 非管理者の共有者（想定外）向けオフスクリーンインジケータ。 */}
            <div
              className="call-screen-indicator"
              ref={screenIndicatorRef}
              aria-hidden="true"
            />

            {/* 自分の映像（ローカル publisher） */}
            <div
              className="call-tile call-tile--local"
              ref={publisherContainerRef}
              aria-label={t('call.localParticipant')}
            />
          </>
        )}

        {/* 通話コントロール（接続中のみ表示）。 */}
        {status === Status.CONNECTED && (
          <div className="call-controls">
            <button
              type="button"
              className="call-control-button"
              onClick={handleToggleMicrophone}
              aria-pressed={microphoneOn}
              aria-label={microphoneOn ? t('call.microphoneOff') : t('call.microphoneOn')}
            >
              {microphoneOn ? t('call.microphoneOff') : t('call.microphoneOn')}
            </button>

            <button
              type="button"
              className="call-control-button"
              onClick={handleToggleCamera}
              aria-pressed={cameraOn}
              aria-label={cameraOn ? t('call.cameraOff') : t('call.cameraOn')}
            >
              {cameraOn ? t('call.cameraOff') : t('call.cameraOn')}
            </button>

            {/* 資料/画面共有ボタンは管理者のみに表示する。 */}
            {isAdmin && (
              <button
                type="button"
                className="call-control-button"
                onClick={handleToggleShare}
                aria-pressed={sharing}
                aria-label={sharing ? t('call.shareStop') : t('call.shareStart')}
              >
                {sharing ? t('call.shareStop') : t('call.shareStart')}
              </button>
            )}

            {/* 通話終了（ハングアップ）ボタン。全参加者（管理者・非管理者）に表示する。 */}
            <button
              type="button"
              className="call-control-button call-control-button--danger"
              onClick={handleHangUp}
              aria-label={t('call.hangUp')}
            >
              {t('call.hangUp')}
            </button>
          </div>
        )}
      </div>

      {!isGuest && sessionId && (
        <p className="call-session">
          {t('call.sessionLabel')}: {sessionId}
        </p>
      )}
    </section>
  );
}
