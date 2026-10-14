import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import i18n, { changeLanguage } from '../i18n/index.js';

/**
 * JoinPage（WhatsApp 入室リンクの初回消費）のテスト（要件 4.1）。
 *
 * 重要機能の根拠を固定する:
 *  - リンク消費で得た **ゲストトークン一式を sessionStorage に保存**し、
 *    `/call/:sessionId` へ遷移する（CallPage が再取得せずそのトークンを使う）。
 *  - `markGuestJoin` によりゲスト入室として記録する（管理/ログイン導線を隠す）。
 *  - 拒否コードごとに利用者向けメッセージを表示する。
 *
 * REST クライアントは部分モックし、ネットワークへ出ないようにする。
 */

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal();
  const api = {
    redeemJoinToken: vi.fn(),
  };
  return { ...actual, api, default: { ...actual.default, api } };
});

import JoinPage from './JoinPage.jsx';
import { api } from '../api/client.js';
import { GUEST_JOIN_STORAGE_KEY, isGuestJoin } from '../api/guestJoin.js';

/** 遷移先の /call/:sessionId を検出するためのマーカー。 */
function CallMarker() {
  return <div>call-screen</div>;
}

function renderJoinPage(tokenId = 'tok-abc') {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[`/join/${tokenId}`]}>
        <Routes>
          <Route path="/join/:tokenId" element={<JoinPage />} />
          <Route path="/call/:sessionId" element={<CallMarker />} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

/** redeemJoinToken を拒否させる（apiFetch は body を持つエラーを投げる）。 */
function rejectWith(code) {
  const err = new Error('request failed');
  err.body = { error: code };
  return Promise.reject(err);
}

beforeEach(async () => {
  await changeLanguage('en');
  vi.clearAllMocks();
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('JoinPage: WhatsApp 入室リンクの消費 (要件 4.1)', () => {
  it('消費成功時にゲストトークンを保存して /call/:sessionId へ遷移する', async () => {
    api.redeemJoinToken.mockResolvedValue({
      token: 'guest-token-xyz',
      sessionId: 'sess-1',
      applicationId: 'app-1',
      reservationId: 'r1',
    });

    renderJoinPage('tok-abc');

    // トークン ID を指定して消費する。
    await waitFor(() => {
      expect(api.redeemJoinToken).toHaveBeenCalledWith('tok-abc');
    });

    // /call/:sessionId へ遷移する。
    expect(await screen.findByText('call-screen')).toBeInTheDocument();

    // ゲストトークン一式が sessionStorage に保存される（CallPage が使う）。
    const stored = JSON.parse(sessionStorage.getItem('vvr.joinToken'));
    expect(stored).toMatchObject({
      token: 'guest-token-xyz',
      sessionId: 'sess-1',
      applicationId: 'app-1',
      reservationId: 'r1',
    });

    // ゲスト入室として記録される（管理/ログイン導線を隠す）。
    expect(sessionStorage.getItem(GUEST_JOIN_STORAGE_KEY)).toBeTruthy();
    expect(isGuestJoin()).toBe(true);
  });

  it('使用済みリンクは alreadyUsed メッセージを表示する', async () => {
    api.redeemJoinToken.mockImplementation(() => rejectWith('join_token_already_used'));

    renderJoinPage('used');

    expect(
      await screen.findByText(
        'This link has already been used. One-time links cannot be reused.',
      ),
    ).toBeInTheDocument();
    // 遷移しない。
    expect(screen.queryByText('call-screen')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('vvr.joinToken')).toBeNull();
  });

  it('存在しないリンクは notFound メッセージを表示する', async () => {
    api.redeemJoinToken.mockImplementation(() => rejectWith('join_token_not_found'));

    renderJoinPage('missing');

    expect(
      await screen.findByText('This link is invalid or does not exist.'),
    ).toBeInTheDocument();
    expect(sessionStorage.getItem('vvr.joinToken')).toBeNull();
  });

  it('未知のエラーは unknown メッセージを表示する', async () => {
    api.redeemJoinToken.mockImplementation(() => rejectWith('something_else'));

    renderJoinPage('weird');

    expect(
      await screen.findByText('An unexpected error occurred.'),
    ).toBeInTheDocument();
  });
});
