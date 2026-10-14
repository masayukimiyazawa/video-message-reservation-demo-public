/**
 * ReservationsPanel の予約日時プルダウン回帰テスト
 *
 * 実害の不具合:
 *   初期表示時の日付（getTodayJst()）に対して予約可能時間が取得されず、
 *   availableSlots が空のまま `<input type="time">` にフォールバックしていた。
 *   結果として管理画面の「時間」欄がプルダウンにならず、時刻選択ができなかった。
 *
 * 検証の要点:
 *   - マウント直後（ユーザー操作なし）でスロット取得 API が呼ばれる
 *   - 取得後のスロットが `<select>` として描画される
 *   - 日付変更時に再取得される
 *   - API 失敗時は手動入力へフォールバックする（既存挙動の維持）
 *
 * @module components/admin/ReservationsPanel.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n, { changeLanguage } from '../../i18n/index.js';
import ReservationsPanel from './ReservationsPanel.jsx';
import { api, ApiError } from '../../api/client.js';

/**
 * i18n と Router 付きで描画する。
 * ReservationsPanel は useNavigate() を使うため Router 必須。
 */
function renderPanel() {
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <ReservationsPanel user={{ userId: 'u-1', role: 'administrator' }} onSelect={() => {}} />
      </I18nextProvider>
    </MemoryRouter>,
  );
}

/**
 * 新規作成フォーム内の「日時フィールド」だけを特定する。
 * フォームにはサービス・言語などの select もあるため、date-time 欄で绞り込む。
 */
function dateTimeField(container) {
  const form = container.querySelector('form');
  const field = form.querySelector('.field__date-time');
  expect(field).not.toBeNull();
  return { form, field };
}

/** API をスタブする。予約済みは空、利用可能スロットのみ指定。 */
function stubApis({ available = [{ id: 'slot_1400', title: '14:00' }] } = {}) {
  const getAvailableSlots = vi.fn().mockResolvedValue({ slots: available });
  const getBookedSlots = vi.fn().mockResolvedValue({ slots: [] });
  const listReservations = vi.fn().mockResolvedValue({ reservations: [] });
  const createReservation = vi.fn().mockResolvedValue({
    reservation: { reservationId: 'r-1' },
  });

  vi.spyOn(api, 'getAvailableSlots').mockImplementation(getAvailableSlots);
  vi.spyOn(api, 'getBookedSlots').mockImplementation(getBookedSlots);
  vi.spyOn(api, 'listReservations').mockImplementation(listReservations);
  vi.spyOn(api, 'createReservation').mockImplementation(createReservation);

  return { getAvailableSlots, getBookedSlots, listReservations, createReservation };
}

beforeEach(async () => {
  await changeLanguage('en');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReservationsPanel: 予約日時のプルダウン', () => {
  it('初期表示のユーザー操作なしでスロット取得 API を呼ぶ', async () => {
    const { getAvailableSlots, getBookedSlots } = stubApis();

    renderPanel();

    // 日付変更を発生させなくても、mount 時に取得される。
    await waitFor(() => {
      expect(getAvailableSlots).toHaveBeenCalledTimes(1);
      expect(getBookedSlots).toHaveBeenCalledTimes(1);
    });

    // 初期日付（JST 今日）がそのまま渡される。
    const requestedDate = getAvailableSlots.mock.calls[0][0];
    expect(requestedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('取得したスロットが time のプルダウン（select）として描画される', async () => {
    stubApis({
      available: [
        { id: 'slot_0900', title: '09:00' },
        { id: 'slot_1030', title: '10:30' },
        { id: 'slot_1400', title: '14:00' },
      ],
    });

    const { container } = renderPanel();
    const { field } = dateTimeField(container);

    // 実害だった点: 時刻入力（type=time）ではなく select が出ること。
    const select = await waitFor(() => {
      const el = field.querySelector('select');
      expect(el).not.toBeNull();
      return el;
    });

    expect(select.tagName).toBe('SELECT');
    expect(within(select).getByRole('option', { name: '09:00' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: '10:30' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: '14:00' })).toBeInTheDocument();

    // フォールバックの type=time 入力は出ない。
    expect(field.querySelector('input[type="time"]')).toBeNull();
  });

  it('multiDay スロット（title に日付付き）でも予約を作成できる', async () => {
    // 回帰: 表示タイトル 'M/D HH:MM' をそのまま送信すると toIsoFromJst が
    // Number('10/2 09') => NaN になり reservationTime が空.createFailed になっていた。
    const { createReservation } = stubApis({
      available: [
        { id: 'slot_0900_day1', title: '10/2 09:00', time: '09:00', date: '2026-10-02' },
        { id: 'slot_1030_day2', title: '10/3 10:30', time: '10:30', date: '2026-10-03' },
      ],
    });

    const user = userEvent.setup();
    const { container } = renderPanel();
    const { form: createForm, field } = dateTimeField(container);

    // タイトルは日付付き、value は date|time になること。
    const select = await waitFor(() => {
      const el = field.querySelector('select');
      expect(el).not.toBeNull();
      return el;
    });
    expect(within(select).getByRole('option', { name: '10/3 10:30' })).toHaveValue(
      '2026-10-03T10:30',
    );

    // 必須項目（連絡先・時刻・サービス）を埋める。
    await user.type(createForm.querySelector('input[type="text"]'), '819012345678');
    await user.selectOptions(select, '2026-10-03T10:30');
    const serviceSelect = within(createForm).getByDisplayValue('Select service');
    await user.selectOptions(serviceSelect, 'consultation');

    await user.click(within(createForm).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createReservation).toHaveBeenCalled();
    });

    const payload = createReservation.mock.calls[0][0];
    // 2026-10-03 10:30 JST = 2026-10-03T01:30:00.000Z
    expect(payload.reservationTime).toBe('2026-10-03T01:30:00.000Z');
  });

  it('スロットが空のときは手動入力（type=time）へフォールバックする', async () => {
    stubApis({ available: [] });

    const { container } = renderPanel();
    const { field } = dateTimeField(container);

    await waitFor(() => {
      expect(field.querySelector('input[type="time"]')).not.toBeNull();
    });
    expect(field.querySelector('select')).toBeNull();
  });

  it('スロットが空の手入力（HH:MM）でも日付と結合して予約を作成できる', async () => {
    // 回帰: 手入力は 'HH:MM' のみのため toIsoFromJstSlot では空文字になり、
    // reservationTime が空のまま作成されていた。表示中の日付と結合して送ること。
    const { createReservation } = stubApis({ available: [] });

    const user = userEvent.setup();
    const { container } = renderPanel();
    const { form: createForm, field } = dateTimeField(container);

    const timeInput = await waitFor(() => {
      const el = field.querySelector('input[type="time"]');
      expect(el).not.toBeNull();
      return el;
    });
    const dateInput = field.querySelector('input[type="date"]');
    const dateValue = dateInput.value; // JST 今日 (YYYY-MM-DD)

    fireEvent.change(timeInput, { target: { value: '14:30' } });

    await user.type(createForm.querySelector('input[type="text"]'), '819012345678');
    const serviceSelect = within(createForm).getByDisplayValue('Select service');
    await user.selectOptions(serviceSelect, 'consultation');

    await user.click(within(createForm).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createReservation).toHaveBeenCalled();
    });

    const payload = createReservation.mock.calls[0][0];
    // dateValue の 14:30 JST = 同日 05:30 UTC
    const [y, m, d] = dateValue.split('-').map(Number);
    const expected = new Date(Date.UTC(y, m - 1, d, 14 - 9, 30, 0, 0)).toISOString();
    expect(payload.reservationTime).toBe(expected);
  });

  it('日付を変更すると新しい日付でスロットを再取得する', async () => {
    const { getAvailableSlots } = stubApis({
      available: [
        { id: 's1', title: '09:00' },
        { id: 's2', title: '10:30' },
      ],
    });

    const { container } = renderPanel();
    await waitFor(() => expect(getAvailableSlots).toHaveBeenCalledTimes(1));

    const dateInput = dateTimeField(container).field.querySelector('input[type="date"]');
    expect(dateInput).not.toBeNull();
    // JST 今日 + 1 日
    const d = new Date(`${dateInput.value}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const nextDate = d.toISOString().slice(0, 10);

    // <input type="date"> は user.type では日付として解釈されないため change を直接発火する。
    fireEvent.change(dateInput, { target: { value: nextDate } });

    await waitFor(() => {
      expect(getAvailableSlots).toHaveBeenCalledTimes(2);
    });
    expect(getAvailableSlots.mock.calls[1][0]).toBe(nextDate);
  });

  it('スロット取得が失敗しても type=time にフォールバックしてクラッシュしない', async () => {
    vi.spyOn(api, 'getAvailableSlots').mockRejectedValue(new Error('network down'));
    vi.spyOn(api, 'getBookedSlots').mockRejectedValue(new Error('network down'));
    vi.spyOn(api, 'listReservations').mockResolvedValue({ reservations: [] });
    vi.spyOn(api, 'createReservation').mockResolvedValue({
      reservation: { reservationId: 'r-1' },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = renderPanel();
    const { field } = dateTimeField(container);

    await waitFor(() => {
      expect(field.querySelector('input[type="time"]')).not.toBeNull();
    });
    expect(field.querySelector('select')).toBeNull();
    errorSpy.mockRestore();
  });
});

describe('ReservationsPanel: 再通知', () => {
  /** 再通知ボタンを持つ予約1件を含む予約一覧を返す。 */
  function stubReservationList(reservations) {
    vi.spyOn(api, 'getAvailableSlots').mockResolvedValue({ slots: [] });
    vi.spyOn(api, 'getBookedSlots').mockResolvedValue({ slots: [] });
    vi.spyOn(api, 'createReservation').mockResolvedValue({
      reservation: { reservationId: 'r-new' },
    });
    return vi.spyOn(api, 'listReservations').mockResolvedValue({ reservations });
  }

  const target = {
    reservationId: 'r-1',
    contact: '819012345678',
    service: 'Consultation',
    status: 'confirmed',
    language: 'ja',
    sessionId: 'sess-1',
    reservationTime: '2026-10-03T01:30:00.000Z',
  };

  it('再通知ボタンで通知 API を呼ぶ', async () => {
    stubReservationList([target]);
    const resendNotification = vi
      .spyOn(api, 'resendNotification')
      .mockResolvedValue({ ok: true, joinUrl: 'https://example.test/join/tok-1' });

    renderPanel();

    const button = await screen.findByRole('button', { name: /resend/i });
    await userEvent.click(button);

    await waitFor(() => {
      expect(resendNotification).toHaveBeenCalledWith('r-1');
    });
  });

  it('API が未実装でも「サーバーに接続できませんでした」以外の適切な文言を出す', async () => {
    stubReservationList([target]);
    // 現実装では存在しなかった「未定義メソッド」を再現する。
    vi.spyOn(api, 'resendNotification').mockRejectedValue(
      new TypeError("api.resendNotification is not a function"),
    );

    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /resend/i }));

    // 旧実装はこのケースをネットワークエラーと誤表示していた。
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});

/**
 * 「削除した予約が『予約済みスロット』に残り、その行の削除が 404 で失敗する」不具合の回帰テスト。
 *
 * 実害の不具合:
 *   予約一覧（テーブル）の「削除」は DELETE でレコードを消すが、再取得するのは
 *   予約一覧だけで「予約済みスロット」の state は更新されなかった。その結果
 *   「予約済みスロット」に削除済みの行が残り、その行の「削除」ボタンは
 *   存在しない予約 ID へ PATCH するため 404 になり、
 *   「予約のキャンセルに失敗しました」と表示された（キャンセルは未実行のまま）。
 *
 * 検証の要点:
 *   - テーブル削除後も「予約済みスロット」が再取得される（残存しない）
 *   - 「予約済みスロット」側の削除は 404 でもエラー表示にせず一覧を治愈させる
 *   - キャンセル失敗時は HTTP ステータスを添えて原因を判別できるようにする
 */
describe('ReservationsPanel: 削除後に予約済みスロットが更新される', () => {
  /** 予約済みスロットに 1 件を持つ状態を返す（予約一覧は空）。 */
  function stubWithBookedSlot(slot) {
    vi.spyOn(api, 'getAvailableSlots').mockResolvedValue({ slots: [] });
    const getBookedSlots = vi.spyOn(api, 'getBookedSlots').mockResolvedValue({ slots: [slot] });
    vi.spyOn(api, 'listReservations').mockResolvedValue({ reservations: [] });
    vi.spyOn(api, 'getReservationArchives').mockResolvedValue({ archives: [] });
    vi.spyOn(api, 'getReservationTranscriptions').mockResolvedValue({ transcriptions: [] });
    return getBookedSlots;
  }

  const slot = {
    reservationId: 'r-1',
    time: '14:00',
    contact: '12025550101',
    service: 'telemedicine',
    status: 'confirmed',
    language: 'ja',
  };

  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('予約済みスロットの削除でキャンセルが呼ばれ、続けて一覧が再取得される', async () => {
    const getBookedSlots = stubWithBookedSlot(slot);
    const updateReservation = vi
      .spyOn(api, 'updateReservation')
      .mockResolvedValue({ reservation: { ...slot, status: 'cancelled' } });

    renderPanel();

    const deleteButton = await screen.findByRole('button', { name: 'Delete' });
    await userEvent.click(deleteButton);

    await waitFor(() => {
      expect(updateReservation).toHaveBeenCalledWith('r-1', { status: 'cancelled' });
    });
    // キャンセル後に予約済みスロットが取り直される（= 行が残らない）。
    await waitFor(() => {
      expect(getBookedSlots.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('キャンセルが 404（既に削除済み）でもエラー表示にせず一覧を再取得する', async () => {
    // 実害ケース: 残存した行の削除は 404 になり「キャンセル失敗」と表示された。
    const getBookedSlots = stubWithBookedSlot(slot);
    vi.spyOn(api, 'updateReservation').mockRejectedValue(
      new ApiError('not found', { status: 404, body: { code: 'not_found' } }),
    );

    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    // 一覧を取り直すので再取得される。
    await waitFor(() => {
      expect(getBookedSlots.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    // 404 は「キャンセル失敗」として誤表示しない。
    expect(screen.queryByText(/Failed to cancel the reservation/)).not.toBeInTheDocument();
  });

  it('キャンセルが 403 などの失敗なら HTTP ステータスを添えて表示する', async () => {
    // 原因が判別できるようステータスが付与されていることを確認する。
    stubWithBookedSlot(slot);
    vi.spyOn(api, 'updateReservation').mockRejectedValue(
      new ApiError('forbidden', { status: 403, body: { error: 'forbidden' } }),
    );

    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/403/);
    });
  });

  it('予約一覧（テーブル）側の削除でも「予約済みスロット」が再取得される', async () => {
    // 実害の起点: テーブル側の削除は load()（予約一覧のみ）しか再取得しないため、
    // 「予約済みスロット」に削除済みの行が残り、その行の削除が 404 で失敗した。
    vi.spyOn(api, 'getAvailableSlots').mockResolvedValue({ slots: [] });
    const getBookedSlots = vi
      .spyOn(api, 'getBookedSlots')
      .mockResolvedValue({ slots: [slot] });
    vi.spyOn(api, 'listReservations').mockResolvedValue({
      reservations: [
        {
          reservationId: 'r-1',
          contact: '12025550101',
          service: 'telemedicine',
          status: 'completed',
          language: 'ja',
          reservationTime: '2026-10-05T05:00:00.000Z',
        },
      ],
    });
    vi.spyOn(api, 'getReservationArchives').mockResolvedValue({ archives: [] });
    vi.spyOn(api, 'getReservationTranscriptions').mockResolvedValue({ transcriptions: [] });
    const deleteReservation = vi
      .spyOn(api, 'deleteReservation')
      .mockResolvedValue({ reservation: { reservationId: 'r-1' } });

    const { container } = renderPanel();

    // テーブル側の「削除」ボタン（予約済みスロット側の同名ボタンと区別する）。
    // 予約一覧は非同期取得のため描画を待つ。
    const table = await waitFor(() => {
      const el = container.querySelector('.reservation-table-wrap');
      expect(el).not.toBeNull();
      return el;
    });
    await waitFor(() => {
      expect(within(table).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });
    await userEvent.click(within(table).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(deleteReservation).toHaveBeenCalledWith('r-1');
    });
    // テーブル削除後も「予約済みスロット」が取り直される = 残存行が消える。
    await waitFor(() => {
      expect(getBookedSlots.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
