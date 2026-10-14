import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, clearAuthToken } from '../api/client.js';
import { getCurrentUser, menuItemsForRole } from '../api/auth.js';
import createSocketClient from '../api/socket.js';
import ReservationsPanel from '../components/admin/ReservationsPanel.jsx';
import NotificationsPanel from '../components/admin/NotificationsPanel.jsx';
import RecordingPanel from '../components/admin/RecordingPanel.jsx';
import TranscriptionPanel from '../components/admin/TranscriptionPanel.jsx';

function renderSection(activeSection, {
  user,
  notifications,
  onDismissNotification,
  onClearNotifications,
  onSelectReservation,
  recordingStatus,
  recordingBusy,
  onStartRecording,
  onStopRecording,
  onViewTranscription,
  defaultSessionId,
  defaultArchiveId,
}) {
  switch (activeSection) {
    case 'reservations':
      return <ReservationsPanel user={user} onSelect={onSelectReservation} />;
    case 'notifications':
      return (
        <NotificationsPanel
          notifications={notifications}
          onDismiss={onDismissNotification}
          onClear={onClearNotifications}
        />
      );
    case 'recording':
      return (
        <RecordingPanel
          recordingStatus={recordingStatus}
          busy={recordingBusy}
          onStart={onStartRecording}
          onStop={onStopRecording}
          onViewTranscription={onViewTranscription}
          defaultSessionId={defaultSessionId}
        />
      );
    case 'transcription':
      return <TranscriptionPanel defaultArchiveId={defaultArchiveId} />;
    default:
      return null;
  }
}

export default function AdminPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // 認証済みユーザーをトークンから取得する（表示制御用。認可はサーバー側で必ず実施される）。
  // オブジェクトを毎レンダー作り直すと子パネルの useEffect 依存が変化するため一度だけ生成する。
  const user = useMemo(() => getCurrentUser() ?? { userId: '', role: '' }, []);

  const [activeSection, setActiveSection] = useState('reservations');
  const [notifications, setNotifications] = useState([]);
  const [selectedReservation, setSelectedReservation] = useState(null);
  const [recordingStatus, setRecordingStatus] = useState(null);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [selectedArchiveId, setSelectedArchiveId] = useState('');

  const visibleMenuItems = menuItemsForRole(user.role);

  useEffect(() => {
    const socketClient = createSocketClient();
    socketClient.connect();

    // 10分前リマインダーをブラウザ通知で表示する
    const requestNotificationPermission = async () => {
      if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
    };
    requestNotificationPermission().catch(() => {});

    const unsubscribeReservationDue = socketClient.onReservationDue((payload) => {
      const notification = {
        id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        reservationId: payload.reservationId,
        contact: payload.contact,
        reservationTime: payload.reservationTime,
        service: payload.service,
        language: payload.language,
        receivedAt: Date.now(),
      };
      setNotifications((prev) => [notification, ...prev]);
    });

    const unsubscribeTenMinReminder = socketClient.onTenMinReminder((payload) => {
      const notification = {
        id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        reservationId: payload.reservationId,
        contact: payload.contact,
        reservationTime: payload.reservationTime,
        service: payload.service,
        language: payload.language,
        receivedAt: Date.now(),
        isReminder: true,
      };
      setNotifications((prev) => [notification, ...prev]);

      // ブラウザ通知を表示（タブが非アクティブでも表示される）
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('予約まで10分', {
          body: `${payload.service} の予約まであと10分です（${payload.contact}）`,
          icon: '/favicon.svg',
          tag: `ten-min-reminder-${payload.reservationId}`,
        });
      }
    });

    // 管理者による手動再通知（ジョインリンク再送）
    const unsubscribeManualJoinLink = socketClient.onManualJoinLink((payload) => {
      const notification = {
        id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        reservationId: payload.reservationId,
        contact: payload.contact,
        reservationTime: payload.reservationTime,
        service: payload.service,
        language: payload.language,
        receivedAt: Date.now(),
        isReminder: false,
        isManualResend: true,
      };
      setNotifications((prev) => [notification, ...prev]);
    });

    // 録画状態変化（recording:status）を録画面パネルへ反映する（要件 7.5）。
    const unsubscribeRecordingStatus = socketClient.onRecordingStatus((payload) => {
      setRecordingStatus(payload);
    });

    return () => {
      unsubscribeReservationDue();
      unsubscribeTenMinReminder();
      unsubscribeManualJoinLink();
      unsubscribeRecordingStatus();
      socketClient.disconnect();
    };
  }, []);

  const handleLogout = () => {
    clearAuthToken();
    navigate('/login', { replace: true });
  };

  const handleDismissNotification = (id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  const handleClearNotifications = () => {
    setNotifications([]);
  };

  const handleSelectReservation = (reservation) => {
    setSelectedReservation(reservation);
  };

  // 録画一覧から文字起こし表示へ遷移する（archiveId を引き継ぐ）。
  const handleViewTranscription = (archiveId) => {
    setSelectedArchiveId(archiveId || '');
    setActiveSection('transcription');
  };

  const handleStartRecording = async ({ sessionId, withTranscription }) => {
    setRecordingBusy(true);
    try {
      const result = await api.startRecording({ sessionId, withTranscription });
      const archiveId = result?.archive?.id || '';
      setRecordingStatus({ status: 'started', sessionId, archiveId });
    } catch (err) {
      setRecordingStatus({
        status: 'start_failed',
        sessionId,
        error: err instanceof ApiError ? t('admin.record.startFailed') : t('login.networkError'),
      });
    } finally {
      setRecordingBusy(false);
    }
  };

  const handleStopRecording = async (archiveId) => {
    if (!archiveId) return;
    setRecordingBusy(true);
    try {
      await api.stopRecording(archiveId);
      setRecordingStatus((prev) => ({ ...(prev || {}), status: 'stopped', archiveId }));
    } catch (err) {
      setRecordingStatus((prev) => ({
        ...(prev || {}),
        status: 'stop_failed',
        archiveId,
        error: err instanceof ApiError ? t('admin.record.stopFailed') : t('login.networkError'),
      }));
    } finally {
      setRecordingBusy(false);
    }
  };

  const renderSectionFn = () => renderSection(activeSection, {
    user,
    notifications,
    onDismissNotification: handleDismissNotification,
    onClearNotifications: handleClearNotifications,
    onSelectReservation: handleSelectReservation,
    recordingStatus,
    recordingBusy,
    onStartRecording: handleStartRecording,
    onStopRecording: handleStopRecording,
    onViewTranscription: handleViewTranscription,
    defaultSessionId: selectedReservation?.sessionId || '',
    defaultArchiveId: selectedArchiveId,
  });

  return (
    <div className="page page--admin admin-layout">
      <header className="admin-header">
        <div>
          <h1>Admin</h1>
          <p>Signed in</p>
        </div>
        <button type="button" onClick={handleLogout}>
          Logout
        </button>
      </header>

      <div className="admin-body">
        <nav>
          <ul>
            {visibleMenuItems.map((itemKey) => (
              <li key={itemKey}>
                <button
                  type="button"
                  onClick={() => setActiveSection(itemKey)}
                  className={activeSection === itemKey ? 'active' : ''}
                >
                  {t(`admin.menu.${itemKey}`)}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div>{renderSectionFn()}</div>
      </div>
    </div>
  );
}
