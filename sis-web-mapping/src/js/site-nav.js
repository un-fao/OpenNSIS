/**
 * Shared header wiring for every page (landing, dashboard, standalone
 * pages and the map): navigation labels from i18n, brand (logo + instance
 * name) and the theme / sign-in / language controls. About/People/Contact
 * stay muted "coming soon" until the published content carries that page,
 * then they become real links.
 */
import { t, AVAILABLE, currentLang, switchLanguage } from './i18n.js';
import { initThemeButton } from './theme.js';

const PAGE_IDS = { about: 'nav-about', people: 'nav-people', contact: 'nav-contact' };

export function applyNav(current, pages) {
  const items = [['nav-home', 'site.nav.home', '/'], ['nav-about', 'site.nav.about', '/about'],
                 ['nav-map', 'site.nav.map', '/map'], ['nav-catalogue', 'site.nav.catalogue', null],
                 ['nav-dashboard', 'site.nav.dashboard', '/dashboard'],
                 ['nav-people', 'site.nav.people', '/people'],
                 ['nav-contact', 'site.nav.contact', '/contact']];
  items.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = t(key);
    if (el.classList.contains('nav-soon')) el.title = t('site.comingSoon');
    if (id === `nav-${current}`) el.classList.add('nav-current');
  });
  Object.entries(PAGE_IDS).forEach(([slug, id]) => {
    const el = document.getElementById(id);
    if (!el || !pages || !pages[slug]) return;
    // Published content exists: the muted placeholder becomes a real link.
    const a = document.createElement('a');
    a.id = el.id;
    a.href = `/${slug}`;
    a.className = el.className.replace('nav-soon', '').trim() + ' nav-link';
    a.textContent = el.textContent;
    if (`nav-${current}` === id) a.classList.add('nav-current');
    el.replaceWith(a);
  });
}

/**
 * Brand area: instance logo + name, same sources as the map page
 * (ORG_LOGO_URL / APP_TITLE settings, surfaced through GET /api/site; a
 * CMS-uploaded logo wins over the setting). Never touches document.title —
 * each page owns that.
 */
export function applyBrand(data) {
  const logo = document.getElementById('site-logo');
  const name = document.getElementById('site-name');
  const src = (data && ((data.content || {}).logo_url || data.org_logo)) || '';
  if (logo && src) { logo.src = src; logo.hidden = false; }
  if (name && data && data.app_title) name.textContent = data.app_title;
}

/**
 * Right-hand controls: theme toggle, sign-in and language menu — the same
 * three glyphs the map page always had. On the map, `onLogin` receives the
 * button so main.js can wire the login modal / admin panel; on the public
 * pages the button simply goes to /map?login=1.
 */
const GLYPH = (paths) => '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" '
  + `stroke="currentColor" stroke-width="1.6" aria-hidden="true">${paths}</svg>`;
const USER_GLYPH = GLYPH('<circle cx="12" cy="8" r="4"/><path d="M4 20c1.8-3.6 4.7-5 8-5s6.2 1.4 8 5"/>');
const GLOBE_GLYPH = GLYPH('<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/>'
  + '<path d="M3.6 8.5h16.8M3.6 15.5h16.8"/>');

export function initHeaderControls(opts = {}) {
  const wrap = document.getElementById('site-controls');
  if (!wrap || wrap.childElementCount) return;

  const themeBtn = document.createElement('button');
  themeBtn.id = 'theme-btn';
  themeBtn.type = 'button';
  themeBtn.className = 'hdr-glyph';
  initThemeButton(themeBtn);
  wrap.appendChild(themeBtn);

  let loginEl;
  if (typeof opts.onLogin === 'function') {
    loginEl = document.createElement('button');
    loginEl.type = 'button';
  } else {
    loginEl = document.createElement('a');
    loginEl.href = '/map?login=1';
  }
  loginEl.id = 'login-btn';
  loginEl.className = 'hdr-glyph';
  loginEl.innerHTML = USER_GLYPH;
  loginEl.title = t('auth.login');
  loginEl.setAttribute('aria-label', t('auth.login'));
  wrap.appendChild(loginEl);
  if (typeof opts.onLogin === 'function') opts.onLogin(loginEl);

  const langBtn = document.createElement('button');
  langBtn.id = 'lang-btn';
  langBtn.type = 'button';
  langBtn.className = 'hdr-glyph';
  langBtn.innerHTML = GLOBE_GLYPH;
  langBtn.title = t('lang.label');
  wrap.appendChild(langBtn);

  const menu = document.createElement('div');
  menu.id = 'lang-menu';
  for (const [code, label] of AVAILABLE) {
    const item = document.createElement('div');
    item.className = 'lang-item' + (code === currentLang() ? ' current' : '');
    item.textContent = label;
    item.addEventListener('click', () => switchLanguage(code));
    menu.appendChild(item);
  }
  langBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  });
  document.addEventListener('click', () => { menu.style.display = 'none'; });
  (document.getElementById('site-header') || wrap).appendChild(menu);
}

/**
 * Harvester protection for published contact details. The snapshot carries
 * e-mail/phone reversed + base64 (never regex-matchable in HTML or JSON);
 * deobf() restores the text and armContact() only puts the mailto:/tel:
 * href into the DOM on the first human interaction (hover, touch, focus),
 * so a headless crawler that merely loads the page never sees it.
 */
export function deobf(enc) {
  if (!enc) return '';
  try {
    // atob → UTF-8 bytes of the reversed string; decode, then un-reverse.
    const reversed = decodeURIComponent(escape(atob(enc)));
    return reversed.split('').reverse().join('');
  } catch (e) { return ''; }
}

export function armContact(el, kind, value) {
  if (!el || !value) return;
  const href = kind === 'tel' ? `tel:${value.replace(/[^+\d]/g, '')}` : `mailto:${value}`;
  const arm = () => { if (!el.getAttribute('href')) el.setAttribute('href', href); };
  ['pointerenter', 'touchstart', 'focus', 'pointerdown'].forEach((ev) =>
    el.addEventListener(ev, arm, { once: true, passive: true }));
}
