/**
 * Light/dark theme for the app chrome (panels, modals, admin dashboard).
 *
 * The theme lives in data-theme on <html> — set before first paint by the
 * inline script in index.html (localStorage 'sis-theme', falling back to
 * prefers-color-scheme) and flipped here by the sun/moon buttons.
 *
 * Deliberately out of scope: everything that floats directly on the map
 * (glyphs, scale bar, dynamic legend pills) follows the BASEMAP theme via
 * body.light-basemap, not the app theme.
 */
import { t } from './i18n.js';

const ICONS = {
  // shown in light mode — click to go dark
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" stroke-linejoin="round"/>',
  // shown in dark mode — click to go light
  sun: '<circle cx="12" cy="12" r="4"/>'
    + '<path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22'
    + 'M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" stroke-linecap="round"/>',
};

export function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('sis-theme', theme); } catch (e) { /* private mode */ }
  document.querySelectorAll('[data-theme-toggle]').forEach(refreshButton);
}

export function toggleTheme() {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

/** Stamp icon + tooltip onto a toggle button for the current theme. */
export function refreshButton(btn) {
  const dark = currentTheme() === 'dark';
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">'
    + (dark ? ICONS.sun : ICONS.moon) + '</svg>';
  const label = dark ? t('theme.light') : t('theme.dark');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/** Wire an existing button element as a theme toggle. */
export function initThemeButton(btn) {
  btn.setAttribute('data-theme-toggle', '');
  refreshButton(btn);
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleTheme(); });
}
