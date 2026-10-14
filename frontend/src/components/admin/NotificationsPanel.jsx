import { useTranslation } from 'react-i18next';

/**
 * 画面内通知パネル（タスク 17.2 / 要件 3.3・3.4）。
 * Socket.IO `reservation:due` / `reservation:tenMinReminder` で受信した通知を一覧表示する。
 * 通知データの受信・保持は AdminPage 側で行い、ここは表示に専念する。
 *
 * @param {object} props
 * @param {Array<{ id: string, reservationId?: string, contact?: string,
 *   reservationTime?: string, service?: string, language?: string,
 *   receivedAt: number, isReminder?: boolean }>} props.notifications
 * @param {(id: string) => void} props.onDismiss
 * @param {() => void} props.onClear
 */
export default function NotificationsPanel({ notifications = [], onDismiss, onClear }) {
  const { t, i18n } = useTranslation();

  const formatTime = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(i18n.language, { timeZone: 'Asia/Tokyo' });
  };

  const getNotificationType = (n) => {
    if (n.isReminder) return 'reminder';
    if (n.isManualResend) return 'manualResend';
    return 'due';
  };

  const getNotificationTypeLabel = (type) => {
    return t(`admin.notify.${type}`);
  };

  const getNotificationSummary = (n) => {
    if (n.isReminder) {
      return t('admin.notify.reminderSummary', { service: n.service });
    }
    if (n.isManualResend) {
      return t('admin.notify.manualResendSummary', { service: n.service });
    }
    return t('admin.notify.dueSummary', { service: n.service });
  };

  return (
    <section className="admin-panel admin-panel--notifications" aria-live="polite">
      <div className="admin-panel__header">
        <h2>{t('admin.notifications')}</h2>
        {notifications.length > 0 ? (
          <button type="button" className="btn btn--link" onClick={onClear}>
            {t('admin.notify.clearAll')}
          </button>
        ) : null}
      </div>

      {notifications.length === 0 ? (
        <p className="admin-empty">{t('admin.notify.empty')}</p>
      ) : (
        <ul className="notification-list">
          {notifications.map((n) => {
            const type = getNotificationType(n);
            return (
              <li key={n.id} className={`notification-item notification-item--${type}`} role="status">
                <div className="notification-item__body">
                  <strong className="notification-item__title">
                    {getNotificationTypeLabel(type)}
                  </strong>
                  <span className="notification-item__meta">
                    {n.service ? `${n.service} · ` : ''}
                    予約時刻: {formatTime(n.reservationTime)}
                    {n.receivedAt && <span> · 通知受信: {formatTime(n.receivedAt)}</span>}
                  </span>
                  <span className="notification-item__summary">
                    {getNotificationSummary(n)}
                  </span>
{n.contact ? (
                    <span className="notification-item__contact">
                      {t('admin.notify.contactLabel')}: {n.contact}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn btn--icon"
                  aria-label={t('common.close')}
                  onClick={() => onDismiss(n.id)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
