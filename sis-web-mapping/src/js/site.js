/**
 * Public landing page (issue #13, v3 — editorial layout).
 *
 * One request to GET /api/site decides everything: while the landing is
 * disabled the visitor is sent straight to /map (the map's permanent home),
 * otherwise the published snapshot fills the shell. The page is a set of
 * full-bleed bands — hero, quick links, tools, resources, how-it-works and
 * footer — whose copy ships in the locales; the CMS supplies the hero
 * title/lede/image, the about text, the footer note and the colours, and
 * the published flags decide which links appear. The snapshot's
 * about/footer HTML was rendered AND sanitised server-side at publish time —
 * this script only places it, it never parses Markdown or cleans HTML.
 */
import api from './api-client.js';
import { t, currentLang, setInstanceDefault } from './i18n.js';
import { applyNav, applyBrand, initHeaderControls, applyFooter } from './site-nav.js';

// Bundled by Parcel into a hashed, long-cached URL.
import IMG_LANDSCAPE from 'url:../img/hero-landscape-map.jpg';

const ICONS = {
  map: '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function pick(v) {
  // Content is plain text, shown as entered. Legacy snapshots stored
  // per-language dicts — fall back visitor language → English → anything.
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return '';
  const lang = currentLang();
  return v[lang] || v.en || Object.values(v)[0] || '';
}

function applyColors(colors) {
  if (!colors) return;
  const root = document.documentElement;
  // The admin sets light-theme accents; dark mode keeps the Terroir dark
  // tokens unless a dark pair is provided (half-themed pages have bitten us).
  const dark = root.dataset.theme === 'dark';
  const primary = dark ? (colors.primary_dark || null) : colors.primary;
  const secondary = dark ? (colors.secondary_dark || null) : colors.secondary;
  if (primary) root.style.setProperty('--color-primary', primary);
  if (secondary) root.style.setProperty('--color-secondary', secondary);
}

function set(id, text) { document.getElementById(id).textContent = text; }

async function init() {
  const isPreview = new URLSearchParams(location.search).has('preview');
  let data = null;
  try {
    // The landing page never shows a login — preview rides on the admin
    // session already stored by the map/admin pages.
    if (isPreview) api.restoreSession();
    data = isPreview ? await api.getSitePreview() : await api.getSite();
  } catch (e) {
    // Preview without an admin session, or API unreachable: go to the map.
    location.replace('/map');
    return;
  }
  if (!data || !data.content || (!data.enabled && !isPreview)) {
    location.replace('/map');
    return;
  }
  // A visitor without a chosen language gets the instance's LANGUAGE
  // setting (carried on /api/site), not English — must run before any t().
  setInstanceDefault((data.language || '').trim().toLowerCase());
  if (isPreview) {
    const bar = document.createElement('div');
    bar.textContent = t('site.previewBanner');
    bar.style.cssText = 'position:sticky;top:0;z-index:50;text-align:center;'
      + 'padding:7px 12px;font-weight:700;font-size:14px;'
      + 'background:#b45309;color:#fff;letter-spacing:0.02em;';
    document.body.prepend(bar);
  }
  const c = data.content;
  const pages = c.pages || {};
  const showMap = c.map_published !== false;
  const showCatalogue = c.catalogue_published !== false;
  const showDashboard = c.dashboard_published !== false;

  document.title = pick((c.hero || {}).title) || data.app_title || 'Soil Information System';
  applyColors(c.colors);

  applyBrand(data);
  initHeaderControls();
  applyNav('home', pages, c);

  // ---------- hero ----------
  set('hero-title', pick((c.hero || {}).title) || t('site.landing.heroTitle'));
  set('hero-subtitle', pick((c.hero || {}).subtitle) || t('site.landing.heroLede'));
  set('hero-cta', t('site.landing.ctaExplore'));
  set('hero-map', t('site.landing.ctaMap'));
  document.getElementById('hero-map').hidden = !showMap;
  document.getElementById('hero-cta').hidden = !showCatalogue;

  const heroImg = (c.hero || {}).image || IMG_LANDSCAPE;
  document.querySelector('.land-hero')
    .style.setProperty('--hero-img', `url("${encodeURI(heroImg)}")`);

  // ---------- quick links ----------
  set('quick-title', t('site.landing.toolsTitle'));
  set('quick-lede', t('site.landing.toolsLede'));
  const quick = [
    showMap && { icon: 'map', n: 2, href: '/map' },
    showCatalogue && { icon: 'file', n: 3, href: '/catalogue' },
    showDashboard && { icon: 'chart', n: 4, href: '/dashboard' },
  ].filter(Boolean);
  document.getElementById('quick-grid').innerHTML = quick.map((q) => `
    <a class="land-linkcard" href="${q.href}"${q.blank ? ' target="_blank" rel="noopener"' : ''}>
      <span class="land-linkcard-icon">${icon(q.icon)}</span>
      <h3>${t(`site.landing.q${q.n}t`)}</h3>
      <p>${t(`site.landing.q${q.n}b`)}</p>
      <span class="land-linkcard-go">${t(`site.landing.q${q.n}c`)} →</span>
    </a>`).join('');

  // ---------- about ----------
  set('about-title', t('site.landing.aboutTitle'));
  const aboutEl = document.getElementById('about');
  const about = pick(c.about_html);
  if (about) {
    aboutEl.innerHTML = about;       // sanitised server-side at publish time
  } else {
    aboutEl.innerHTML = `<p>${t('site.landing.aboutBody1')}</p><p>${t('site.landing.aboutBody2')}</p>`;
  }
  if (pages.about) {
    const cta = document.getElementById('about-cta');
    cta.textContent = t('site.landing.aboutCta');
    cta.href = '/about';
    cta.hidden = false;
  }

  // ---------- footer ----------
  applyFooter(data);

  document.getElementById('site-header').hidden = false;
  document.getElementById('site').hidden = false;
}

init();
