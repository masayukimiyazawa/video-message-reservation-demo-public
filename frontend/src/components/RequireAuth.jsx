import { Navigate, useLocation } from 'react-router-dom';
import { isAuthenticated } from '../api/auth.js';

/**
 * 認証ガード（タスク 17.1 / 要件 5.1）。
 * 未認証の場合は /login へリダイレクトし、遷移元を state.from に保持する。
 * ログイン成功後に元の画面へ戻せるようにする。
 */
export default function RequireAuth({ children }) {
  const location = useLocation();

  if (!isAuthenticated()) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}
