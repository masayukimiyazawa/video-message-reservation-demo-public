import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ja from './locales/ja.json';

/**
 * i18n 初期化（タスク 15.2 / 要件 6.1, 6.2）。
 * 対応言語は en / ja のみ。選択言語は localStorage に永続化する。
 */
export const SUPPORTED_LANGUAGES = ['en', 'ja'];
export const DEFAULT_LANGUAGE = 'en';
const LANGUAGE_STORAGE_KEY = 'vvr.language';

/**
 * 永続化済みの言語を取得する。未設定・不正な場合は既定言語。
 * @returns {string}
 */
export function getPersistedLanguage() {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored && SUPPORTED_LANGUAGES.includes(stored)) {
      return stored;
    }
  } catch {
    /* localStorage 不可環境では既定言語 */
  }
  return DEFAULT_LANGUAGE;
}

/**
 * 選択言語を保存する。
 * @param {string} lng
 */
export function persistLanguage(lng) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
  } catch {
    /* localStorage 不可環境では何もしない */
  }
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ja: { translation: ja },
  },
  lng: getPersistedLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: SUPPORTED_LANGUAGES,
  interpolation: { escapeValue: false },
});

// 言語変更時に選択を永続化する（言語切替 UI と連動）。
i18n.on('languageChanged', (lng) => {
  persistLanguage(lng);
});

/**
 * 対応言語のみを許可して言語を切り替えるヘルパー。
 * @param {string} lng
 */
export function changeLanguage(lng) {
  if (SUPPORTED_LANGUAGES.includes(lng)) {
    return i18n.changeLanguage(lng);
  }
  return Promise.resolve();
}

export default i18n;
