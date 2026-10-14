import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import i18n, { changeLanguage } from '../../i18n/index.js';
import NotificationsPanel from './NotificationsPanel.jsx';
import RecordingPanel from './RecordingPanel.jsx';
import TranscriptionPanel from './TranscriptionPanel.jsx';
import ReservationsPanel from './ReservationsPanel.jsx';
import { api, ApiError } from '../../api/client.js';
import { MemoryRouter } from 'react-router-dom';

/**
 * タスク 17.3 / 要件 3.3, 7.5, 8.4: Admin_UI の
 * 通知・録画・文字起こし表示のユニットテスト。
 * 各パネルを props で直接描画し、ソケットや実 API を必要とせず検証する。
 */

function renderWithI18n(ui) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

beforeEach(async () => {
  await changeLanguage('en');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NotificationsPanel (要件 3.3)', () => {
  it('reservation:due 通知を画面内通知として一覧表示する', () => {
    const notifications = [
      {
        id: 'n1',
        reservationId: 'r1',
        contact: '+15550001111',
        reservationTime: '2025-01-01T10:00:00.000Z',
        service: 'Consultation',
        language: 'en',
        receivedAt: Date.now(),
      },
    ];
    renderWithI18n(
      <NotificationsPanel
        notifications={notifications}
        onDismiss={() => {}}
        onClear={() => {}}
      />,
    );

    // 通知タイトル（reservation:due に対応）が表示される。
    expect(screen.getByText('Reservation time reached')).toBeInTheDocument();
    // 予約のメタ情報（サービス・連絡先）が表示される。
    expect(screen.getByText(/Consultation/)).toBeInTheDocument();
    expect(screen.getByText(/Contact: \+15550001111/)).toBeInTheDocument();
  });

  it('通知がない場合は空メッセージを表示する', () => {
    renderWithI18n(
      <NotificationsPanel notifications={[]} onDismiss={() => {}} onClear={() => {}} />,
    );
    expect(screen.getByText('No notifications yet.')).toBeInTheDocument();
  });

  it('個別破棄と全消去のハンドラが呼ばれる', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const onClear = vi.fn();
    renderWithI18n(
      <NotificationsPanel
        notifications={[{ id: 'n1', service: 'S', receivedAt: 1 }]}
        onDismiss={onDismiss}
        onClear={onClear}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismiss).toHaveBeenCalledWith('n1');
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClear).toHaveBeenCalled();
  });
});

describe('RecordingPanel (要件 7.5)', () => {
  it('録画状態（recording:status）を状態バッジに反映する', () => {
    renderWithI18n(
      <RecordingPanel
        recordingStatus={{ status: 'started', archiveId: 'arch-1' }}
        onStart={() => {}}
        onStop={() => {}}
      />,
    );
    const badge = screen.getByRole('status');
    expect(badge).toHaveTextContent('Recording');
    // 録画中はアーカイブ ID が表示される。
    expect(screen.getByText('arch-1')).toBeInTheDocument();
  });

  it('録画失敗状態ではエラーメッセージを表示する', () => {
    renderWithI18n(
      <RecordingPanel
        recordingStatus={{ status: 'start_failed', error: 'Vonage rejected' }}
        onStart={() => {}}
        onStop={() => {}}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Failed to start');
    expect(screen.getByRole('alert')).toHaveTextContent('Vonage rejected');
  });

  it('idle 状態では停止ボタンが無効', () => {
    renderWithI18n(
      <RecordingPanel recordingStatus={{ status: 'idle' }} onStart={() => {}} onStop={() => {}} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Not recording');
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeDisabled();
  });
});

describe('TranscriptionPanel (要件 8.4)', () => {
  it('話者（channel / streamId）単位に区別された文字起こしを表示する', async () => {
    const user = userEvent.setup();
    const transcript = [
      {
        channel: 0,
        streamId: 'stream-A',
        speakerLabel: 'Doctor',
        segments: [
          { start: 0, end: 3, text: 'Hello, how are you feeling today?' },
        ],
      },
      {
        channel: 1,
        streamId: 'stream-B',
        speakerLabel: 'Patient',
        segments: [{ start: 4, end: 6, text: 'A little tired, thank you.' }],
      },
    ];
    const spy = vi
      .spyOn(api, 'getTranscription')
      .mockResolvedValue({ transcript });

    renderWithI18n(<TranscriptionPanel defaultArchiveId="arch-1" />);

    await user.click(screen.getByRole('button', { name: 'Fetch transcription' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('arch-1');
    });

    // 話者ラベルが話者単位で表示される。
    const doctor = screen.getByText('Doctor');
    const patient = screen.getByText('Patient');
    expect(doctor).toBeInTheDocument();
    expect(patient).toBeInTheDocument();

    // 各話者の発話が正しい話者ブロックに紐づく。
    const doctorArticle = doctor.closest('article');
    expect(within(doctorArticle).getByText('Hello, how are you feeling today?')).toBeInTheDocument();
    expect(within(doctorArticle).getByText(/stream-A/)).toBeInTheDocument();

    const patientArticle = patient.closest('article');
    expect(within(patientArticle).getByText('A little tired, thank you.')).toBeInTheDocument();
    expect(within(patientArticle).getByText(/stream-B/)).toBeInTheDocument();
  });

  it('文字起こしが空の場合は空メッセージを表示する', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getTranscription').mockResolvedValue({ transcript: [] });
    renderWithI18n(<TranscriptionPanel defaultArchiveId="arch-1" />);
    await user.click(screen.getByRole('button', { name: 'Fetch transcription' }));
    await waitFor(() => {
      expect(screen.getByText('No transcription available.')).toBeInTheDocument();
    });
  });

  it('文字起こし取得失敗時にエラーメッセージを表示する', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getTranscription').mockRejectedValue(new ApiError('not found', { status: 404 }));
    renderWithI18n(<TranscriptionPanel defaultArchiveId="arch-1" />);
    await user.click(screen.getByRole('button', { name: 'Fetch transcription' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch transcription');
    });
  });

  it('文字起こし一覧からアーカイブを選択して表示できる', async () => {
    const user = userEvent.setup();
    const transcript = [
      { channel: 0, streamId: 'stream-A', speakerLabel: 'Doctor', segments: [{ start: 0, end: 3, text: 'Hello' }] },
    ];
    vi.spyOn(api, 'getTranscription').mockResolvedValue({ transcript });
    vi.spyOn(api, 'getTranscriptions').mockResolvedValue({
      transcriptions: [
        { id: 'arch-1', createdAt: '2026-01-01T10:00:00.000Z', duration: 60000, hasTranscription: true },
        { id: 'arch-2', createdAt: '2026-01-02T10:00:00.000Z', duration: 120000, hasTranscription: false },
      ],
    });

    renderWithI18n(<TranscriptionPanel defaultArchiveId="arch-1" />);

    // 一覧の「表示」ボタンをクリックして arch-1 の文字起こしを取得。
    const refreshButton = screen.getByRole('button', { name: 'Loading...' });
    await waitFor(() => {
      expect(refreshButton).not.toBeDisabled();
    });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    // View ボタンが表示されるまで待つ。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    });
    const viewButton = screen.getByRole('button', { name: 'View' });
    await user.click(viewButton);

    await waitFor(() => {
      expect(api.getTranscription).toHaveBeenCalledWith('arch-1');
    });
    expect(screen.getByText('Doctor')).toBeInTheDocument();
  });

  it('一覧で選んだ行のIDで取得する（既定値と異なるIDの回帰）', async () => {
    const user = userEvent.setup();
    const transcript = [
      { channel: 0, streamId: 'stream-A', speakerLabel: 'Doctor', segments: [{ start: 0, end: 3, text: 'Hello' }] },
    ];
    const spy = vi.spyOn(api, 'getTranscription').mockResolvedValue({ transcript });
    vi.spyOn(api, 'getTranscriptions').mockResolvedValue({
      transcriptions: [
        { id: 'arch-xyz', createdAt: '2026-01-02T10:00:00.000Z', duration: 120000, hasTranscription: true },
      ],
    });

    // 既定値（arch-default）とは異なる行を選んでも、その行のIDで取得すること。
    // （setArchiveId 直後の handleFetch が古い state を参照する不具合の回帰）
    renderWithI18n(<TranscriptionPanel defaultArchiveId="arch-default" />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'View' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('arch-xyz');
    });
  });
});

/**
 * RecordingPanel の追加テスト（要件 7.5）
 */
describe('RecordingPanel 追加テスト (要件 7.5)', () => {
  it('録画一覧を取得して表示する', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getArchives').mockResolvedValue({
      archives: [
        { id: 'arch-1', createdAt: '2026-01-01T10:00:00.000Z', duration: 60000, status: 'available', url: 'https://example.com/arch-1.mp4' },
        { id: 'arch-2', createdAt: '2026-01-02T10:00:00.000Z', duration: 120000, status: 'available', url: 'https://example.com/arch-2.mp4' },
      ],
    });

    renderWithI18n(
      <RecordingPanel recordingStatus={{ status: 'idle' }} onStart={() => {}} onStop={() => {}} />,
    );

    // 初期ロード完了を待つ（Loading... → Refresh になる）。
    const refreshButton = screen.getByRole('button', { name: 'Loading...' });
    await waitFor(() => {
      expect(refreshButton).not.toBeDisabled();
    });
    // Refresh ボタン（再読み込み）をクリック。
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(api.getArchives).toHaveBeenCalled();
    });
    expect(screen.getByText('arch-1')).toBeInTheDocument();
    expect(screen.getByText('arch-2')).toBeInTheDocument();
    // 複数のダウンロードリンク（録画ファイル・文字起こしファイル）があるので getAllByRole を使う。
    expect(screen.getAllByRole('link', { name: /Recording File|Transcription File/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('録画一覧取得失敗時にエラーメッセージを表示する', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getArchives').mockRejectedValue(new ApiError('server error', { status: 500 }));

    renderWithI18n(
      <RecordingPanel recordingStatus={{ status: 'idle' }} onStart={() => {}} onStop={() => {}} />,
    );

    // 初期ロード完了を待つ。
    const refreshButton = screen.getByRole('button', { name: 'Loading...' });
    await waitFor(() => {
      expect(refreshButton).not.toBeDisabled();
    });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    // エラーメッセージは form-error クラスで表示される。
    await waitFor(() => {
      expect(screen.getByText('Failed to load recordings')).toBeInTheDocument();
    });
  });

  it('利用可能な録画に対して「文字起こしを見る」ボタンが表示される', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getArchives').mockResolvedValue({
      archives: [
        { id: 'arch-1', createdAt: '2026-01-01T10:00:00.000Z', duration: 60000, status: 'available', url: 'https://example.com/arch-1.mp4' },
      ],
    });

    renderWithI18n(
      <RecordingPanel recordingStatus={{ status: 'idle' }} onStart={() => {}} onStop={() => {}} />,
    );

    // 初期ロード完了を待つ。
    const refreshButton = screen.getByRole('button', { name: 'Loading...' });
    await waitFor(() => {
      expect(refreshButton).not.toBeDisabled();
    });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    // ボタン名は "View Transcription"（大文字 T）。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'View Transcription' })).toBeInTheDocument();
    });
  });

  it('「文字起こしを見る」で onViewTranscription(archiveId) を呼ぶ（window.open しない）', async () => {
    const user = userEvent.setup();
    const onViewTranscription = vi.fn();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.spyOn(api, 'getArchives').mockResolvedValue({
      archives: [
        { id: 'arch-1', createdAt: '2026-01-01T10:00:00.000Z', duration: 60000, status: 'available', url: 'https://example.com/arch-1.mp4' },
      ],
    });

    renderWithI18n(
      <RecordingPanel
        recordingStatus={{ status: 'idle' }}
        onStart={() => {}}
        onStop={() => {}}
        onViewTranscription={onViewTranscription}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'View Transcription' })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'View Transcription' }));

    // 管理画面内の文字起こしタブへ遷移させる（存在しない /transcriptions/:id を開かない）。
    expect(onViewTranscription).toHaveBeenCalledWith('arch-1');
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});

/**
 * TranscriptionPanel の文字起こし一覧ダウンロード表示テスト（要件 8.4・8.5）
 */
describe('TranscriptionPanel: 一覧のダウンロードリンク (要件 8.4・8.5)', () => {
  it('一覧の downloadUrl からダウンロードリンクを表示する', async () => {
    vi.spyOn(api, 'getTranscriptions').mockResolvedValue({
      transcriptions: [
        {
          id: 'arch-1',
          createdAt: '2026-01-01T10:00:00.000Z',
          duration: 60000,
          hasTranscription: true,
          downloadUrl: 'https://example.com/trans-1.zip',
        },
      ],
    });

    renderWithI18n(<TranscriptionPanel />);

    // バックエンドが正規化した downloadUrl からダウンロードリンクが出ること。
    // （transcription.url が無くてもボタンが表示される）
    const link = await screen.findByRole('link', { name: /Transcription File/i });
    expect(link).toHaveAttribute('href', 'https://example.com/trans-1.zip');
  });
});

/**
 * ReservationsPanel の録画・文字起こし表示テスト（要件 2.4・7.4・8.5）
 */
describe('ReservationsPanel: 録画・文字起こし表示 (要件 2.4・7.4・8.5)', () => {
  function renderPanel() {
    return render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <ReservationsPanel user={{ userId: 'u-1', role: 'administrator' }} onSelect={() => {}} />
        </I18nextProvider>
      </MemoryRouter>,
    );
  }

  function stubBaseApis() {
    vi.spyOn(api, 'getAvailableSlots').mockResolvedValue({ slots: [] });
    vi.spyOn(api, 'getBookedSlots').mockResolvedValue({ slots: [] });
    vi.spyOn(api, 'createReservation').mockResolvedValue({ reservation: { reservationId: 'r-new' } });
    vi.spyOn(api, 'getReservationArchives').mockResolvedValue({ archives: [] });
    vi.spyOn(api, 'getReservationTranscriptions').mockResolvedValue({ transcriptions: [] });
  }

  it('予約一覧テーブルに録画・文字起こし列が表示され、データがある場合はダウンロードリンクが出る', async () => {
    const user = userEvent.setup();
    stubBaseApis();
    vi.spyOn(api, 'listReservations').mockResolvedValue({
      reservations: [
        {
          reservationId: 'r-1',
          contact: '819012345678',
          service: 'telemedicine',
          status: 'completed',
          language: 'ja',
          reservationTime: '2026-10-05T05:00:00.000Z',
          sessionId: 'sess-1',
        },
      ],
    });
    vi.spyOn(api, 'getReservationArchives').mockResolvedValue({
      archives: [
        { archiveId: 'arch-1', name: 'recording-1.mp4', downloadUrl: 'https://example.com/arch-1.mp4', duration: 3600, createdAt: '2026-10-05T06:00:00.000Z' },
      ],
    });
    vi.spyOn(api, 'getReservationTranscriptions').mockResolvedValue({
      transcriptions: [
        { transcriptionId: 'trans-1', name: 'transcription-1.json', downloadUrl: 'https://example.com/trans-1.json', language: 'ja', createdAt: '2026-10-05T07:00:00.000Z' },
      ],
    });

    const { container } = renderPanel();

    // 予約一覧テーブルが描画されるまで待つ。
    const table = await waitFor(() => {
      const el = container.querySelector('.reservation-table-wrap');
      expect(el).not.toBeNull();
      return el;
    });

    // 録画ダウンロードリンクが表示される。
    await waitFor(() => {
      expect(within(table).getByRole('link', { name: /Download Recording/i })).toBeInTheDocument();
    });

    // 文字起こしダウンロードリンクも表示される。
    await waitFor(() => {
      expect(within(table).getByRole('link', { name: /Download Transcription/i })).toBeInTheDocument();
    });

    // 録画メタ情報（duration, createdAt）が表示される。
    expect(screen.getByText(/3600s/)).toBeInTheDocument();
    // 文字起こしメタ情報（language, createdAt）が表示される。
    expect(screen.getByText(/ja/)).toBeInTheDocument();
  });

  it('録画・文字起こしがない場合は空表示になる', async () => {
    stubBaseApis();
    vi.spyOn(api, 'listReservations').mockResolvedValue({
      reservations: [
        {
          reservationId: 'r-1',
          contact: '819012345678',
          service: 'telemedicine',
          status: 'completed',
          language: 'ja',
          reservationTime: '2026-10-05T05:00:00.000Z',
          sessionId: 'sess-1',
        },
      ],
    });
    // archives/transcriptions は空配列（stubBaseApis で設定済み）。

    const { container } = renderPanel();

    const table = await waitFor(() => {
      const el = container.querySelector('.reservation-table-wrap');
      expect(el).not.toBeNull();
      return el;
    });

    // 録画・文字起こし列は空（リンクなし）。
    expect(within(table).queryByRole('link', { name: /Recording File/i })).not.toBeInTheDocument();
    expect(within(table).queryByRole('link', { name: /Transcription File/i })).not.toBeInTheDocument();
  });

  it('録画・文字起こし取得APIが失敗してもクラッシュせず空表示になる', async () => {
    stubBaseApis();
    vi.spyOn(api, 'listReservations').mockResolvedValue({
      reservations: [
        {
          reservationId: 'r-1',
          contact: '819012345678',
          service: 'telemedicine',
          status: 'completed',
          language: 'ja',
          reservationTime: '2026-10-05T05:00:00.000Z',
          sessionId: 'sess-1',
        },
      ],
    });
    vi.spyOn(api, 'getReservationArchives').mockRejectedValue(new Error('network error'));
    vi.spyOn(api, 'getReservationTranscriptions').mockRejectedValue(new Error('network error'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = renderPanel();

    const table = await waitFor(() => {
      const el = container.querySelector('.reservation-table-wrap');
      expect(el).not.toBeNull();
      return el;
    });

    // エラーがあってもクラッシュせず、列は空表示。
    expect(within(table).queryByRole('link', { name: /Recording File/i })).not.toBeInTheDocument();
    expect(within(table).queryByRole('link', { name: /Transcription File/i })).not.toBeInTheDocument();

    errorSpy.mockRestore();
  });
});

/**
 * 管理画面の自動更新テスト（GAP 1: Refresh 不要化）
 *
 * Vonage 側でアーカイブが available になるまで DL リンクが出ないため、
 * 未完了アイテムが残る間だけ裏で再取得し、Refresh を押さなくても
 * リンクが現れることを（フェイクタイマーで）検証する。
 */
describe('管理画面の自動更新 (GAP 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('未完了の録画を自動更新して DL リンクを表示する（Refresh 不要）', async () => {
    const spy = vi
      .spyOn(api, 'getArchives')
      .mockResolvedValueOnce({
        archives: [
          { id: 'arch-1', status: 'processing', createdAt: '2026-01-01T10:00:00.000Z' },
        ],
      })
      .mockResolvedValue({
        archives: [
          { id: 'arch-1', status: 'available', url: 'https://example.com/arch-1.mp4' },
        ],
      });

    renderWithI18n(
      <RecordingPanel recordingStatus={{ status: 'idle' }} onStart={() => {}} onStop={() => {}} />,
    );

    // 初期ロード（未完了アイテム）を反映する。
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: /Download/i })).not.toBeInTheDocument();

    // ポーリング間隔を進めると、Refresh を押さなくても再取得されて DL リンクが出る。
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link', { name: /Recording File/i })).toHaveAttribute(
      'href',
      'https://example.com/arch-1.mp4',
    );
  });

  it('全件 available なら自動更新しない（無駄なポーリングなし）', async () => {
    const spy = vi.spyOn(api, 'getArchives').mockResolvedValue({
      archives: [
        { id: 'arch-1', status: 'available', url: 'https://example.com/arch-1.mp4' },
      ],
    });

    renderWithI18n(
      <RecordingPanel recordingStatus={{ status: 'idle' }} onStart={() => {}} onStop={() => {}} />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('未完了の文字起こしを自動更新して DL リンクを表示する（Refresh 不要）', async () => {
    const spy = vi
      .spyOn(api, 'getTranscriptions')
      .mockResolvedValueOnce({
        transcriptions: [
          { id: 'arch-1', createdAt: '2026-01-01T10:00:00.000Z', duration: 60000, hasTranscription: false },
        ],
      })
      .mockResolvedValue({
        transcriptions: [
          {
            id: 'arch-1',
            createdAt: '2026-01-01T10:00:00.000Z',
            duration: 60000,
            hasTranscription: true,
            downloadUrl: 'https://example.com/trans-1.zip',
          },
        ],
      });

    renderWithI18n(<TranscriptionPanel />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: /Transcription File/i })).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link', { name: /Transcription File/i })).toHaveAttribute(
      'href',
      'https://example.com/trans-1.zip',
    );
  });

  it('予約一覧の未完了録画を自動更新して DL リンクを表示する（Refresh 不要）', async () => {
    const flush = async (times = 8) => {
      for (let i = 0; i < times; i += 1) {
        // 非同期ローダーの連鎖（list → Promise.all(media)）を確実に流す。
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await Promise.resolve();
        });
      }
    };

    vi.spyOn(api, 'getAvailableSlots').mockResolvedValue({ slots: [] });
    vi.spyOn(api, 'getBookedSlots').mockResolvedValue({ slots: [] });
    vi.spyOn(api, 'listReservations').mockResolvedValue({
      reservations: [
        {
          reservationId: 'r-1',
          contact: '819012345678',
          service: 'telemedicine',
          status: 'completed',
          language: 'ja',
          reservationTime: '2026-10-05T05:00:00.000Z',
          sessionId: 'sess-1',
        },
      ],
    });
    const archiveSpy = vi
      .spyOn(api, 'getReservationArchives')
      // 初期は downloadUrl 未発行（Vonage 処理中）。
      .mockResolvedValueOnce({ archives: [{ archiveId: 'arch-1', name: 'recording-1.mp4' }] })
      .mockResolvedValue({
        archives: [
          {
            archiveId: 'arch-1',
            name: 'recording-1.mp4',
            downloadUrl: 'https://example.com/arch-1.mp4',
          },
        ],
      });
    vi.spyOn(api, 'getReservationTranscriptions').mockResolvedValue({ transcriptions: [] });

    render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <ReservationsPanel user={{ userId: 'u-1', role: 'administrator' }} onSelect={() => {}} />
        </I18nextProvider>
      </MemoryRouter>,
    );

    await flush();
    expect(archiveSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: /Download Recording/i })).not.toBeInTheDocument();

    // ポーリング間隔を進めると裏で再取得され、DL リンクが出る。
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await flush();

    expect(archiveSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link', { name: /Download Recording/i })).toHaveAttribute(
      'href',
      'https://example.com/arch-1.mp4',
    );
  });
});

/**
 * 録画・文字起こし一覧の「削除」ボタンは、Vonage 側で available に
 * なっているアーカイブのみ有効化する（期限切れ・処理中は 409 になるため）。
 */
describe('録画・文字起こし一覧の削除ボタン活性制御', () => {
  it('RecordingPanel: available は有効、expired は無効', async () => {
    vi.spyOn(api, 'getArchives').mockResolvedValue({
      archives: [
        { id: 'a-ok', createdAt: '2026-01-01T10:00:00.000Z', duration: 60000, status: 'available', url: 'https://e/a-ok.mp4' },
        { id: 'a-exp', createdAt: '2026-01-02T10:00:00.000Z', duration: 120000, status: 'expired' },
      ],
    });

    renderWithI18n(
      <RecordingPanel recordingStatus={{ status: 'idle' }} onStart={() => {}} onStop={() => {}} />,
    );

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    });
    const buttons = screen.getAllByRole('button', { name: 'Delete' });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
  });

  it('TranscriptionPanel: available は有効、expired は無効', async () => {
    vi.spyOn(api, 'getTranscriptions').mockResolvedValue({
      transcriptions: [
        { id: 't-ok', createdAt: '2026-01-01T10:00:00.000Z', duration: 60000, status: 'available', hasTranscription: true },
        { id: 't-exp', createdAt: '2026-01-02T10:00:00.000Z', duration: 120000, status: 'expired', hasTranscription: true },
      ],
    });

    renderWithI18n(<TranscriptionPanel />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    });
    const buttons = screen.getAllByRole('button', { name: 'Delete' });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
  });
});
