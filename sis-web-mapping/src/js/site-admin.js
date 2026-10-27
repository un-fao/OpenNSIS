/**
 * Website tab (issue #13, v1): edit the public landing page.
 *
 * Draft → Publish → Rollback. The draft is plain Markdown + fields; the
 * server renders and sanitises at publish time. Content text fields are
 * per-language objects ({en: …}), edited through a language switcher with
 * the same fallback the public page uses.
 */
import api from './api-client.js';
import { t, AVAILABLE } from './i18n.js';

let state = { content: {}, lang: 'en', enabled: false, mounted: false };

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
    <div class="admin-section" style="max-width:860px;">
      <h3 class="admin-section-title">${t('a.site.title')}</h3>
      <p style="color:var(--color-text-muted);font-size:var(--fs-sm);margin:0 0 var(--sp-3);">${t('a.site.intro')}</p>

      <div style="display:flex;align-items:center;gap:var(--sp-3);margin-bottom:var(--sp-3);">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="site-enabled"> ${t('a.site.enabled')}
        </label>
        <a href="/" target="_blank" rel="noopener" style="font-size:var(--fs-sm);">${t('a.site.view')} ↗</a>
        <span style="margin-left:auto;display:flex;gap:4px;" id="site-langs"></span>
      </div>

      <div style="display:grid;grid-template-columns:auto 1fr;gap:var(--sp-2) var(--sp-3);align-items:center;">
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
        <button type="button" class="btn btn-secondary" id="site-save">${t('a.site.saveDraft')}</button>
        <button type="button" class="btn btn-primary" id="site-publish">${t('a.site.publish')}</button>
        <span id="site-status" style="font-size:var(--fs-sm);"></span>
      </div>

      <h4 style="margin:var(--sp-5) 0 var(--sp-2);">${t('a.site.versions')}</h4>
      <div id="site-snapshots" style="font-size:var(--fs-sm);"></div>
    </div>`;
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
  document.getElementById('site-enabled').checked = !!state.enabled;
  renderLangPills();
  checkContrast();
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

async function refreshSnapshots() {
  const rows = await api.listSiteSnapshots();
  const el = document.getElementById('site-snapshots');
  if (!rows.length) { el.textContent = t('a.site.noVersions'); return; }
  el.innerHTML = rows.map((r) => `
    <div style="display:flex;gap:var(--sp-3);align-items:center;padding:3px 0;">
      <span>#${r.snapshot_id} · ${e(String(r.created_at).slice(0, 16).replace('T', ' '))} · ${e(r.created_by || '')}</span>
      ${r.is_current
        ? `<span class="badge badge-success">${t('a.site.current')}</span>`
        : `<button type="button" class="btn btn-sm" data-sid="${r.snapshot_id}">${t('a.site.rollback')}</button>`}
    </div>`).join('');
  el.querySelectorAll('button[data-sid]').forEach((b) => b.addEventListener('click', async () => {
    await api.rollbackSite(Number(b.dataset.sid));
    const d = await api.getSiteDraft();
    state.content = d.content || {};
    fillForm();
    refreshSnapshots();
  }));
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

    document.getElementById('site-logo-upload').addEventListener('click', () => uploadInto('site-logo-url'));
    document.getElementById('site-hero-upload').addEventListener('click', () => uploadInto('site-hero-image'));
    document.getElementById('site-color-primary').addEventListener('input', checkContrast);
    document.getElementById('site-enabled').addEventListener('change', async (ev) => {
      await api.updateSetting('SITE_LANDING_ENABLED', ev.target.checked ? 'true' : 'false');
      state.enabled = ev.target.checked;
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
      try {
        await api.saveSiteDraft(state.content);
        const r = await api.publishSite();
        status.textContent = t('a.site.published', { n: r.snapshot_id });
        refreshSnapshots();
      } catch (err) { status.textContent = err.message; }
    });
  }
  const d = await api.getSiteDraft();
  state.content = d.content || {};
  state.enabled = !!d.enabled;
  fillForm();
  refreshSnapshots();
}
