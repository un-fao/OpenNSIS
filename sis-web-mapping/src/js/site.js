/**
 * Public landing page (issue #13, v1).
 *
 * One request to GET /api/site decides everything: while the landing is
 * disabled the visitor is sent straight to /map (the map's permanent home),
 * otherwise the published snapshot fills the shell. The snapshot's
 * about/footer HTML was rendered AND sanitised server-side at publish time —
 * this script only places it, it never parses Markdown or cleans HTML.
 */
import api from './api-client.js';
import { t, currentLang } from './i18n.js';

function pick(dict) {
  // Same fallback order as t(): visitor language → English → anything.
  if (!dict || typeof dict !== 'object') return '';
  const lang = currentLang();
  return dict[lang] || dict.en || Object.values(dict)[0] || '';
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
  if (isPreview) {
    const bar = document.createElement('div');
    bar.textContent = t('site.previewBanner');
    bar.style.cssText = 'position:sticky;top:0;z-index:50;text-align:center;'
      + 'padding:7px 12px;font-weight:700;font-size:14px;'
      + 'background:#b45309;color:#fff;letter-spacing:0.02em;';
    document.body.prepend(bar);
  }
  const c = data.content;
  document.title = pick((c.hero || {}).title) || 'Soil Information System';
  applyColors(c.colors);

  const logo = document.getElementById('site-logo');
  if (c.logo_url) { logo.src = c.logo_url; logo.hidden = false; }

  document.getElementById('site-map-link').textContent = t('site.openMap');
  document.getElementById('hero-cta').textContent = t('site.openMap');
  document.getElementById('hero-catalogue').textContent = t('site.catalogue');
  document.getElementById('hero-title').textContent = pick((c.hero || {}).title);
  document.getElementById('hero-subtitle').textContent = pick((c.hero || {}).subtitle);
  const heroImg = (c.hero || {}).image;
  if (heroImg) {
    const d = document.getElementById('hero-image');
    d.style.backgroundImage = `url("${encodeURI(heroImg)}")`;
    d.hidden = false;
  }

  const about = pick(c.about_html);
  if (about) {
    const el = document.getElementById('about');
    el.innerHTML = about;          // sanitised server-side at publish time
    el.hidden = false;
  }
  const footer = pick(c.footer_html);
  if (footer) {
    const el = document.getElementById('site-footer');
    el.innerHTML = footer;         // sanitised server-side at publish time
    el.hidden = false;
  }
  document.getElementById('site').hidden = false;
}

init();
