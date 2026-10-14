import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * ホーム（タスク 15.1 プレースホルダ）。
 */
export default function HomePage() {
  const { t } = useTranslation();
  return (
    <section className="page page--home">
      <h1>{t('app.title')}</h1>
      <ul className="home-links">
        <li>
          <Link to="/admin">{t('nav.admin')}</Link>
        </li>
      </ul>
    </section>
  );
}
