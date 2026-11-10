/**
 * Standalone public page (/about, /people, /contact) — served by one shell;
 * the path picks the page out of the published snapshot (or the draft in
 * ?preview mode). Body HTML was rendered and sanitised server-side.
 */
import api from './api-client.js';
import { t, currentLang, setInstanceDefault } from './i18n.js';
import { applyNav, applyBrand, initHeaderControls, applyFooter, deobf, armContact } from './site-nav.js';

function pick(v) {
  // Content is plain text, shown as entered; legacy per-language dicts
  // fall back visitor language → English → anything.
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return '';
  const lang = currentLang();
  return v[lang] || v.en || Object.values(v)[0] || '';
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
  // Instance default language before any t() output.
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
  const title = pick(page.title) || t(`site.nav.${slug}`);
  document.title = title;
  applyBrand(data);
  initHeaderControls();
  applyNav(slug, c.pages, c);
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g,
    (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const body = document.getElementById('page-body');
  let inner = `<h1 style="font-family:var(--font-display);margin-top:0;">${esc(title)}</h1>`;
  // Contact details arrive obfuscated (email_x/phone_x) from the snapshot;
  // decoded text goes in, the mailto:/tel: href only on first interaction.
  const contacts = [];
  if (slug === 'people' && Array.isArray(page.members)) {
    inner += '<div class="people-grid">' + page.members.map((m) => {
      const email = m.email_x ? deobf(m.email_x) : (m.email || '');
      const phone = m.phone_x ? deobf(m.phone_x) : (m.phone || '');
      let card = `
      <div class="person-card">
        ${m.photo ? `<img src="${esc(m.photo)}" alt="">` : '<div class="person-photo-placeholder"></div>'}
        <div class="person-name">${esc(m.name)}</div>
        <div class="person-position">${esc(pick(m.position))}</div>`;
      [['mailto', email], ['tel', phone]].forEach(([kind, value]) => {
        if (!value) return;
        contacts.push([`contact-${contacts.length}`, kind, value]);
        card += `<a class="person-contact" id="contact-${contacts.length - 1}" tabindex="0">${esc(value)}</a>`;
      });
      return card + '</div>';
    }).join('') + '</div>';
  } else if (slug === 'contact') {
    const email = page.email_x ? deobf(page.email_x) : (page.email || '');
    const phone = page.phone_x ? deobf(page.phone_x) : (page.phone || '');
    const address = pick(page.address);
    let block = '';
    if (address) {
      block += `<p class="contact-address">${esc(address).replace(/\n/g, '<br>')}</p>`;
    }
    [['mailto', email], ['tel', phone]].forEach(([kind, value]) => {
      if (!value) return;
      contacts.push([`contact-${contacts.length}`, kind, value]);
      block += `<a class="person-contact contact-line" id="contact-${contacts.length - 1}" tabindex="0">${esc(value)}</a>`;
    });
    if (block) inner += `<div class="contact-block">${block}</div>`;
    inner += pick(page.body_html);
  } else {
    inner += pick(page.body_html);
  }
  body.innerHTML = inner;
  contacts.forEach(([id, kind, value]) => armContact(document.getElementById(id), kind, value));
  body.hidden = false;
  applyFooter(data);
  document.getElementById('site-footer').hidden = false;
  document.getElementById('site-header').hidden = false;
  document.getElementById('site').hidden = false;
}

init();
