import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import zh from './zh.json';

export const SUPPORTED_LANGS = ['en', 'zh'];
const STORAGE_KEY = 'calib_lang';

// First launch follows the OS locale (zh-* → Chinese, otherwise English);
// once the user picks a language we honour their saved choice.
function initialLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED_LANGS.includes(saved)) return saved;
  } catch { /* localStorage may be unavailable */ }
  const sys = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  return sys.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const lng = initialLang();

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, zh: { translation: zh } },
  lng,
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LANGS,
  interpolation: { escapeValue: false },
});

if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('lang', lng);
}

// Normalize a raw i18next language tag down to one of our supported codes.
export function normalizeLang(raw) {
  return (raw || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function setLang(next) {
  if (!SUPPORTED_LANGS.includes(next)) return;
  i18n.changeLanguage(next);
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', next);
  }
}

export default i18n;
