import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../api/client.js';
import { canManageReservation, visibleReservations } from '../../api/auth.js';
import useAutoRefresh from '../../hooks/useAutoRefresh.js';
import { hasPendingMedia } from './mediaPending.js';

/** 予約状態の選択肢（バックエンド Reservation.status enum と対応）。 */
const STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];

/** 対象サービスの選択肢（バックエンド SERVICE_OPTIONS と対応）。 */
const SERVICE_OPTIONS = [
  { id: 'consultation', title: 'Consultation' },
  { id: 'follow_up', title: 'Follow-up' },
  { id: 'telemedicine', title: 'Telemedicine' },
];

/** 空の作成フォーム初期値。 */
function emptyForm() {
  return {
    contact: '',
    reservationDate: getTodayJst(), // デフォルトは日本時間の今日
    reservationTime: '',
    service: '',
    customService: '',
    language: 'ja',
    assignedStaffId: '',
  };
}

/** Japan Standard Time (GMT+9) オフセット（ミリ秒） */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 日付文字列と時刻文字列を組み合わせて、日本時間として解釈し ISO 8601 (UTC) 文字列に変換する。
 * - dateStr: 'YYYY-MM-DD' 形式
 * - timeStr: 'HH:MM' 形式
 * 日本時間として扱い、UTC に変換して返す。
 */
function toIsoFromJst(dateStr, timeStr) {
  if (!dateStr || !timeStr) return '';
  // 日本時間として Date を構築
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = timeStr.split(':').map(Number);
  // 日本時間（JST = UTC+9）として解釈し、UTC に変換するため 9 時間引く
  // Date.UTC は引数を UTC として扱うため、JST 時刻から 9 時間引いて UTC として構築
  const utcHours = hours - 9;
  const date = new Date(Date.UTC(year, month - 1, day, utcHours, minutes, 0, 0));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * 選択されたスロット値 '<YYYY-MM-DD>T<HH:MM>'（JST 暦日 + JST 時刻）を
 * UTC ISO 文字列へ変換する。
 *
 * スロットの表示タイトルではなく|date|time| を使う，才能 multiDay スロット
 * （title が 'M/D HH:MM'）でも年を含む正しい予約日時になる。
 *
 * @param {string} slotValue
 * @returns {string} UTC ISO 文字列（不正なら ''）
 */
function toIsoFromJstSlot(slotValue) {
  if (!slotValue) return '';
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(slotValue);
  if (!match) return '';
  return toIsoFromJst(match[1], match[2]);
}

/**
 * 予約作成フォームの時刻入力から UTC ISO 文字列を組み立てる。
 *
 * スロット選択時は 'YYYY-MM-DDTHH:MM'、空き枠が無い場合の手入力
 * （input type="time"）は 'HH:MM' になる。後者は日付を含まないため、
 * 表示中の日付（dateStr）と組み合わせて解釈する。
 *
 * @param {string} slotValue
 * @param {string} dateStr 'YYYY-MM-DD'（JST 暦日）
 * @returns {string} UTC ISO 文字列（不正なら ''）
 */
function toIsoFromCreateInput(slotValue, dateStr) {
  if (!slotValue) return '';
  // まず 'YYYY-MM-DDTHH:MM'（スロット選択）として解釈する。
  const fromSlot = toIsoFromJstSlot(slotValue);
  if (fromSlot) return fromSlot;
  // 続いて 'HH:MM'（手入力）として日付と結合して解釈する。
  return toIsoFromJst(dateStr, slotValue);
}

/**
 * 予約時刻 (ISO 文字列, UTC) を日本時間の 'YYYY-MM-DD' と 'HH:MM' に分解する。
 */
function fromIsoToJst(isoStr) {
  if (!isoStr) return { date: '', time: '' };
  const date = new Date(isoStr);
  if (Number.isNaN(date.getTime())) return { date: '', time: '' };
  // UTC -> JST (+9時間)
  const jstDate = new Date(date.getTime() + JST_OFFSET_MS);
  const year = jstDate.getUTCFullYear();
  const month = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jstDate.getUTCDate()).padStart(2, '0');
  const hours = String(jstDate.getUTCHours()).padStart(2, '0');
  const minutes = String(jstDate.getUTCMinutes()).padStart(2, '0');
  return { date: `${year}-${month}-${day}`, time: `${hours}:${minutes}` };
}

/** 電話番号を人間が読みやすい形式にフォーマットする（スペース区切り） */
function formatPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return phone;
  const digits = phone.trim().replace(/\D/g, '');
  if (digits.length < 8) return phone;

  // 日本の番号 (81 で始まる)
  if (digits.startsWith('81')) {
    const national = digits.slice(2);
    if (national.length === 10) {
      // 携帯電話: +81 9021664411 形式（国番号の後スペースあり、その後3-4-3桁区切り）
      return `+81 ${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}`;
    } else if (national.length === 9) {
      // 固定電話: +81 3 1234 5678 形式
      return `+81 ${national.slice(0, 2)} ${national.slice(2, 6)} ${national.slice(6)}`;
    }
  }
  // 米国・カナダ (1 で始まる)
  if (digits.startsWith('1') && digits.length === 11) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  // その他: 国番号 + 残りをスペース区切り
  if (digits.length > 2) {
    const countryCode = digits.slice(0, digits.length - 10);
    const national = digits.slice(-10);
    if (national.length === 10) {
      return `+${countryCode} ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
    }
  }
  return phone;
}

/** 今日の日付を日本時間で取得 (YYYY-MM-DD) */
function getTodayJst() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
  const year = jstNow.getUTCFullYear();
  const month = String(jstNow.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jstNow.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 電話番号のバリデーション（国番号で始まる形式を要求）。
 * 例: 819012345678 (日本), 15551234567 (米国)
 * - + なし、数字のみ
 * - 8-15桁程度
 * - 先頭が 0 ではない（国番号から始まる）
 */
function validatePhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, error: 'required' };
  }
  const digits = phone.trim();
  if (!/^\d+$/.test(digits)) {
    return { valid: false, error: 'digitsOnly' };
  }
  if (digits.length < 8 || digits.length > 15) {
    return { valid: false, error: 'length' };
  }
  if (digits.startsWith('0')) {
    return { valid: false, error: 'noLeadingZero' };
  }
  return { valid: true };
}

/**
 * 予約管理パネル（タスク 17.2 / 要件 2.4）。
 * 予約一覧の取得（api.listReservations）、作成（createReservation）、
 * 更新/キャンセル（updateReservation）を提供する。
 * スタッフは自身に割り当てられた予約のみ表示・操作でき（要件 5.3）、
 * 管理者はすべての予約を管理できる（要件 5.2）。
 *
 * @param {object} props
 * @param {{ userId: string, role: string }} props.user 現在のユーザー
 * @param {(reservation: object) => void} [props.onSelect] 録画/文字起こし連携用に予約を選択
 */
export default function ReservationsPanel({ user, onSelect }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [reservations, setReservations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // 操作成功の一時通知（error と対）。操作開始時にクリアする。
  const [notice, setNotice] = useState('');
  const [contactError, setContactError] = useState('');
  const [form, setForm] = useState(emptyForm());
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [availableSlots, setAvailableSlots] = useState([]);
  const [bookedSlots, setBookedSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [editingSlotId, setEditingSlotId] = useState(null);
  const [editForm, setEditForm] = useState({});
  // 録画・文字起こしデータ（reservationId -> array）
  const [archivesMap, setArchivesMap] = useState({});
  const [transcriptionsMap, setTranscriptionsMap] = useState({});
  // メディア取得エラー（reservationId -> error message）
  const [mediaErrors, setMediaErrors] = useState({});

  /**
   * 予約済みスロットのレンダリング。
   *
   * useCallback にしないのは、この関数が handleEditSlot / handleDeleteSlot を
   * 参照している一方、その両者はこの関数より後に宣言されているため、
   * 依存配列へ書くと TDZ 参照エラーになる。
   * useCallback を使うと、選択日が変わっても古いハンドラが捕まったままになり、
   * 削除後の再取得が別日を更新して表示が残ってしまう。
   */
  function renderBookedSlot(slot) {
    if (editingSlotId === slot.reservationId) {
      return (
        <div key={slot.reservationId} className="booked-slot editing">
          <div className="booked-slot__edit-form">
            <div className="booked-slot__edit-row">
              <label className="field field--small">
                <span>{t('admin.reserve.time')}</span>
                <input
                  type="time"
                  value={editForm.time}
                  onChange={(e) => setEditForm({ ...editForm, time: e.target.value })}
                  required
                />
              </label>
              <label className="field field--small">
                <span>{t('admin.reserve.contact')}</span>
                <input
                  type="text"
                  value={editForm.contact}
                  onChange={(e) => setEditForm({ ...editForm, contact: e.target.value })}
                  required
                />
              </label>
              <label className="field field--small">
                <span>{t('admin.reserve.service')}</span>
                <input
                  type="text"
                  value={editForm.service}
                  onChange={(e) => setEditForm({ ...editForm, service: e.target.value })}
                  required
                />
              </label>
              <label className="field field--small">
                <span>{t('admin.reserve.statusLabel')}</span>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`admin.reserve.status.${s}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field field--small">
                <span>{t('admin.reserve.language')}</span>
                <select
                  value={editForm.language}
                  onChange={(e) => setEditForm({ ...editForm, language: e.target.value })}
                >
                  <option value="ja">{t('common.japanese')}</option>
                  <option value="en">{t('common.english')}</option>
                </select>
              </label>
              <label className="field field--small">
                <span>{t('admin.reserve.assignedStaff')}</span>
                <input
                  type="text"
                  value={editForm.assignedStaffId}
                  onChange={(e) => setEditForm({ ...editForm, assignedStaffId: e.target.value })}
                />
              </label>
            </div>
            <div className="booked-slot__edit-actions">
              <button type="button" className="btn btn--primary btn--small" onClick={() => handleSaveEdit(slot.reservationId)}>
                {t('admin.reserve.save')}
              </button>
              <button type="button" className="btn btn--secondary btn--small" onClick={handleCancelEdit}>
                {t('admin.reserve.cancelEdit')}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div key={slot.reservationId} className="booked-slot">
        <div className="booked-slot__view">
          <div className="booked-slot__info">
            <span className="booked-slot__time">{slot.time}</span>
            <span className="booked-slot__contact">{formatPhoneNumber(slot.contact)}</span>
            <span className="booked-slot__service">{slot.service}</span>
            <span className={`booked-slot__status booked-slot__status--${slot.status}`}>{t(`admin.reserve.status.${slot.status}`)}</span>
          </div>
          <div className="booked-slot__actions">
            <button type="button" className="btn btn--link btn--small" onClick={() => handleEditSlot(slot)}>
              {t('admin.reserve.edit')}
            </button>
            <button type="button" className="btn btn--link btn--danger-text btn--small" onClick={() => handleDeleteSlot(slot.reservationId)}>
              {t('admin.reserve.delete')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    if (!silent) setError('');
    try {
      const result = await api.listReservations();
      const list = Array.isArray(result)
        ? result
        : Array.isArray(result?.reservations)
          ? result.reservations
          : [];
      // ロールに応じて可視な予約へ絞り込む（要件 5.2・5.3）。
      const visible = visibleReservations(user, list);
      setReservations(visible);

      // 各予約の録画・文字起こしを並行取得
      const archives = {};
      const transcriptions = {};
      const mediaErrors = {};
      await Promise.all(
        visible.map(async (r) => {
          try {
            const [archivesRes, transcriptionsRes] = await Promise.all([
              api.getReservationArchives(r.reservationId),
              api.getReservationTranscriptions(r.reservationId),
            ]);
            archives[r.reservationId] = archivesRes.archives || archivesRes || [];
            transcriptions[r.reservationId] = transcriptionsRes.transcriptions || transcriptionsRes || [];
          } catch (err) {
            console.error(`Failed to fetch media for reservation ${r.reservationId}:`, err);
            archives[r.reservationId] = [];
            transcriptions[r.reservationId] = [];
            mediaErrors[r.reservationId] = err instanceof ApiError ? err.message : String(err);
          }
        }),
      );
      setArchivesMap(archives);
      setTranscriptionsMap(transcriptions);
      setMediaErrors(mediaErrors);
    } catch (err) {
      // バックグラウンド更新の一時的な失敗は表示中の一覧を壊さないよう無視する。
      if (!silent) {
        setError(
          err instanceof ApiError ? t('admin.reserve.loadFailed') : t('login.networkError'),
        );
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [user, t]);

  // 録画/文字起こしの DL URL が揃うまで裏で再取得する（Refresh 不要化 / GAP 1）。
  const mediaPending = useMemo(
    () =>
      hasPendingMedia(
        Object.values(archivesMap).flat(),
        Object.values(transcriptionsMap).flat(),
      ),
    [archivesMap, transcriptionsMap],
  );
  useAutoRefresh({
    enabled: mediaPending,
    onRefresh: () => load({ silent: true }),
  });

  /** 指定日の予約可能時間帯と予約済み枠を取得する。 */
  const loadSlots = useCallback(async (dateValue) => {
    if (!dateValue) {
      setAvailableSlots([]);
      setBookedSlots([]);
      return;
    }

    setSlotsLoading(true);
    try {
      // dateValue is already in YYYY-MM-DD format from <input type="date">
      const [availResult, bookedResult] = await Promise.all([
        api.getAvailableSlots(dateValue),
        api.getBookedSlots(dateValue),
      ]);
      setAvailableSlots(availResult.slots || []);
      setBookedSlots(bookedResult.slots || []);
    } catch (err) {
      console.error('Failed to fetch slots:', err);
      // エラー時は空配列のまま（手動入力フォールバック用）
      setAvailableSlots([]);
      setBookedSlots([]);
    } finally {
      setSlotsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 初期表示の日付でも時間スロットを取得する。
  // これが無いと availableSlots が空のまま「時間入力」にフォールバックし、
  // 時刻のプルダウンが一度も表示されない。
  useEffect(() => {
    loadSlots(form.reservationDate);
  }, [loadSlots, form.reservationDate]);

  const formatTime = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    // 保存時刻は UTC。toLocaleString で Asia/Tokyo を指定すれば自動的に JST 表示になる。
    return date.toLocaleString(i18n.language, { timeZone: 'Asia/Tokyo' });
  };

  /**
   * 日付変更時の処理。
   * スロット取得は form.reservationDate を watch する useEffect が一元で行うため、
   * ここでは日付と時刻のクリアだけを担当する（二重リクエストを避ける）。
   */
  const handleDateChange = useCallback((dateValue) => {
    setForm((prev) => ({ ...prev, reservationDate: dateValue, reservationTime: '' }));
    setAvailableSlots([]);
    setBookedSlots([]);
  }, []);

  /** サービス選択変更時の処理（カスタム入力対応） */
  const handleServiceChange = useCallback((value) => {
    if (value === '__custom__') {
      // カスタム選択時は service を '__custom__' に保持して入力欄を表示
      setForm((prev) => ({ ...prev, service: '__custom__', customService: '' }));
    } else {
      setForm((prev) => ({ ...prev, service: value, customService: '' }));
    }
  }, []);

  /** カスタムサービス入力時の処理 */
  const handleCustomServiceChange = useCallback((value) => {
    setForm((prev) => ({ ...prev, customService: value }));
  }, []);

  async function handleCreate(event) {
    event.preventDefault();
    const serviceValue = form.service === '__custom__' ? form.customService : form.service;

    // 連絡先（電話番号）バリデーション
    const phoneValidation = validatePhoneNumber(form.contact);
    if (!phoneValidation.valid) {
      const errorKey = phoneValidation.error === 'required' ? 'admin.reserve.contactRequired'
        : phoneValidation.error === 'digitsOnly' ? 'admin.reserve.contactDigitsOnly'
        : phoneValidation.error === 'length' ? 'admin.reserve.contactLength'
        : 'admin.reserve.contactNoLeadingZero';
      setContactError(t(errorKey));
      return;
    }
    setContactError('');

    // スロット選択（'YYYY-MM-DDTHH:MM'）と手入力（'HH:MM'）の両方を解釈する。
    const reservationTime = toIsoFromCreateInput(form.reservationTime, form.reservationDate);
    if (!form.reservationTime || !serviceValue.trim() || !reservationTime) {
      setError(t('admin.reserve.formIncomplete'));
      return;
    }
    setCreating(true);
    setError('');
    try {
      await api.createReservation({
        contact: form.contact.trim(),
        // reservationTime は '<YYYY-MM-DD>T<HH:MM>'（JST 暦日 + JST 時刻）。
        // 表示タイトルは multiDay の場合 'M/D HH:MM' と年を含まないため、
        // 必ず|date|time の機械可読フィールドから組み立て直す。
        reservationTime,
        service: serviceValue.trim(),
        language: form.language,
        status: 'pending',
        assignedStaffId: form.assignedStaffId.trim() || undefined,
      });
      setForm(emptyForm());
      setAvailableSlots([]);
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError ? t('admin.reserve.createFailed') : t('login.networkError'),
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleStatusChange(reservation, status) {
    setBusyId(reservation.reservationId);
    setError('');
    try {
      await api.updateReservation(reservation.reservationId, { status });
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError ? t('admin.reserve.updateFailed') : t('login.networkError'),
      );
    } finally {
      setBusyId('');
    }
  }

  async function handleCancel(reservation) {
    setBusyId(reservation.reservationId);
    setError('');
    try {
      await api.updateReservation(reservation.reservationId, { status: 'cancelled' });
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError ? t('admin.reserve.cancelFailed') : t('login.networkError'),
      );
    } finally {
      setBusyId('');
    }
  }

  /** 予約済み枠の編集開始 */
  const handleEditSlot = useCallback((slot) => {
    setEditingSlotId(slot.reservationId);
    setEditForm({
      time: slot.time,
      contact: slot.contact,
      service: slot.service,
      status: slot.status,
      language: slot.language,
      assignedStaffId: slot.assignedStaffId || '',
    });
  }, []);

  /** 予約済み枠の編集キャンセル */
  const handleCancelEdit = useCallback(() => {
    setEditingSlotId(null);
    setEditForm({});
  }, []);

  /** 予約済み枠の編集保存 */
  const handleSaveEdit = useCallback(async (reservationId) => {
    setBusyId(reservationId);
    setError('');
    try {
      const patch = {
        contact: editForm.contact.trim(),
        service: editForm.service.trim(),
        status: editForm.status,
        language: editForm.language,
        assignedStaffId: editForm.assignedStaffId.trim() || undefined,
        // 時間変更の場合は reservationTime も更新
        // 編集時は予約済み枠の|time| と表示中の日付から組み立てる。
        // （編集フォームの time は getBookedSlots の'time' = 'HH:MM' をそのまま使う）
        reservationTime: toIsoFromJst(form.reservationDate, editForm.time),
      };
      await api.updateReservation(reservationId, patch);
      await load();
      // 日付が変わっていない場合は bookedSlots も更新
      if (form.reservationDate) {
        const result = await api.getBookedSlots(form.reservationDate);
        setBookedSlots(result.slots || []);
      }
      setEditingSlotId(null);
      setEditForm({});
    } catch (err) {
      setError(
        err instanceof ApiError ? t('admin.reserve.updateFailed') : t('login.networkError'),
      );
    } finally {
      setBusyId('');
    }
  }, [editForm, form.reservationDate]);

  /** 予約済み枠の削除（キャンセル） */
  const handleDeleteSlot = useCallback(async (reservationId) => {
    if (!window.confirm(t('admin.reserve.confirmDelete'))) return;
    setBusyId(reservationId);
    setError('');
    // 失敗メッセージは保持し、最後に設定する（load() が先頭で setError('') するため）。
    let failure = null;
    try {
      await api.updateReservation(reservationId, { status: 'cancelled' });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : null;
      if (status === 404) {
        // 既に削除済み。下の再取得で一覧から消えるためエラー扱いにしない。
      } else {
        // 原因を判別できるよう HTTP ステータスを添える。
        failure =
          err instanceof ApiError
            ? `${t('admin.reserve.cancelFailed')} (HTTP ${status})`
            : t('login.networkError');
      }
    } finally {
      // 予約一覧と予約済み枠の**両方**を再取得する。
      // 片方だけを再取得すると、もう片方にだけ古い行が残り、
      // その残った行の削除が以後 404 で失敗する。
      await Promise.all([load(), loadSlots(form.reservationDate)]);
      setBusyId('');
    }
    if (failure) {
      setError(failure);
    }
  }, [form.reservationDate, load, loadSlots, t]);

  return (
    <section className="admin-panel admin-panel--reservations">
      <div className="admin-panel__header">
        <h2>{t('admin.reservations')}</h2>
        <button type="button" className="btn btn--link" onClick={() => load()} disabled={loading}>
          {t('admin.reserve.refresh')}
        </button>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="form-notice" role="status">
          {notice}
        </p>
      ) : null}

      {/* 予約作成フォーム */}
      <form className="reservation-form" onSubmit={handleCreate}>
        <h3 className="reservation-form__title">{t('admin.reserve.create')}</h3>
        <div className="reservation-form__grid">
          <label className="field">
            {t('admin.reserve.contact')}
            <input
              type="text"
              value={form.contact}
              onChange={(e) => {
                setForm({ ...form, contact: e.target.value });
                if (contactError) setContactError('');
              }}
              disabled={creating}
              required
              placeholder="819012345678"
              style={{ width: '280px', minWidth: '280px' }}
            />
            {contactError && <span className="field__error">{contactError}</span>}
          </label>
          <label className="field">
            {t('admin.reserve.time')}
            <div className="field__date-time">
              <input
                type="date"
                value={form.reservationDate}
                onChange={(e) => handleDateChange(e.target.value)}
                disabled={creating}
                required
              />
              {availableSlots.length > 0 ? (
                <select
                  value={form.reservationTime}
                  onChange={(e) => setForm({ ...form, reservationTime: e.target.value })}
                  disabled={creating}
                  required
                >
                  <option value="">{t('admin.reserve.selectTime')}</option>
                  {availableSlots.map((slot) => (
                    <option key={slot.id} value={`${slot.date}T${slot.time}`}>
                      {slot.title}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    type="time"
                    value={form.reservationTime}
                    onChange={(e) => setForm({ ...form, reservationTime: e.target.value })}
                    disabled={creating}
                    required
                    placeholder={t('admin.reserve.selectTime')}
                  />
                  {slotsLoading && <span className="field__loading">{t('common.loading')}</span>}
                </>
              )}
            </div>
          </label>
          <label className="field">
            {t('admin.reserve.service')}
            <div className="field__service">
              <select
                value={form.service}
                onChange={(e) => handleServiceChange(e.target.value)}
                disabled={creating}
              >
                <option value="">{t('admin.reserve.selectService')}</option>
                {SERVICE_OPTIONS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {t(`admin.reserve.serviceOptions.${s.id}`)}
                  </option>
                ))}
                <option value="__custom__">{t('admin.reserve.customService')}</option>
              </select>
              {form.service === '__custom__' && (
                <input
                  type="text"
                  value={form.customService}
                  onChange={(e) => handleCustomServiceChange(e.target.value)}
                  placeholder={t('admin.reserve.customServicePlaceholder')}
                  disabled={creating}
                  required
                />
              )}
            </div>
          </label>
          <label className="field">
            {t('admin.reserve.language')}
            <select
              value={form.language}
              onChange={(e) => setForm({ ...form, language: e.target.value })}
              disabled={creating}
            >
              <option value="ja">{t('common.japanese')}</option>
              <option value="en">{t('common.english')}</option>
            </select>
          </label>
          <label className="field">
            {t('admin.reserve.assignedStaff')}
            <input
              type="text"
              value={form.assignedStaffId}
              onChange={(e) => setForm({ ...form, assignedStaffId: e.target.value })}
              disabled={creating}
            />
          </label>
        </div>
        <button type="submit" className="btn btn--primary" disabled={creating}>
          {creating ? t('common.loading') : t('admin.reserve.submit')}
        </button>
      </form>

      {/* 選択日の予約済み枠一覧（管理者用：編集/削除可能） */}
{form.reservationDate && bookedSlots.length > 0 && (
        <div>
          <section className="booked-slots-section">
          <h3 className="booked-slots__title">
            {t('admin.reserve.bookedSlotsTitle', { date: form.reservationDate })}
          </h3>
          <div className="booked-slots__list">
            {bookedSlots.map((slot) => renderBookedSlot(slot))}
          </div>
          </section>
        </div>
      )}

      {/* 予約一覧 */}
      {loading ? (
        <p className="admin-empty">{t('common.loading')}</p>
      ) : reservations.length === 0 ? (
        <p className="admin-empty">{t('admin.reserve.empty')}</p>
      ) : (
        <div className="reservation-table-wrap">
          <table className="reservation-table">
            <thead>
              <tr>
                <th>{t('admin.reserve.time')}</th>
                <th>{t('admin.reserve.service')}</th>
                <th>{t('admin.reserve.contact')}</th>
                <th>{t('admin.reserve.statusLabel')}</th>
                <th>{t('admin.reserve.recordings')}</th>
                <th>{t('admin.reserve.transcriptions')}</th>
                <th>{t('admin.reserve.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {reservations.map((r) => {
                const manageable = canManageReservation(user, r);
                const rowBusy = busyId === r.reservationId;
                return (
                  <tr key={r.reservationId}>
                    <td data-label={t('admin.reserve.time')}>
                      {formatTime(r.reservationTime)}
                    </td>
                    <td data-label={t('admin.reserve.service')}>{r.service}</td>
                    <td data-label={t('admin.reserve.contact')}>{formatPhoneNumber(r.contact)}</td>
                    <td data-label={t('admin.reserve.statusLabel')}>
                      <select
                        value={r.status}
                        onChange={(e) => handleStatusChange(r, e.target.value)}
                        disabled={!manageable || rowBusy}
                        aria-label={t('admin.reserve.statusLabel')}
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {t(`admin.reserve.status.${s}`)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td data-label={t('admin.reserve.recordings')}>
                      {archivesMap[r.reservationId]?.map((a) => (
                        <div key={a.archiveId || a.id} className="media-link">
                          <a
                            href={a.downloadUrl || a.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="media-link__download"
                          >
                            {t('admin.reserve.downloadRecording')} {a.name || a.archiveId || a.id}
                          </a>
                          <span className="media-meta">
                            {a.duration ? `${a.duration}s` : ''}
                            {a.createdAt ? ` · ${new Date(a.createdAt).toLocaleString(undefined, { timeZone: 'Asia/Tokyo' })}` : ''}
                          </span>
                        </div>
                      ))}
                      {mediaErrors[r.reservationId] && (
                        <span className="media-error" title={mediaErrors[r.reservationId]}>
                          {t('admin.reserve.mediaError')}
                        </span>
                      )}
                      {!archivesMap[r.reservationId]?.length && !mediaErrors[r.reservationId] && (
                        <span className="media-empty">{t('admin.reserve.noRecordings')}</span>
                      )}
                    </td>
                    <td data-label={t('admin.reserve.transcriptions')}>
                      {transcriptionsMap[r.reservationId]?.map((transcription) => (
                        <div key={transcription.transcriptionId || transcription.id} className="media-link">
                          <a
                            href={transcription.downloadUrl || transcription.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="media-link__download"
                          >
                            {t('admin.reserve.downloadTranscription')} {transcription.name || transcription.transcriptionId || transcription.id}
                          </a>
                          <span className="media-meta">
                            {transcription.language ? ` · ${transcription.language}` : ''}
                            {transcription.createdAt ? ` · ${new Date(transcription.createdAt).toLocaleString(undefined, { timeZone: 'Asia/Tokyo' })}` : ''}
                          </span>
                        </div>
                      ))}
                      {mediaErrors[r.reservationId] && (
                        <span className="media-error" title={mediaErrors[r.reservationId]}>
                          {t('admin.reserve.mediaError')}
                        </span>
                      )}
                      {!transcriptionsMap[r.reservationId]?.length && !mediaErrors[r.reservationId] && (
                        <span className="media-empty">{t('admin.reserve.noTranscriptions')}</span>
                      )}
                    </td>
                    <td data-label={t('admin.reserve.actions')} className="reservation-actions">
                      {r.sessionId && r.status !== 'cancelled' ? (
                        <button
                          type="button"
                          className="btn btn--primary btn--small"
                          onClick={() => {
                            window.open(`/call/${r.sessionId}`, '_blank', 'width=1200,height=800,noopener,noreferrer');
                          }}
                          disabled={!manageable || rowBusy}
                        >
                          {t('admin.reserve.joinVideo')}
                        </button>
                      ) : null}
                      {onSelect ? (
                        <button
                          type="button"
                          className="btn btn--link"
                          onClick={() => onSelect(r)}
                        >
                          {t('admin.reserve.select')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn--link btn--small"
                        onClick={async () => {
                          setBusyId(r.reservationId);
                          setError('');
                          setNotice('');
                          try {
                            await api.resendNotification(r.reservationId);
                            setNotice(t('admin.reserve.resendSuccess'));
                            await load();
                          } catch (err) {
                            setError(
                              err instanceof ApiError ? t('admin.reserve.resendFailed') : t('login.networkError'),
                            );
                          } finally {
                            setBusyId('');
                          }
                        }}
                        disabled={!manageable || rowBusy || r.status === 'cancelled'}
                      >
                        {t('admin.reserve.resendNotification')}
                      </button>
                      <button
                        type="button"
                        className="btn btn--link btn--danger-text btn--small"
                        onClick={async () => {
                          if (!window.confirm(t('admin.reserve.confirmDelete'))) return;
                          try {
                            await api.deleteReservation(r.reservationId);
                            // 予約済み枠一覧も同時に再取得する。load() は予約一覧
                            // （テーブル）しか更新しないため、ここだけだと
                            // 「予約済みスロット」に削除済みの行が残り、
                            // その行の削除ボタンが 404 で失敗する。
                            await Promise.all([load(), loadSlots(form.reservationDate)]);
                          } catch (err) {
                            setError(
                              err instanceof ApiError ? t('admin.reserve.deleteFailed') : t('login.networkError'),
                            );
                          }
                        }}
                        disabled={!manageable || rowBusy}
                      >
                        {t('admin.reserve.delete')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}