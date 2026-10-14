import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import Layout from './components/Layout.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import HomePage from './pages/HomePage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import CallPage from './pages/CallPage.jsx';
import JoinPage from './pages/JoinPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import { setUnauthorizedHandler, clearAuthToken } from './api/client.js';

/** 内部用: Router の中で useNavigate を使って 401 ハンドラを登録するコンポーネント。 */
function UnauthorizedHandlerSetup() {
  const navigate = useNavigate();
  useEffect(() => {
    const cleanup = setUnauthorizedHandler((path) => {
      clearAuthToken();
      navigate(path, { replace: true });
    });
    return cleanup;
  }, [navigate]);
  return null;
}

/**
 * アプリのルートコンポーネント（タスク 15.1）。
 * React Router によるルーティングと共通レイアウトを確立する。
 * /admin・/call/:sessionId は後続タスク 16/17 で中身を実装するプレースホルダ。
 */
export default function App() {
  return (
    <BrowserRouter>
      <UnauthorizedHandlerSetup />
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="login" element={<LoginPage />} />
          {/* /admin は認証ガードで保護する（要件 5.1）。 */}
          <Route
            path="admin"
            element={
              <RequireAuth>
                <AdminPage />
              </RequireAuth>
            }
          />
          <Route path="call/:sessionId" element={<CallPage />} />
          {/* セッション ID なしの /call は管理ダッシュボードへ誘導 */}
          <Route path="call" element={<Navigate to="/admin" replace />} />
          {/* WhatsApp 入室リンク（一度だけ有効なトークンを消費して /call へ遷移） */}
          <Route path="join/:tokenId" element={<JoinPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
