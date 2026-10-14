import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { isAuthenticated } from '../api/auth.js';

/**
 * ログイン画面（タスク 17.1 / 要件 5.1）。
 * api.login を呼び出して JWT を保存し、成功後に元の画面（既定 /admin）へ遷移する。
 * ロールはトークンからデコードされ、AdminPage 側でメニュー表示に用いられる。
 */
export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 認証済みの状態でログイン画面へ来た場合は管理画面へ送る。
  if (isAuthenticated()) {
    return <Navigate to="/admin" replace />;
  }

  // ログイン成功後に戻る遷移先（RequireAuth が保持した from）。既定は /admin。
  const redirectTo = location.state?.from?.pathname || '/admin';

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');

    if (!userId.trim() || !password) {
      setError(t('login.missingFields'));
      return;
    }

    setSubmitting(true);
    try {
      await api.login({ userId: userId.trim(), password });
      navigate(redirectTo, { replace: true });
    } catch (err) {
      // 認証失敗（401）とその他の障害を区別してメッセージを出し分ける。
      if (err instanceof ApiError && err.status === 401) {
        setError(t('login.failed'));
      } else {
        setError(t('login.networkError'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="page page--login">
      <h1>{t('login.title')}</h1>
      <form className="login-form" onSubmit={handleSubmit} aria-label={t('login.title')}>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <label>
          {t('login.userId')}
          <input
            type="text"
            name="userId"
            autoComplete="username"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            disabled={submitting}
            required
          />
        </label>
        <label>
          {t('login.password')}
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            required
          />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? t('common.loading') : t('login.submit')}
        </button>
      </form>
    </section>
  );
}
