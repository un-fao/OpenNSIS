/**
 * Shared header wiring for every page (landing, dashboard, standalone
 * pages and the map): navigation labels from i18n, brand (logo + instance
 * name) and the theme / sign-in / language controls. About/People/Contact
 * stay muted "coming soon" until the published content carries that page,
 * then they become real links.
 */
import api from './api-client.js';
import { t, AVAILABLE, currentLang, switchLanguage } from './i18n.js';
import { initThemeButton } from './theme.js';

const PAGE_IDS = { about: 'nav-about', people: 'nav-people', contact: 'nav-contact' };

// Canonical header entries and their default order; the admin can reorder
// them (content.nav_order), and every page renders the same sequence.
export const NAV_SLUGS = ['home', 'about', 'news', 'map', 'catalogue', 'dashboard', 'people', 'contact'];

export function normalizeOrder(order) {
  const base = Array.isArray(order) ? order.filter((s) => NAV_SLUGS.includes(s)) : [];
  NAV_SLUGS.forEach((s) => { if (!base.includes(s)) base.push(s); });
  return base;
}

export function applyNav(current, pages, content) {
  const items = [['nav-home', 'site.nav.home', '/'], ['nav-about', 'site.nav.about', '/about'],
                 ['nav-map', 'site.nav.map', '/map'], ['nav-catalogue', 'site.nav.catalogue', null],
                 ['nav-dashboard', 'site.nav.dashboard', '/dashboard'],
                 ['nav-news', 'site.nav.news', '/news'],
                 ['nav-people', 'site.nav.people', '/people'],
                 ['nav-contact', 'site.nav.contact', '/contact'],
                 ['nav-admin', 'auth.adminPanel', '/admin']];
  items.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = t(key);
    el.classList.toggle('nav-current', id === `nav-${current}`);
  });
  // Admin panel entry: present on every page but visible only while a
  // session exists; logging out makes it disappear again.
  const adminEl = document.getElementById('nav-admin');
  if (adminEl) adminEl.style.display = api.restoreSession() ? '' : 'none';
  // CMS pages appear in the header only while published (re-runnable: the
  // admin refreshes the header after every publish/unpublish).
  Object.entries(PAGE_IDS).forEach(([slug, id]) => {
    let el = document.getElementById(id);
    if (!el) return;
    const published = !!(pages && pages[slug]);
    if (published && el.tagName !== 'A') {
      const a = document.createElement('a');
      a.id = el.id;
      a.href = `/${slug}`;
      a.className = 'nav-link';
      a.textContent = el.textContent;
      if (`nav-${current}` === id) a.classList.add('nav-current');
      el.replaceWith(a);
      el = a;
    }
    el.style.display = published ? '' : 'none';
  });
  // Catalogue, Dashboard and Map are features, not CMS pages; their links
  // can be unpublished from the Website tab (default: shown).
  if (content) {
    [['nav-catalogue', 'catalogue_published'], ['nav-dashboard', 'dashboard_published'],
     ['nav-map', 'map_published'], ['nav-news', 'news_published']]
      .forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (el) el.style.display = content[key] === false ? 'none' : '';
      });
  }
  // Admin-chosen ordering: moving each entry in sequence re-sorts the bar.
  const navEl = document.querySelector('.site-nav');
  if (navEl) {
    normalizeOrder(content && content.nav_order).forEach((slug) => {
      const el = document.getElementById(`nav-${slug}`);
      if (el && el.parentElement === navEl) navEl.appendChild(el);
    });
    // The admin entry is not reorderable: it stays pinned after the
    // public pages.
    if (adminEl && adminEl.parentElement === navEl) navEl.appendChild(adminEl);
  }
}

/**
 * Shared deep footer (landing, dashboard): instance name, links to the
 * published pages in the admin-chosen order, and the CMS footer text
 * (Website → Home → Footer, rendered and sanitised at publish time).
 * The page provides #site-footer with #footer-name/#footer-nav/#footer-custom.
 */
export function applyFooter(data) {
  const wrap = document.getElementById('site-footer');
  if (!wrap || !data) return;
  const c = data.content || {};
  const pages = c.pages || {};
  const name = document.getElementById('footer-name');
  if (name) name.textContent = data.app_title || '';
  const entries = {
    map: c.map_published !== false && { href: '/map' },
    catalogue: c.catalogue_published !== false && { href: '/catalogue' },
    dashboard: c.dashboard_published !== false && { href: '/dashboard' },
    news: c.news_published !== false && { href: '/news' },
    about: pages.about && { href: '/about' },
    people: pages.people && { href: '/people' },
    contact: pages.contact && { href: '/contact' },
  };
  const linkHtml = (slug) => {
    const e = entries[slug];
    if (!e) return '';
    return `<a href="${e.href}"${e.blank ? ' target="_blank" rel="noopener"' : ''}>`
      + `${t('site.nav.' + slug)}</a>`;
  };
  const order = normalizeOrder(c.nav_order).filter((s) => s !== 'home');
  const nav = document.getElementById('footer-nav');
  if (nav) nav.innerHTML = `<a href="/">${t('site.nav.home')}</a>` + order.map(linkHtml).join('');
  const fc = document.getElementById('footer-custom');
  const src = c.footer_html;
  const footer = typeof src === 'string' ? src
    : (src && typeof src === 'object')
      ? (src[currentLang()] || src.en || Object.values(src)[0] || '') : '';
  if (fc && footer) { fc.innerHTML = footer; fc.hidden = false; }
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

  const loginEl = document.createElement('button');
  loginEl.type = 'button';
  loginEl.id = 'login-btn';
  loginEl.className = 'hdr-glyph';
  loginEl.innerHTML = USER_GLYPH;
  const authed = api.restoreSession();
  loginEl.title = authed ? t('auth.adminPanel') : t('auth.login');
  loginEl.setAttribute('aria-label', loginEl.title);
  wrap.appendChild(loginEl);
  if (typeof opts.onLogin === 'function') {
    opts.onLogin(loginEl);
  } else {
    // Public pages: sign in right here; the admin panel opens on the map
    // afterwards (main.js honours the sis_reopen_admin flag on load).
    loginEl.addEventListener('click', () => {
      if (api.restoreSession()) location.href = '/admin';
      else showSiteLogin();
    });
  }

  const themeBtn = document.createElement('button');
  themeBtn.id = 'theme-btn';
  themeBtn.type = 'button';
  themeBtn.className = 'hdr-glyph';
  initThemeButton(themeBtn);
  wrap.appendChild(themeBtn);

  const langBtn = document.createElement('button');
  langBtn.id = 'lang-btn';
  langBtn.type = 'button';
  langBtn.className = 'hdr-glyph';
  langBtn.innerHTML = GLOBE_GLYPH
    + `<span class="lang-code">${currentLang().toUpperCase()}</span>`;
  langBtn.title = t('lang.label');
  wrap.appendChild(langBtn);

  const menu = document.createElement('div');
  menu.id = 'lang-menu';
  for (const [code, label] of AVAILABLE) {
    const item = document.createElement('div');
    item.className = 'lang-item' + (code === currentLang() ? ' current' : '');
    item.textContent = label;
    item.addEventListener('click', () => {
      // Switching reloads the page; if the admin panel is open, flag it
      // so main.js reopens it after the reload.
      const dash = document.getElementById('admin-dashboard');
      if (dash && dash.classList.contains('active')) {
        try { sessionStorage.setItem('sis_reopen_admin', '1'); } catch (e) { /* private mode */ }
      }
      switchLanguage(code);
    });
    menu.appendChild(item);
  }
  langBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  });
  document.addEventListener('click', () => { menu.style.display = 'none'; });
  wrap.appendChild(menu);
}

/** In-place sign-in dialogue for the public pages. On success the browser
 * moves to the map with the admin panel opening automatically. */
function showSiteLogin() {
  if (document.getElementById('hdr-login-overlay')) return;
  const ov = document.createElement('div');
  ov.id = 'hdr-login-overlay';
  ov.innerHTML = `
    <div class="hdr-login-card" role="dialog" aria-modal="true">
      <h2>${t('auth.adminLogin')}</h2>
      <div class="hdr-login-error" id="hdr-login-error"></div>
      <form id="hdr-login-form">
        <label>${t('auth.username')}
          <input type="text" id="hdr-login-user" required autocomplete="username"></label>
        <label>${t('auth.password')}
          <input type="password" id="hdr-login-pass" required autocomplete="current-password"></label>
        <div class="hdr-login-actions">
          <button type="button" id="hdr-login-cancel">${t('a.cancel')}</button>
          <button type="submit" class="hdr-login-submit">${t('auth.login')}</button>
        </div>
      </form>
    </div>`;
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelector('#hdr-login-cancel').addEventListener('click', close);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  ov.querySelector('#hdr-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = ov.querySelector('#hdr-login-error');
    err.textContent = '';
    try {
      await api.login(ov.querySelector('#hdr-login-user').value.trim(),
                      ov.querySelector('#hdr-login-pass').value);
      location.href = '/admin';
    } catch (ex) { err.textContent = ex.message; }
  });
  document.body.appendChild(ov);
  ov.querySelector('#hdr-login-user').focus();
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
