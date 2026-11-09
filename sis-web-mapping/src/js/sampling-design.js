/**
 * Sampling design tab (SoilFER three-stage CSC).
 *
 * The admin picks data sources (each shown with its licence and link — the
 * run is as transparent as its manifest), sets the stage sizes, and runs.
 * Covariates are fetched by the server at run time and discarded; the page
 * polls the run's step log live and offers the design as GeoJSON/CSV.
 */
import api from './api-client.js';
import { t } from './i18n.js';

let mounted = false;
let pollTimer = null;

const e = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function markup(sources) {
  const srcRows = sources.map((s) => `
    <label style="display:flex;align-items:center;gap:8px;padding:2px 0;${s.required ? 'opacity:.85;' : ''}">
      <input type="checkbox" class="sd-source" value="${e(s.id)}" checked ${s.required ? 'disabled' : ''}>
      <span>${e(s.name)}</span>
      <a href="${e(s.link)}" target="_blank" rel="noopener" style="font-size:var(--fs-sm);">↗</a>
      <span class="badge" style="font-size:10px;">${e(s.licence)}</span>
      ${s.required ? `<span style="font-size:var(--fs-sm);color:var(--color-text-muted);">${t('a.sd.required')}</span>` : ''}
    </label>`).join('');
  return `
    <div class="admin-section" style="max-width:900px;">
      <h3 class="admin-section-title">${t('a.sd.title')}</h3>
      <p style="color:var(--color-text-muted);font-size:var(--fs-sm);margin:0 0 var(--sp-3);">${t('a.sd.intro')}</p>

      <h4 style="margin:0 0 var(--sp-2);">${t('a.sd.sources')}</h4>
      <div style="margin-bottom:var(--sp-3);">${srcRows}</div>
      <p style="color:var(--color-text-muted);font-size:var(--fs-sm);margin:0 0 var(--sp-3);">${t('a.sd.ephemeral')}</p>

      <div style="display:grid;grid-template-columns:auto 110px auto 110px;gap:var(--sp-2) var(--sp-3);align-items:center;max-width:620px;">
        <label>${t('a.sd.name')}</label>
        <input type="text" id="sd-name" style="grid-column:2 / span 3;">
        <label title="${t('a.sd.psuTip')}">${t('a.sd.nPsu')}</label>
        <input type="number" id="sd-n-psu" value="50" min="2" max="2000">
        <label title="${t('a.sd.psuSizeTip')}">${t('a.sd.psuSize')}</label>
        <input type="number" id="sd-psu-size" value="2000" min="100" step="100">
        <label>${t('a.sd.ssuPerPsu')}</label>
        <input type="number" id="sd-ssu" value="2" min="1" max="20">
        <label>${t('a.sd.ssuSize')}</label>
        <input type="number" id="sd-ssu-size" value="100" min="10" step="10">
        <label>${t('a.sd.ptsPerSsu')}</label>
        <input type="number" id="sd-pts" value="3" min="1" max="20">
        <label title="${t('a.sd.seedTip')}">${t('a.sd.seed')}</label>
        <input type="number" id="sd-seed" placeholder="${t('a.sd.seedAuto')}">
        <label>${t('a.sd.croplandOnly')}</label>
        <input type="checkbox" id="sd-cropland" checked style="justify-self:start;">
      </div>

      <div style="display:flex;align-items:center;gap:var(--sp-3);margin-top:var(--sp-4);">
        <button type="button" class="btn btn-primary" id="sd-run">${t('a.sd.run')}</button>
        <span id="sd-status" style="font-size:var(--fs-sm);"></span>
      </div>

      <h4 style="margin:var(--sp-5) 0 var(--sp-2);">${t('a.sd.designs')}</h4>
      <div id="sd-list" style="font-size:var(--fs-sm);">${t('a.loading')}</div>
      <pre id="sd-log" style="display:none;max-height:300px;overflow:auto;background:var(--color-surface-alt);color:var(--color-text);border:1px solid var(--color-border);border-radius:4px;padding:8px;font-size:11px;margin-top:var(--sp-3);"></pre>
    </div>`;
}

async function download(designId, kind, format) {
  const blob = await api.downloadSamplingExport(designId, kind, format);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sampling_design_${designId}_${kind}.${format === 'csv' ? 'csv' : 'geojson'}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function refresh() {
  const rows = await api.listSamplingDesigns();
  const el = document.getElementById('sd-list');
  if (!el) return;
  if (!rows.length) { el.textContent = t('a.sd.none'); return; }
  const badge = (on, cls, tip, id, field) =>
    `<span class="badge ${on ? 'badge-success' : 'badge-danger'} sd-toggle"
       data-id="${id}" data-field="${field}" data-value="${on ? 0 : 1}"
       style="cursor:pointer;" title="${e(tip)}">${on ? t('a.yes') : t('a.no')}</span>`;
  el.innerHTML = `<table class="admin-table"><thead><tr>
      <th>#</th><th>${t('a.sd.name')}</th><th>${t('a.status')}</th>
      <th>${t('a.sd.points')}</th><th>${t('a.sd.psus')}</th><th>${t('a.sd.ssus')}</th>
      <th>MSSD</th><th>${t('a.sd.symbology')}</th>
      <th>${t('a.published')}</th><th>${t('a.active')}</th><th></th></tr></thead><tbody>` +
    rows.map((r) => {
      const sym = r.symbology || {};
      const swatch = `<button type="button" class="sd-sym" data-id="${r.design_id}"
          title="${t('a.sd.symbology')}" style="width:22px;height:22px;border-radius:50%;
          border:2px solid #fff;box-shadow:0 0 0 1px var(--color-border-strong);
          background:${e(sym.color || '#d97706')};cursor:pointer;"></button>`;
      return `
      <tr data-id="${r.design_id}">
        <td>${r.design_id}</td>
        <td style="white-space:nowrap;">${e(r.name)}</td>
        <td>${r.status === 'failed'
            ? `<span class="badge badge-danger" title="${e(r.error || '')}">${e(r.status)}</span>`
            : `<span class="badge ${r.status === 'done' ? 'badge-success' : ''}">${e(r.status)}</span>`}</td>
        <td>${r.target_points || ''}</td>
        <td>${r.psus || ''}</td>
        <td>${r.ssus || ''}</td>
        <td>${r.quality && r.quality.stage1_mssd != null ? Number(r.quality.stage1_mssd).toFixed(3) : ''}</td>
        <td>${r.status === 'done' ? swatch : ''}</td>
        <td>${r.status === 'done' ? badge(!!r.is_published, '', t('a.published'), r.design_id, 'is_published') : ''}</td>
        <td>${r.status === 'done' ? badge(r.active_default !== false, '', t('a.active'), r.design_id, 'active_default') : ''}</td>
        <td style="white-space:nowrap;">
          ${r.abstract ? `<button type="button" class="btn btn-sm sd-meta" data-id="${r.design_id}" title="${t('icons.metadata')}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/></svg>
          </button>` : ''}
          <button type="button" class="btn btn-sm sd-log-btn" data-id="${r.design_id}">${t('a.sd.log')}</button>
          ${r.status === 'done' ? `
            <button type="button" class="btn btn-sm sd-dl" data-id="${r.design_id}" data-kind="point" data-format="geojson">GeoJSON</button>
            <button type="button" class="btn btn-sm sd-dl" data-id="${r.design_id}" data-kind="point" data-format="csv">CSV</button>` : ''}
          <button type="button" class="btn btn-sm sd-del" data-id="${r.design_id}" style="color:var(--color-danger);">${t('a.delete')}</button>
        </td>
      </tr>`;
    }).join('') + '</tbody></table><div id="sd-sym-editor" style="display:none;"></div>';

  el.querySelectorAll('.sd-dl').forEach((b) => b.addEventListener('click', () =>
    download(b.dataset.id, b.dataset.kind, b.dataset.format)));
  el.querySelectorAll('.sd-del').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(t('a.sd.deleteConfirm'))) return;
    await api.deleteSamplingDesign(Number(b.dataset.id));
    refresh();
  }));
  el.querySelectorAll('.sd-toggle').forEach((b) => b.addEventListener('click', async () => {
    await api.updateSamplingDesign(Number(b.dataset.id),
      { [b.dataset.field]: b.dataset.value === '1' });
    refresh();
  }));
  el.querySelectorAll('.sd-meta').forEach((b) => b.addEventListener('click', () => {
    const r = rows.find((x) => x.design_id === Number(b.dataset.id));
    const pre = document.getElementById('sd-log');
    pre.style.display = 'block';
    pre.textContent = r.abstract || '';
  }));
  el.querySelectorAll('.sd-sym').forEach((b) => b.addEventListener('click', () => {
    const r = rows.find((x) => x.design_id === Number(b.dataset.id));
    openSymEditor(r);
  }));
  el.querySelectorAll('.sd-log-btn').forEach((b) => b.addEventListener('click', async () => {
    const d = await api.getSamplingDesign(Number(b.dataset.id));
    const pre = document.getElementById('sd-log');
    pre.style.display = 'block';
    pre.textContent = (d.step_log || '') +
      (d.manifest ? '\n--- manifest ---\n' + JSON.stringify(d.manifest, null, 2) : '');
  }));

  const active = rows.some((r) => r.status === 'queued' || r.status === 'running');
  clearTimeout(pollTimer);
  if (active) pollTimer = setTimeout(refresh, 5000);
}

function openSymEditor(r) {
  const box = document.getElementById('sd-sym-editor');
  const sym = r.symbology || {};
  box.style.display = 'block';
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:var(--sp-3);flex-wrap:wrap;padding:var(--sp-2) 0;border-top:1px solid var(--color-border);margin-top:var(--sp-2);">
      <strong>#${r.design_id}</strong>
      <label>${t('a.sd.symShape')}
        <select id="sdsym-shape">
          ${['circle', 'square', 'triangle'].map((x) =>
            `<option value="${x}" ${(sym.shape || 'circle') === x ? 'selected' : ''}>${x}</option>`).join('')}
        </select></label>
      <label>${t('a.sd.symSize')} <input type="number" id="sdsym-size" value="${sym.size || 7}" min="3" max="20" style="width:60px;"></label>
      <label>${t('a.sd.symColour')} <input type="color" id="sdsym-color" value="${sym.color || '#d97706'}"></label>
      <label>${t('a.sd.symOutline')} <input type="color" id="sdsym-outline" value="${sym.outline_color || sym.color || '#d97706'}"></label>
      <label>${t('a.sd.symOpacity')} <input type="range" id="sdsym-opacity" value="${sym.opacity != null ? sym.opacity : 1}" min="0.2" max="1" step="0.05"></label>
      <button type="button" class="btn btn-sm btn-primary" id="sdsym-save">${t('a.save')}</button>
    </div>`;
  document.getElementById('sdsym-save').addEventListener('click', async () => {
    await api.updateSamplingDesign(r.design_id, { symbology: {
      shape: document.getElementById('sdsym-shape').value,
      size: Number(document.getElementById('sdsym-size').value) || 7,
      color: document.getElementById('sdsym-color').value,
      outline_color: document.getElementById('sdsym-outline').value,
      opacity: Number(document.getElementById('sdsym-opacity').value),
    }});
    box.style.display = 'none';
    refresh();
  });
}

export async function mountSamplingDesign() {
  const root = document.getElementById('sampling-root');
  if (!root) return;
  if (!mounted) {
    const sources = await api.samplingSources();
    root.innerHTML = markup(sources);
    mounted = true;
    document.getElementById('sd-run').addEventListener('click', async () => {
      const status = document.getElementById('sd-status');
      const num = (id) => Number(document.getElementById(id).value) || undefined;
      const payload = {
        name: document.getElementById('sd-name').value.trim(),
        params: {
          n_psu: num('sd-n-psu'), ssu_per_psu: num('sd-ssu'),
          pts_per_ssu: num('sd-pts'), psu_size_m: num('sd-psu-size'),
          ssu_size_m: num('sd-ssu-size'), seed: num('sd-seed'),
          cropland_only: document.getElementById('sd-cropland').checked,
        },
        source_ids: [...document.querySelectorAll('.sd-source:checked')].map((c) => c.value),
      };
      status.textContent = t('a.st.queuing');
      try {
        await api.createSamplingDesign(payload);
        status.textContent = t('a.sd.queued');
        refresh();
      } catch (err) { status.textContent = err.message; }
    });
  }
  refresh();
}
