/**
 * Lightweight i18n for the SIS map view (and, progressively, the admin panel).
 *
 * Resolution order for the active language:
 *   1. the visitor's own choice (localStorage 'sis_lang', set by the selector)
 *   2. the instance default (api.setting LANGUAGE, applied via
 *      setInstanceDefault() once settings are loaded)
 *   3. English
 *
 * t(key, params) falls back key → active locale → English → the key itself,
 * so a missing translation can never break the UI. New languages are one JSON
 * file in src/locales/ plus one entry each in AVAILABLE and LOADERS.
 *
 * English ships with every page: it is the fallback for missing keys and
 * what renders if another locale cannot be fetched. Every other locale is
 * a file of its own, fetched only when it is the active language, so a
 * page must `await setInstanceDefault(...)` (or i18nReady()) before its
 * first t().
 */
import en from '../locales/en.json';

const LOADERS = {
  es: () => import('../locales/es.json'),
  fr: () => import('../locales/fr.json'),
  pt: () => import('../locales/pt.json'),
  ru: () => import('../locales/ru.json'),
  zh: () => import('../locales/zh.json'),
};
const LOCALES = { en };
const pending = {};

export const AVAILABLE = [
  ['en', 'English'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['pt', 'Português'],
  ['ru', 'Русский'],
  ['zh', '中文'],
];

const isKnown = (code) => code === 'en' || Object.prototype.hasOwnProperty.call(LOADERS, code);

function read(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

// The instance default only arrives with the first API response. The value
// seen on the previous visit lets its locale be fetched straight away, in
// parallel with that request, instead of after it.
let instanceDefault = isKnown(read('sis_lang_default')) ? read('sis_lang_default') : 'en';

export function currentLang() {
  const s = read('sis_lang');
  if (s && isKnown(s)) return s;
  return instanceDefault;
}

function load(code) {
  if (LOCALES[code]) return Promise.resolve();
  if (!pending[code]) {
    pending[code] = LOADERS[code]()
      .then((module) => { LOCALES[code] = module.default || module; })
      .catch((error) => {
        // English stays in place; a later call tries the download again.
        console.warn(`Language "${code}" could not be loaded:`, error);
        delete pending[code];
      });
  }
  return pending[code];
}

/** Resolves once the active language's texts are available — immediately
 *  for English. Never rejects: on a failed download the page renders in
 *  English. */
export function i18nReady() {
  return load(currentLang());
}

/** Applies the instance's default language and resolves when the active
 *  language is ready to use. */
export function setInstanceDefault(code) {
  if (code && isKnown(code)) {
    instanceDefault = code;
    try { localStorage.setItem('sis_lang_default', code); } catch (e) { /* private mode */ }
  }
  return i18nReady();
}

export function switchLanguage(code) {
  try { localStorage.setItem('sis_lang', code); } catch (e) { /* private mode */ }
  location.reload();
}

export function t(key, params) {
  const l = currentLang();
  let s = (LOCALES[l] && LOCALES[l][key]) || LOCALES.en[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(`{${k}}`, v);
    }
  }
  return s;
}

// Started at import so the download overlaps the page's first API call.
i18nReady();
