import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * 404（タスク 15.1）。
 */
export default function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <section className="page page--not-found">
      <h1>404</h1>
      <Link to="/">{t('nav.home')}</Link>
    </section>
  );
}
