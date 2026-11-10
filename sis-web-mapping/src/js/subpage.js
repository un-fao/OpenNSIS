/**
 * Standalone public page (/about, /people, /contact) — served by one shell;
 * the path picks the page out of the published snapshot (or the draft in
 * ?preview mode). Body HTML was rendered and sanitised server-side.
 */
import api from './api-client.js';
import { t, currentLang } from './i18n.js';
import { applyNav } from './site-nav.js';

function pick(dict) {
  if (!dict || typeof dict !== 'object') return '';
  const lang = currentLang();
  return dict[lang] || dict.en || Object.values(dict)[0] || '';
}

async function init() {
  const slug = location.pathname.replace(/\/+$/, '').split('/').pop();
  const isPreview = new URLSearchParams(location.search).has('preview');
  let data = null;
  try {
    if (isPreview) api.restoreSession();
    data = isPreview ? await api.getSitePreview() : await api.getSite();
  } catch (e) {
    location.replace('/');
    return;
  }
  const page = data && data.content && (data.content.pages || {})[slug];
  if (!page || (!data.enabled && !isPreview)) {
    location.replace('/');
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
  const title = pick(page.title) || t(`site.nav.${slug}`);
  document.title = title;
  const logo = document.getElementById('site-logo');
  if (c.logo_url) { logo.src = c.logo_url; logo.hidden = false; }
  applyNav(slug, c.pages);
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g,
    (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const body = document.getElementById('page-body');
  let inner = `<h1 style="font-family:var(--font-display);margin-top:0;">${esc(title)}</h1>`;
  if (slug === 'people' && Array.isArray(page.members)) {
    inner += '<div class="people-grid">' + page.members.map((m) => `
      <div class="person-card">
        ${m.photo ? `<img src="${esc(m.photo)}" alt="">` : '<div class="person-photo-placeholder"></div>'}
        <div class="person-name">${esc(m.name)}</div>
        <div class="person-position">${esc(pick(m.position))}</div>
        ${m.email ? `<a class="person-contact" href="mailto:${esc(m.email)}">${esc(m.email)}</a>` : ''}
        ${m.phone ? `<a class="person-contact" href="tel:${esc(m.phone.replace(/[^+\d]/g, ''))}">${esc(m.phone)}</a>` : ''}
      </div>`).join('') + '</div>';
  } else {
    inner += pick(page.body_html);
  }
  body.innerHTML = inner;
  body.hidden = false;
  const footer = pick(c.footer_html);
  if (footer) {
    const el = document.getElementById('site-footer');
    el.innerHTML = footer;
    el.hidden = false;
  }
  document.getElementById('site').hidden = false;
}

init();
