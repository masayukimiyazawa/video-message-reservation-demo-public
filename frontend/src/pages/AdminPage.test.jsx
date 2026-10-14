import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import i18n, { changeLanguage } from '../i18n/index.js';

/**
 * AdminPage の統合テスト（要件 5.2・5.3・7.1・7.3・7.5）。
 *
 * 実害の不具合:
 *   - user がハードコードされた administrator で、staff にも全メニューが出ていた。
 *   - RecordingPanel / TranscriptionPanel に誤った props（user）を渡しており、
 *     録画開始/停止ハンドラが undefined で実行時エラーになっていた。
 *   - recording:status を購読しておらず録画状態が反映されなかった。
 *
 * 検証の要点:
 *   - staff トークンでは録画/文字起こしメニューが表示されない
 *   - administrator では録画パネルから録画開始/停止 API を呼べる
 */

// Socket.IO クライアントをモックし実接続しない。購読ヘルパは no-op を返す。
const socketMocks = vi.hoisted(() => ({ handlers: {} }));
vi.mock('../api/socket.js', () => {
  const subscribe = (event) => (handler) => {
    socketMocks.handlers[event] = handler;
    return () => {
      delete socketMocks.handlers[event];
    };
  };
  const client = {
    socket: {},
    connect: vi.fn(),
    disconnect: vi.fn(),
    onReservationDue: subscribe('reservation:due'),
    onTenMinReminder: subscribe('reservation:tenMinReminder'),
    onManualJoinLink: subscribe('reservation:manualJoinLink'),
    onRecordingStatus: subscribe('recording:status'),
  };
  return { default: () => client, SOCKET_EVENTS: {} };
});

// REST クライアントを部分モックし、ネットワークへ出ないようにする。
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal();
  const api = {
    listReservations: vi.fn().mockResolvedValue({ reservations: [] }),
    getAvailableSlots: vi.fn().mockResolvedValue({ slots: [] }),
    getBookedSlots: vi.fn().mockResolvedValue({ slots: [] }),
    getReservationArchives: vi.fn().mockResolvedValue({ archives: [] }),
    getReservationTranscriptions: vi.fn().mockResolvedValue({ transcriptions: [] }),
    getArchives: vi.fn().mockResolvedValue({ archives: [] }),
    getTranscriptions: vi.fn().mockResolvedValue({ transcriptions: [] }),
    getTranscription: vi.fn().mockResolvedValue({ transcript: [] }),
    startRecording: vi.fn().mockResolvedValue({ archive: { id: 'arch-1' } }),
    stopRecording: vi.fn().mockResolvedValue({ ok: true }),
  };
  return { ...actual, api, default: { ...actual.default, api } };
});

import AdminPage from './AdminPage.jsx';
import { api, setAuthToken, clearAuthToken } from '../api/client.js';

/** 3 セグメントの JWT（署名は検証されない。ペイロードを base64 で載せるだけ）。 */
function makeToken(role, userId = 'u-1') {
  const payload = btoa(JSON.stringify({ userId, role }));
  return `header.${payload}.signature`;
}

function renderAdminPage() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <I18nextProvider i18n={i18n}>
        <AdminPage />
      </I18nextProvider>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await changeLanguage('en');
  vi.clearAllMocks();
});

afterEach(() => {
  clearAuthToken();
  vi.restoreAllMocks();
});

describe('AdminPage: ロール別メニュー (要件 5.2・5.3)', () => {
  it('staff では録画・文字起こしメニューが表示されない', async () => {
    setAuthToken(makeToken('staff'));
    renderAdminPage();

    expect(await screen.findByRole('button', { name: 'Reservations' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recording' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transcription' })).not.toBeInTheDocument();
  });

  it('administrator では録画・文字起こしメニューが表示される', async () => {
    setAuthToken(makeToken('administrator'));
    renderAdminPage();

    expect(await screen.findByRole('button', { name: 'Recording' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transcription' })).toBeInTheDocument();
  });
});

describe('AdminPage: 録画操作の配線 (要件 7.1・7.3)', () => {
  it('録画パネルから録画を開始し、その後停止できる', async () => {
    setAuthToken(makeToken('administrator'));
    const user = userEvent.setup();
    renderAdminPage();

    await user.click(await screen.findByRole('button', { name: 'Recording' }));

    // セッション ID を入力して開始する。
    const sessionInput = await screen.findByLabelText('Session ID');
    await user.type(sessionInput, 'sess-1');
    await user.click(screen.getByRole('button', { name: 'Start recording' }));

    await waitFor(() => {
      expect(api.startRecording).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        withTranscription: true,
      });
    });

    // startRecording 成功 → recordingStatus が started になり停止ボタンが有効化される。
    const stopButton = await screen.findByRole('button', { name: 'Stop recording' });
    await waitFor(() => {
      expect(stopButton).toBeEnabled();
    });
    await user.click(stopButton);

    await waitFor(() => {
      expect(api.stopRecording).toHaveBeenCalledWith('arch-1');
    });
  });

  it('録画一覧の「文字起こしを見る」で文字起こしタブへ遷移し archiveId を引き継ぐ', async () => {
    setAuthToken(makeToken('administrator'));
    const user = userEvent.setup();
    api.getArchives.mockResolvedValue({
      archives: [
        {
          id: 'arch-1',
          createdAt: '2026-01-01T10:00:00.000Z',
          duration: 60000,
          status: 'available',
          url: 'https://example.com/arch-1.mp4',
        },
      ],
    });
    renderAdminPage();

    // 録画タブへ移動し、利用可能な録画の「文字起こしを見る」をクリックする。
    await user.click(await screen.findByRole('button', { name: 'Recording' }));
    const viewButton = await screen.findByRole('button', { name: 'View Transcription' });
    await user.click(viewButton);

    // 文字起こしタブへ切り替わり、archiveId が引き継がれている。
    const archiveInput = await screen.findByLabelText('Archive ID');
    expect(archiveInput).toHaveValue('arch-1');

    // 取得すると引き継いだ archiveId で API が呼ばれる。
    await user.click(screen.getByRole('button', { name: 'Fetch transcription' }));
    await waitFor(() => {
      expect(api.getTranscription).toHaveBeenCalledWith('arch-1');
    });
  });
});
