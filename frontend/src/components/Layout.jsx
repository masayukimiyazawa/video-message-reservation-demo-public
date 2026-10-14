import { Link, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from './LanguageSwitcher.jsx';
import { isGuestJoin } from '../api/guestJoin.js';

/**
 * アプリ共通レイアウト（タスク 15.1）。
 * ヘッダー（ナビ + 言語切替）と本文アウトレットを持つレスポンシブ土台。
 * 詳細なスタイルは後続タスク 16/17 で洗練する。
 *
 * WhatsApp の入室リンクから参加している利用者（ゲスト）の場合、
 * ヘッダー（管理・ログイン等への導線とアプリ名ナビゲーション）ごと隠す。
 * 通話に専念させるため。
 */
export default function Layout() {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  // 管理画面は全幅・左寄せで表示する（センタリングしない）
  const isAdmin = pathname === '/admin' || pathname.startsWith('/admin/');

  // ゲスト入室フラグは JoinPage が遷移直前に書き込むため、
  // 遷移後のレンダリングで反映されるよう state 経由で購読する。
  const [guest, setGuest] = useState(() => isGuestJoin());
  useEffect(() => {
    setGuest(isGuestJoin());
  }, [pathname]);

  if (guest) {
    // ヘッダーなし。通話のみを表示する（入室・通話の専念モード）。
    return (
      <div className="app-shell app-shell--immersive" data-guest="true">
        <main className="app-main app-main--immersive">
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand">
          <Link to="/">{t('app.title')}</Link>
        </div>
        <nav className="app-nav" aria-label="primary">
          <Link to="/admin">{t('nav.admin')}</Link>
        </nav>
        <LanguageSwitcher />
      </header>
      <main className={isAdmin ? 'app-main app-main--admin' : 'app-main'}>
        <Outlet />
      </main>
    </div>
  );
}
