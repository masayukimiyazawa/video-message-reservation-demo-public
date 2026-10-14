import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES, changeLanguage } from '../i18n/index.js';

/**
 * 言語切替 UI（タスク 15.2 / 要件 6.1, 6.2）。
 * 選択言語は i18n の languageChanged フックにより localStorage に永続化される。
 */
export default function LanguageSwitcher() {
  const { t, i18n } = useTranslation();

  const labelKey = { en: 'common.english', ja: 'common.japanese' };

  return (
    <div className="language-switcher" role="group" aria-label={t('common.language')}>
      <label htmlFor="language-select" className="language-switcher__label">
        {t('common.language')}
      </label>
      <select
        id="language-select"
        className="language-switcher__select"
        value={i18n.resolvedLanguage || i18n.language}
        onChange={(e) => changeLanguage(e.target.value)}
      >
        {SUPPORTED_LANGUAGES.map((lng) => (
          <option key={lng} value={lng}>
            {t(labelKey[lng] || lng)}
          </option>
        ))}
      </select>
    </div>
  );
}
