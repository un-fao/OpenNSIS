/**
 * Website tab (issue #13, v1): edit the public landing page.
 *
 * Draft → Publish. The draft is plain Markdown + fields; the
 * server renders and sanitises at publish time. Content text fields are
 * per-language objects ({en: …}), edited through a language switcher with
 * the same fallback the public page uses.
 */
import api from './api-client.js';
import { t, AVAILABLE } from './i18n.js';
import { normalizeOrder } from './site-nav.js';

let state = { content: {}, lang: 'en', enabled: false, mounted: false, page: 'general' };

const e = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function langVal(field) {
  return ((state.content[field] || {})[state.lang]) || '';
}
function setLangVal(field, v) {
  if (!state.content[field] || typeof state.content[field] !== 'object') state.content[field] = {};
  if (v) state.content[field][state.lang] = v;
  else delete state.content[field][state.lang];
}
function heroVal(field) {
  return (((state.content.hero || {})[field] || {})[state.lang]) || '';
}
function setHeroVal(field, v) {
  if (!state.content.hero) state.content.hero = {};
  if (!state.content.hero[field] || typeof state.content.hero[field] !== 'object') state.content.hero[field] = {};
  if (v) state.content.hero[field][state.lang] = v;
  else delete state.content.hero[field][state.lang];
}

function pageVal(slug, field) {
  const p = ((state.content.pages || {})[slug]) || {};
  return ((p[field] || {})[state.lang]) || '';
}
function setPageVal(slug, field, v) {
  if (!state.content.pages) state.content.pages = {};
  if (!state.content.pages[slug]) state.content.pages[slug] = {};
  const p = state.content.pages[slug];
  if (!p[field] || typeof p[field] !== 'object') p[field] = {};
  if (v) p[field][state.lang] = v;
  else delete p[field][state.lang];
}

function members() {
  if (!state.content.pages) state.content.pages = {};
  if (!state.content.pages.people) state.content.pages.people = {};
  if (!Array.isArray(state.content.pages.people.members)) state.content.pages.people.members = [];
  return state.content.pages.people.members;
}

function renderMembers() {
  const list = document.getElementById('site-people-list');
  if (!list) return;
  const ms = members();
  // Column headers mirror the row's flex layout; the hidden buttons only
  // reserve the width of their real counterparts so the labels line up.
  const header = ms.length ? `
    <div style="display:flex;gap:8px;align-items:center;padding:0 0 2px;font-size:var(--fs-xs);font-weight:700;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:0.04em;">
      <span style="width:40px;flex:none;">${t('a.site.ppl.photo')}</span>
      <button type="button" class="btn btn-sm" style="flex:none;visibility:hidden;" tabindex="-1" aria-hidden="true">${t('a.upload')}</button>
      <span style="flex:1 1 120px;min-width:0;">${t('a.site.ppl.name')}</span>
      <span style="flex:1 1 140px;min-width:0;">${t('a.site.ppl.position')}</span>
      <span style="flex:1 1 150px;min-width:0;">${t('a.site.ppl.email')}</span>
      <span style="flex:0 1 110px;min-width:0;">${t('a.site.ppl.phone')}</span>
      <span style="flex:none;">${t('a.published')}</span>
      <button type="button" class="btn btn-sm" style="flex:none;visibility:hidden;" tabindex="-1" aria-hidden="true">${t('a.delete')}</button>
    </div>` : '';
  list.innerHTML = header + ms.map((m, i) => `
    <div class="site-member-row" data-i="${i}" style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--color-border);">
      <img src="${e(m.photo || '')}" alt="" style="width:40px;height:40px;flex:none;border-radius:50%;object-fit:cover;background:var(--color-surface-hover);${m.photo ? '' : 'visibility:hidden;'}">
      <button type="button" class="btn btn-sm sm-photo" style="flex:none;">${t('a.upload')}</button>
      <input type="text" class="sm-name" value="${e(m.name || '')}" placeholder="${t('a.site.ppl.name')}" style="flex:1 1 120px;min-width:0;">
      <input type="text" class="sm-position" value="${e((m.position || {})[state.lang] || '')}" placeholder="${t('a.site.ppl.position')}" style="flex:1 1 140px;min-width:0;">
      <input type="email" class="sm-email" value="${e(m.email || '')}" placeholder="${t('a.site.ppl.email')}" style="flex:1 1 150px;min-width:0;">
      <input type="text" class="sm-phone" value="${e(m.phone || '')}" placeholder="${t('a.site.ppl.phone')}" style="flex:0 1 110px;min-width:0;">
      <span class="badge ${m.publish === false ? 'badge-danger' : 'badge-success'} sm-pub" style="cursor:pointer;flex:none;" title="${t('a.published')}">${m.publish === false ? t('a.no') : t('a.yes')}</span>
      <button type="button" class="btn btn-sm sm-del" style="color:var(--color-danger);flex:none;">${t('a.delete')}</button>
    </div>`).join('');
  list.querySelectorAll('.site-member-row').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector('.sm-del').addEventListener('click', () => {
      readMembers();
      members().splice(i, 1);
      renderMembers();
    });
    row.querySelector('.sm-pub').addEventListener('click', () => {
      readMembers();
      const m = members()[i];
      m.publish = m.publish === false;
      renderMembers();
    });
    row.querySelector('.sm-photo').addEventListener('click', () => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'image/*';
      picker.addEventListener('change', async () => {
        if (!picker.files[0]) return;
        try {
          const r = await api.uploadSiteMedia(picker.files[0]);
          readMembers();
          members()[i].photo = r.url;
          renderMembers();
        } catch (err) {
          document.getElementById('site-status').textContent = err.message;
        }
      });
      picker.click();
    });
  });
}

function readMembers() {
  const list = document.getElementById('site-people-list');
  if (!list) return;
  const ms = members();
  list.querySelectorAll('.site-member-row').forEach((row) => {
    const i = Number(row.dataset.i);
    if (!ms[i]) return;
    ms[i].name = row.querySelector('.sm-name').value.trim();
    if (!ms[i].position || typeof ms[i].position !== 'object') ms[i].position = {};
    const pos = row.querySelector('.sm-position').value.trim();
    if (pos) ms[i].position[state.lang] = pos;
    else delete ms[i].position[state.lang];
    ms[i].email = row.querySelector('.sm-email').value.trim();
    ms[i].phone = row.querySelector('.sm-phone').value.trim();
  });
}

// WCAG relative luminance; warn when white button text would be illegible.
function contrastWithWhite(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return 1.05 / (L + 0.05);
}

function markup() {
  return `
    <div class="admin-section" style="max-width:1150px;">
      <h3 class="admin-section-title">${t('a.site.title')}</h3>

      <div style="display:flex;gap:6px;margin-bottom:var(--sp-3);flex-wrap:wrap;" id="site-pages-bar"></div>

      <div data-sitepage="general" style="display:grid;grid-template-columns:auto 1fr;gap:var(--sp-3);align-items:start;">
        <label>${t('a.site.langLbl')}</label>
        <span style="display:flex;gap:4px;" id="site-langs"></span>
        <label>${t('a.site.orderLbl')}</label>
        <div id="site-nav-order" style="display:flex;flex-direction:column;gap:4px;width:fit-content;"></div>
      </div>

      <div data-sitepage="home" style="display:none;grid-template-columns:auto 1fr;gap:var(--sp-2) var(--sp-3);align-items:center;">
        <label>${t('a.site.logo')}</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="text" id="site-logo-url" style="flex:1;" placeholder="https:// … ${t('a.site.orUpload')}">
          <button type="button" class="btn btn-sm" id="site-logo-upload">${t('a.upload')}</button>
        </div>
        <label>${t('a.site.heroTitle')}</label>
        <input type="text" id="site-hero-title">
        <label>${t('a.site.heroSubtitle')}</label>
        <input type="text" id="site-hero-subtitle">
        <label>${t('a.site.heroImage')}</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="text" id="site-hero-image" style="flex:1;" placeholder="/media/…">
          <button type="button" class="btn btn-sm" id="site-hero-upload">${t('a.upload')}</button>
        </div>
        <label style="align-self:start;">${t('a.site.about')}</label>
        <textarea id="site-about" rows="10" style="font-family:var(--font-mono,monospace);font-size:var(--fs-sm);"></textarea>
        <label style="align-self:start;">${t('a.site.footer')}</label>
        <textarea id="site-footer-md" rows="4" style="font-family:var(--font-mono,monospace);font-size:var(--fs-sm);"></textarea>
      </div>

      <div data-sitepage="about" style="display:none;grid-template-columns:auto 1fr;gap:var(--sp-2) var(--sp-3);align-items:start;">
        <label>${t('a.site.pageTitle')}</label>
        <input type="text" id="site-page-about-title">
        <label>${t('a.site.pageBody')}</label>
        <textarea id="site-page-about-body" rows="14" style="font-family:var(--font-mono,monospace);font-size:var(--fs-sm);"></textarea>
      </div>

      <div data-sitepage="contact" style="display:none;grid-template-columns:auto 1fr;gap:var(--sp-2) var(--sp-3);align-items:start;">
        <label>${t('a.site.pageTitle')}</label>
        <input type="text" id="site-page-contact-title">
        <label>${t('a.site.ct.address')}</label>
        <textarea id="site-contact-address" rows="3"></textarea>
        <label>${t('a.site.ppl.email')}</label>
        <input type="email" id="site-contact-email" style="max-width:320px;">
        <label>${t('a.site.ppl.phone')}</label>
        <input type="text" id="site-contact-phone" style="max-width:220px;">
        <label>${t('a.site.pageBody')}</label>
        <textarea id="site-page-contact-body" rows="10" style="font-family:var(--font-mono,monospace);font-size:var(--fs-sm);"></textarea>
      </div>

      <div data-sitepage="people" style="display:none;">
        <div style="display:grid;grid-template-columns:auto 1fr;gap:var(--sp-2) var(--sp-3);align-items:center;max-width:520px;">
          <label>${t('a.site.pageTitle')}</label>
          <input type="text" id="site-page-people-title">
        </div>
        <div id="site-people-list" style="margin-top:var(--sp-3);"></div>
        <button type="button" class="btn btn-sm" id="site-people-add" style="margin-top:var(--sp-2);width:fit-content;justify-self:start;">${t('a.site.ppl.add')}</button>
      </div>

      <div data-sitepage="home" style="display:none;grid-template-columns:auto 1fr;gap:var(--sp-2) var(--sp-3);align-items:center;margin-top:var(--sp-2);">
        <label>${t('a.site.colours')}</label>
        <div style="display:flex;gap:var(--sp-3);align-items:center;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:5px;">${t('a.site.primary')}
            <input type="color" id="site-color-primary" value="#1d5f73"></label>
          <label style="display:flex;align-items:center;gap:5px;">${t('a.site.secondary')}
            <input type="color" id="site-color-secondary" value="#8a6844"></label>
          <span id="site-contrast-warn" style="color:var(--color-danger);font-size:var(--fs-sm);"></span>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:var(--sp-3);margin-top:var(--sp-4);">
        <button type="button" class="btn btn-secondary" id="site-save">${t('a.site.save')}</button>
        <button type="button" class="btn btn-secondary" id="site-preview">${t('a.site.previewBtn')}</button>
        <button type="button" class="btn btn-primary" id="site-publish"></button>
        <span id="site-status" style="font-size:var(--fs-sm);"></span>
      </div>
    </div>`;
}

// Per-page publish state: a page with content is public unless its flag
// was set to false; Home's flag is the landing switch itself (legacy
// content without the flag follows the old SITE_LANDING_ENABLED setting,
// surfaced here as state.enabled).
// Catalogue and Dashboard are features with their own routes, shown as
// plain pages in the bar; their flags only control the header links.
const FEATURE_FLAGS = { catalogue: 'catalogue_published', dashboard: 'dashboard_published' };

function pageIsPublished(slug) {
  if (slug === 'home') {
    const hp = state.content.home_published;
    return typeof hp === 'boolean' ? hp : !!state.enabled;
  }
  if (FEATURE_FLAGS[slug]) return state.content[FEATURE_FLAGS[slug]] !== false;
  const p = ((state.content.pages || {})[slug]) || {};
  return p.published !== false;
}

// Website sub-tabs follow the admin-chosen page order (General first;
// Map is header-only and has no sub-tab).
const TAB_SLUGS = ['home', 'about', 'people', 'contact', 'catalogue', 'dashboard'];

function renderPagesBar() {
  const bar = document.getElementById('site-pages-bar');
  if (!bar) return;
  const tabs = ['general',
                ...normalizeOrder(state.content.nav_order).filter((s) => TAB_SLUGS.includes(s))];
  bar.innerHTML = tabs.map((p) =>
    `<button type="button" class="btn btn-sm site-page-tab${p === state.page ? ' btn-primary' : ''}" data-page="${p}">${p === 'general' ? t('a.site.general') : t('site.nav.' + p)}</button>`).join('');
  bar.querySelectorAll('.site-page-tab').forEach((b) => b.addEventListener('click', () => {
    state.page = b.dataset.page;
    bar.querySelectorAll('.site-page-tab').forEach((x) =>
      x.classList.toggle('btn-primary', x === b));
    document.querySelectorAll('[data-sitepage]').forEach((panel) => {
      const mine = panel.dataset.sitepage === state.page;
      panel.style.display = mine ? 'grid' : 'none';
    });
    updatePublishBtn();
  }));
}

function renderOrderList() {
  const wrap = document.getElementById('site-nav-order');
  if (!wrap) return;
  const order = normalizeOrder(state.content.nav_order);
  wrap.innerHTML = order.map((slug, i) => `
    <div style="display:flex;align-items:center;gap:6px;">
      <button type="button" class="btn btn-sm ord-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} style="padding:2px 9px;">↑</button>
      <button type="button" class="btn btn-sm ord-down" data-i="${i}" ${i === order.length - 1 ? 'disabled' : ''} style="padding:2px 9px;">↓</button>
      <span>${t('site.nav.' + slug)}</span>
    </div>`).join('');
  wrap.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    const i = Number(b.dataset.i);
    const j = b.classList.contains('ord-up') ? i - 1 : i + 1;
    const status = document.getElementById('site-status');
    readForm();
    const ord = normalizeOrder(state.content.nav_order);
    [ord[i], ord[j]] = [ord[j], ord[i]];
    state.content.nav_order = ord;
    renderOrderList();
    renderPagesBar();
    try {
      await api.saveSiteDraft(state.content);
      await api.publishSite();
      status.textContent = '';
      window.dispatchEvent(new CustomEvent('site:published'));
    } catch (err) { status.textContent = err.message; }
  }));
}

function updatePublishBtn() {
  const pubBtn = document.getElementById('site-publish');
  const saveBtn = document.getElementById('site-save');
  if (!pubBtn) return;
  // General: nothing to publish. Catalogue/Dashboard: nothing to save.
  pubBtn.style.display = state.page === 'general' ? 'none' : '';
  if (saveBtn) saveBtn.style.display = FEATURE_FLAGS[state.page] ? 'none' : '';
  pubBtn.textContent = pageIsPublished(state.page) ? t('a.site.unpublish') : t('a.site.publish');
}

function readForm() {
  const v = (id) => document.getElementById(id).value.trim();
  state.content.logo_url = v('site-logo-url') || undefined;
  setHeroVal('title', v('site-hero-title'));
  setHeroVal('subtitle', v('site-hero-subtitle'));
  if (!state.content.hero) state.content.hero = {};
  state.content.hero.image = v('site-hero-image') || undefined;
  setLangVal('about_md', document.getElementById('site-about').value);
  setLangVal('footer_md', document.getElementById('site-footer-md').value);
  state.content.colors = {
    ...(state.content.colors || {}),
    primary: v('site-color-primary'),
    secondary: v('site-color-secondary'),
  };
  ['about', 'contact'].forEach((p) => {
    setPageVal(p, 'title', v(`site-page-${p}-title`));
    setPageVal(p, 'body_md', document.getElementById(`site-page-${p}-body`).value);
  });
  setPageVal('contact', 'address', document.getElementById('site-contact-address').value.trim());
  state.content.pages.contact.email = v('site-contact-email');
  state.content.pages.contact.phone = v('site-contact-phone');
  setPageVal('people', 'title', v('site-page-people-title'));
  readMembers();
}

function fillForm() {
  const set = (id, val) => { document.getElementById(id).value = val || ''; };
  set('site-logo-url', state.content.logo_url);
  set('site-hero-title', heroVal('title'));
  set('site-hero-subtitle', heroVal('subtitle'));
  set('site-hero-image', (state.content.hero || {}).image);
  document.getElementById('site-about').value = langVal('about_md');
  document.getElementById('site-footer-md').value = langVal('footer_md');
  const col = state.content.colors || {};
  if (col.primary) set('site-color-primary', col.primary);
  if (col.secondary) set('site-color-secondary', col.secondary);
  ['about', 'contact'].forEach((p) => {
    set(`site-page-${p}-title`, pageVal(p, 'title'));
    document.getElementById(`site-page-${p}-body`).value = pageVal(p, 'body_md');
  });
  set('site-page-people-title', pageVal('people', 'title'));
  document.getElementById('site-contact-address').value = pageVal('contact', 'address');
  const contactPage = ((state.content.pages || {}).contact) || {};
  set('site-contact-email', contactPage.email);
  set('site-contact-phone', contactPage.phone);
  renderMembers();
  renderLangPills();
  checkContrast();
  renderPagesBar();
  renderOrderList();
  updatePublishBtn();
}

function renderLangPills() {
  const wrap = document.getElementById('site-langs');
  wrap.innerHTML = AVAILABLE.map(([code]) =>
    `<button type="button" class="btn btn-sm${code === state.lang ? ' btn-primary' : ''}"
       data-lang="${code}" style="padding:2px 9px;">${code}</button>`).join('');
  wrap.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    readForm();
    state.lang = b.dataset.lang;
    fillForm();
  }));
}

function checkContrast() {
  const warnEl = document.getElementById('site-contrast-warn');
  const ratio = contrastWithWhite(document.getElementById('site-color-primary').value);
  warnEl.textContent = (ratio !== null && ratio < 4.5) ? t('a.site.contrastWarn') : '';
}

async function uploadInto(inputId) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.addEventListener('change', async () => {
    if (!picker.files[0]) return;
    const status = document.getElementById('site-status');
    status.textContent = t('a.st.uploading');
    try {
      const r = await api.uploadSiteMedia(picker.files[0]);
      document.getElementById(inputId).value = r.url;
      status.textContent = '';
    } catch (err) {
      status.textContent = err.message;
    }
  });
  picker.click();
}

export async function mountSiteAdmin() {
  const root = document.getElementById('site-admin-root');
  if (!root) return;
  if (!state.mounted) {
    root.innerHTML = markup();
    state.mounted = true;

    renderPagesBar();
    document.getElementById('site-people-add').addEventListener('click', () => {
      readMembers();
      members().push({ name: '', position: {}, email: '', phone: '', photo: '' });
      renderMembers();
    });
    document.getElementById('site-logo-upload').addEventListener('click', () => uploadInto('site-logo-url'));
    document.getElementById('site-hero-upload').addEventListener('click', () => uploadInto('site-hero-image'));
    document.getElementById('site-color-primary').addEventListener('input', checkContrast);
    document.getElementById('site-preview').addEventListener('click', async () => {
      const status = document.getElementById('site-status');
      // Catalogue and Dashboard have nothing to draft: just open them.
      if (state.page === 'catalogue') { window.open('/collections?f=html', '_blank', 'noopener'); return; }
      if (state.page === 'dashboard') { window.open('/dashboard', '_blank', 'noopener'); return; }
      readForm();
      try {
        await api.saveSiteDraft(state.content);
        status.textContent = t('a.site.draftSaved');
        const path = (state.page === 'home' || state.page === 'general') ? '/' : `/${state.page}`;
        window.open(`${path}?preview=1`, '_blank', 'noopener');
      } catch (err) { status.textContent = err.message; }
    });
    document.getElementById('site-save').addEventListener('click', async () => {
      const status = document.getElementById('site-status');
      readForm();
      try {
        await api.saveSiteDraft(state.content);
        status.textContent = t('a.site.draftSaved');
      } catch (err) { status.textContent = err.message; }
    });
    document.getElementById('site-publish').addEventListener('click', async () => {
      const status = document.getElementById('site-status');
      readForm();
      const makePublic = !pageIsPublished(state.page);
      if (state.page === 'home') {
        state.content.home_published = makePublic;
      } else if (FEATURE_FLAGS[state.page]) {
        state.content[FEATURE_FLAGS[state.page]] = makePublic;
      } else {
        if (!state.content.pages) state.content.pages = {};
        if (!state.content.pages[state.page]) state.content.pages[state.page] = {};
        state.content.pages[state.page].published = makePublic;
      }
      try {
        await api.saveSiteDraft(state.content);
        await api.publishSite();
        status.textContent = '';
        updatePublishBtn();
        window.dispatchEvent(new CustomEvent('site:published'));
      } catch (err) { status.textContent = err.message; }
    });
  }
  const d = await api.getSiteDraft();
  state.content = d.content || {};
  state.enabled = !!d.enabled;
  fillForm();
}
