import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider, useTranslation } from 'react-i18next';
import i18n, { changeLanguage } from './index.js';
import LanguageSwitcher from '../components/LanguageSwitcher.jsx';

/**
 * タスク 15.3 / 要件 6.1, 6.2: i18n 切替のユニットテスト。
 * en/ja の言語切替が Admin_UI / Video_Call_UI 相当のコンポーネント表示へ
 * 反映されることを、i18n モジュール + LanguageSwitcher を用いて検証する。
 */

// Admin_UI 相当: 管理ダッシュボードのタイトルを表示する簡易コンポーネント。
function AdminSample() {
  const { t } = useTranslation();
  return <h1>{t('admin.title')}</h1>;
}

// Video_Call_UI 相当: ビデオ通話タイトルを表示する簡易コンポーネント。
function CallSample() {
  const { t } = useTranslation();
  return <h1>{t('call.title')}</h1>;
}

function renderWithI18n(ui) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe('i18n 言語切替 (要件 6.1, 6.2)', () => {
  beforeEach(async () => {
    await act(async () => {
      await changeLanguage('en');
    });
  });

  afterEach(async () => {
    await act(async () => {
      await changeLanguage('en');
    });
  });

  it('既定は英語で Admin_UI / Video_Call_UI テキストが英語表示される', () => {
    renderWithI18n(
      <>
        <AdminSample />
        <CallSample />
      </>,
    );
    expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Video Call')).toBeInTheDocument();
  });

  it('日本語へ切り替えると Admin_UI / Video_Call_UI テキストが日本語になる', async () => {
    renderWithI18n(
      <>
        <AdminSample />
        <CallSample />
      </>,
    );
    // 初期は英語。
    expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();

    await act(async () => {
      await changeLanguage('ja');
    });

    expect(screen.getByText('管理ダッシュボード')).toBeInTheDocument();
    expect(screen.getByText('ビデオ通話')).toBeInTheDocument();
    // 英語表記はもう存在しない。
    expect(screen.queryByText('Admin Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Video Call')).not.toBeInTheDocument();
  });

  it('LanguageSwitcher の選択で言語が切り替わり表示へ反映される', async () => {
    const user = userEvent.setup();
    renderWithI18n(
      <>
        <LanguageSwitcher />
        <AdminSample />
      </>,
    );

    // 英語ではセレクトのラベル/グループラベルが "Language"。
    const select = screen.getByRole('combobox', { name: 'Language' });
    expect(select).toBeInTheDocument();
    expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();

    // 日本語（value=ja）を選択する。
    await user.selectOptions(select, 'ja');

    // Admin_UI テキストが日本語へ。
    expect(screen.getByText('管理ダッシュボード')).toBeInTheDocument();
    // スイッチャ自身のラベルも日本語（"言語"）へ切り替わる。
    expect(screen.getByRole('combobox', { name: '言語' })).toBeInTheDocument();
  });

  it('スイッチャのオプションが現在言語のラベルで表示される', async () => {
    renderWithI18n(<LanguageSwitcher />);
    const group = screen.getByRole('group');
    // 英語表示ではオプションは English / Japanese。
    expect(within(group).getByRole('option', { name: 'English' })).toBeInTheDocument();
    expect(within(group).getByRole('option', { name: 'Japanese' })).toBeInTheDocument();

    await act(async () => {
      await changeLanguage('ja');
    });
    // 日本語表示では 英語 / 日本語。
    expect(within(group).getByRole('option', { name: '英語' })).toBeInTheDocument();
    expect(within(group).getByRole('option', { name: '日本語' })).toBeInTheDocument();
  });
});
