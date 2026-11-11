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
import { formatSamplingMeta } from './sampling-meta.js';
import Map from 'ol/Map';
import View from 'ol/View';
import { Tile as TileLayer, Vector as VectorLayer } from 'ol/layer';
import { OSM, Vector as VectorSource } from 'ol/source';
import Draw from 'ol/interaction/Draw';
import { toLonLat, transformExtent } from 'ol/proj';
import { Fill, Stroke, Style } from 'ol/style';

let mounted = false;
let pollTimer = null;
let openLogId = null;   // design whose log is open — kept live while runs poll
let openSymId = null;   // design whose symbology editor is open (toggle)

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
    <div class="admin-section" style="max-width:1150px;">
      <h3 class="admin-section-title">${t('a.sd.title')}</h3>
      <p style="color:var(--color-text-muted);font-size:var(--fs-sm);margin:0 0 var(--sp-3);">${t('a.sd.intro')}
        <a href="https://github.com/un-fao/SoilFER/tree/main/sampling%20design" target="_blank" rel="noopener">un-fao/SoilFER · sampling design</a></p>

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
        <label title="${t('a.sd.bboxTip')}">${t('a.sd.bbox')}</label>
        <div style="grid-column:2 / span 3;display:flex;gap:6px;">
          <input type="text" id="sd-bbox" placeholder="-102.1, 36.9, -94.6, 40.0" style="flex:1;">
          <button type="button" class="btn btn-sm" id="sd-bbox-draw">${t('a.sd.drawBbox')}</button>
        </div>
        <label>${t('a.sd.croplandOnly')}</label>
        <input type="checkbox" id="sd-cropland" checked style="justify-self:start;">
      </div>

      <div id="sd-bbox-map" style="display:none;height:320px;max-width:620px;margin-top:var(--sp-3);border:1px solid var(--color-border-strong);border-radius:6px;"></div>

      <div style="display:flex;align-items:center;gap:var(--sp-3);margin-top:var(--sp-4);">
        <button type="button" class="btn btn-primary" id="sd-run">${t('a.sd.run')}</button>
        <span id="sd-status" style="font-size:var(--fs-sm);"></span>
      </div>

      <h4 style="margin:var(--sp-5) 0 var(--sp-2);">${t('a.sd.designs')}</h4>
      <div id="sd-list" style="font-size:var(--fs-sm);overflow-x:auto;">${t('a.loading')}</div>
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
          background:${e((sym.point && sym.point.color) || sym.color || '#d97706')};cursor:pointer;"></button>`;
      return `
      <tr data-id="${r.design_id}">
        <td>${r.design_id}</td>
        <td style="white-space:nowrap;"><span class="sd-name" data-id="${r.design_id}" style="cursor:text;border-bottom:1px dashed var(--color-border-strong);" title="${t('a.sd.renameTip')}">${e(r.name)}</span></td>
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
  el.querySelectorAll('.sd-name').forEach((sp) => sp.addEventListener('click', () => {
    if (sp.querySelector('input')) return;
    const id = Number(sp.dataset.id);
    const current = sp.textContent;
    sp.innerHTML = `<input type="text" value="${e(current)}" maxlength="120" style="width:160px;">`;
    const inp = sp.querySelector('input');
    inp.focus(); inp.select();
    const finish = async (save) => {
      const val = inp.value.trim();
      if (save && val && val !== current) {
        try { await api.updateSamplingDesign(id, { name: val }); }
        catch (err) { document.getElementById('sd-status').textContent = err.message; }
      }
      refresh();
    };
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(true));
  }));

  el.querySelectorAll('.sd-toggle').forEach((b) => b.addEventListener('click', async () => {
    await api.updateSamplingDesign(Number(b.dataset.id),
      { [b.dataset.field]: b.dataset.value === '1' });
    refresh();
  }));
  el.querySelectorAll('.sd-meta').forEach((b) => b.addEventListener('click', async () => {
    const d = await api.getSamplingDesign(Number(b.dataset.id));
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `<div style="background:var(--color-surface);color:var(--color-text);border-radius:8px;max-width:720px;max-height:82vh;overflow:auto;padding:22px 26px;">${formatSamplingMeta(d.name, d.manifest, d.abstract)}</div>`;
    modal.addEventListener('click', (ev) => { if (ev.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  }));
  el.querySelectorAll('.sd-sym').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.id);
    const box = document.getElementById('sd-sym-editor');
    if (openSymId === id && box && box.style.display !== 'none') {
      box.style.display = 'none';
      openSymId = null;
      return;
    }
    openSymId = id;
    openSymEditor(rows.find((x) => x.design_id === id));
  }));
  el.querySelectorAll('.sd-log-btn').forEach((b) => b.addEventListener('click', async () => {
    const id = Number(b.dataset.id);
    if (openLogId === id) {
      // Second press on the same design: hide the log.
      openLogId = null;
      const pre = document.getElementById('sd-log');
      if (pre) { pre.style.display = 'none'; pre.textContent = ''; }
      return;
    }
    openLogId = id;
    await showLog(openLogId);
  }));

  // Keep an open log following the run — and refresh it one final time
  // when polling stops, so the tail ("Design complete") is never missed.
  if (openLogId != null) showLog(openLogId);

  const active = rows.some((r) => r.status === 'queued' || r.status === 'running');
  clearTimeout(pollTimer);
  if (active) pollTimer = setTimeout(refresh, 5000);
}

async function showLog(id) {
  const pre = document.getElementById('sd-log');
  if (!pre) return;
  try {
    const d = await api.getSamplingDesign(id);
    pre.style.display = 'block';
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.textContent = (d.step_log || '') +
      (d.manifest ? '\n--- manifest ---\n' + JSON.stringify(d.manifest, null, 2) : '');
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch (e) { /* design may have been deleted */ }
}

function symDefaults(sym) {
  // Accepts both the legacy flat form ({shape,size,color,...}) and the
  // structured per-layer form; always returns the structured one.
  sym = sym || {};
  const base = { shape: sym.shape || 'circle', size: sym.size || 7,
                 color: sym.color || '#d97706',
                 opacity: sym.opacity != null ? sym.opacity : 1 };
  const cell = sym.outline_color || base.color;
  return {
    point: { ...base, ...(sym.point || {}) },
    replacement: { shape: base.shape, size: Math.max(3, base.size - 3),
                   color: base.color, opacity: base.opacity * 0.45,
                   ...(sym.replacement || {}) },
    psu: { color: cell, width: 2, opacity: 0.9, style: 'solid',
           ...(sym.psu || {}) },
    ssu: { color: cell, width: 1, opacity: 0.7, style: 'dashed',
           ...(sym.ssu || {}) },
  };
}

function openSymEditor(r) {
  const box = document.getElementById('sd-sym-editor');
  const sym = symDefaults(r.symbology);
  box.style.display = 'block';
  setTimeout(() => box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  const shapeSel = (id, v) => `<select id="${id}">` +
    ['circle', 'square', 'triangle'].map((x) =>
      `<option value="${x}" ${v === x ? 'selected' : ''}>${x}</option>`).join('') + '</select>';
  const styleSel = (id, v) => `<select id="${id}">` +
    [['solid', t('a.stroke.solid')], ['dashed', t('a.stroke.dashed')], ['dotted', t('a.stroke.dotted')]]
      .map(([x, lbl]) => `<option value="${x}" ${v === x ? 'selected' : ''}>${lbl}</option>`).join('') + '</select>';
  const pointRow = (key, label) => `
    <tr><th style="text-align:left;">${label}</th>
      <td>${shapeSel(`sdsym-${key}-shape`, sym[key].shape)}</td>
      <td><input type="number" id="sdsym-${key}-size" value="${sym[key].size}" min="2" max="24" style="width:58px;"></td>
      <td><input type="color" id="sdsym-${key}-color" value="${sym[key].color}"></td>
      <td><input type="range" id="sdsym-${key}-opacity" value="${sym[key].opacity}" min="0.1" max="1" step="0.05"></td></tr>`;
  const cellRow = (key, label) => `
    <tr><th style="text-align:left;">${label}</th>
      <td>${styleSel(`sdsym-${key}-style`, sym[key].style)}</td>
      <td><input type="number" id="sdsym-${key}-width" value="${sym[key].width}" min="1" max="8" style="width:58px;"></td>
      <td><input type="color" id="sdsym-${key}-color" value="${sym[key].color}"></td>
      <td><input type="range" id="sdsym-${key}-opacity" value="${sym[key].opacity}" min="0.1" max="1" step="0.05"></td></tr>`;
  box.innerHTML = `
    <div style="padding:var(--sp-2) 0;border-top:1px solid var(--color-border);margin-top:var(--sp-2);">
      <strong>#${r.design_id} · ${t('a.sd.symbology')}</strong>
      <table style="border-collapse:separate;border-spacing:10px 4px;">
        <tr><th></th>
          <th style="font-weight:normal;">${t('a.sd.symShape')} / ${t('a.strokeType')}</th>
          <th style="font-weight:normal;">${t('a.sd.symSize')} / ${t('a.strokeWidth')}</th>
          <th style="font-weight:normal;">${t('a.sd.symColour')}</th>
          <th style="font-weight:normal;">${t('a.sd.symOpacity')}</th></tr>
        ${pointRow('point', t('a.sd.symPoints'))}
        ${pointRow('replacement', t('a.sd.symRepl'))}
        ${cellRow('psu', t('a.sd.symPsu'))}
        ${cellRow('ssu', t('a.sd.symSsu'))}
      </table>
      <button type="button" class="btn btn-sm btn-primary" id="sdsym-save">${t('a.save')}</button>
    </div>`;
  document.getElementById('sdsym-save').addEventListener('click', async () => {
    const v = (id) => document.getElementById(id).value;
    const n = (id) => Number(v(id));
    const status = document.getElementById('sd-status');
    try {
      const sym2 = {
      point: { shape: v('sdsym-point-shape'), size: n('sdsym-point-size'),
               color: v('sdsym-point-color'), opacity: n('sdsym-point-opacity') },
      replacement: { shape: v('sdsym-replacement-shape'), size: n('sdsym-replacement-size'),
                     color: v('sdsym-replacement-color'), opacity: n('sdsym-replacement-opacity') },
      psu: { style: v('sdsym-psu-style'), width: n('sdsym-psu-width'),
             color: v('sdsym-psu-color'), opacity: n('sdsym-psu-opacity') },
      ssu: { style: v('sdsym-ssu-style'), width: n('sdsym-ssu-width'),
             color: v('sdsym-ssu-color'), opacity: n('sdsym-ssu-opacity') },
      };
      await api.updateSamplingDesign(r.design_id, { symbology: sym2 });
      status.textContent = t('a.sd.symSaved');
      box.style.display = 'none';
      openSymId = null;
      // Restyle the live map layer immediately — no page reload needed.
      window.dispatchEvent(new CustomEvent('sampling:symbology', {
        detail: { design_id: r.design_id, symbology: sym2 } }));
      refresh();
    } catch (err) {
      status.textContent = err.message;
    }
  });
}

let bboxMap = null;
let regionPolygon = null;   // [[lon,lat],...] drawn on the mini-map (closed ring)

function toggleBboxDrawer() {
  const div = document.getElementById('sd-bbox-map');
  if (div.style.display !== 'none') { div.style.display = 'none'; return; }
  div.style.display = 'block';
  if (!bboxMap) {
    div.style.position = 'relative';
    const source = new VectorSource();
    const rectLayer = new VectorLayer({
      source,
      style: new Style({
        stroke: new Stroke({ color: '#d97706', width: 2 }),
        fill: new Fill({ color: 'rgba(217, 119, 6, 0.08)' }),
      }),
    });
    bboxMap = new Map({
      target: div,
      layers: [new TileLayer({ source: new OSM() }), rectLayer],
      view: new View({ center: [0, 0], zoom: 2 }),
    });
    const draw = new Draw({ source, type: 'Polygon' });
    draw.on('drawstart', () => source.clear());
    draw.on('drawend', (ev) => {
      // The drawn polygon IS the region (intersected exactly server-side);
      // the text field shows its bounding box for reference.
      regionPolygon = ev.feature.getGeometry().getCoordinates()[0]
        .map((c) => toLonLat(c).map((v) => Number(v.toFixed(5))));
      const ext = transformExtent(ev.feature.getGeometry().getExtent(),
                                  'EPSG:3857', 'EPSG:4326');
      document.getElementById('sd-bbox').value =
        ext.map((v) => v.toFixed(4)).join(', ');
    });
    bboxMap.addInteraction(draw);
    // A manually edited bbox overrides the drawn polygon.
    document.getElementById('sd-bbox').addEventListener('input', () => {
      regionPolygon = null;
      source.clear();
    });
    // Erase button over the map: removes the drawn polygon and the region.
    const eraseBtn = document.createElement('button');
    eraseBtn.type = 'button';
    eraseBtn.className = 'btn btn-sm';
    eraseBtn.textContent = t('a.sd.erase');
    eraseBtn.style.cssText = 'position:absolute;top:8px;right:8px;z-index:10;';
    eraseBtn.addEventListener('click', () => {
      source.clear();
      regionPolygon = null;
      document.getElementById('sd-bbox').value = '';
    });
    div.appendChild(eraseBtn);
  }
  setTimeout(() => bboxMap.updateSize(), 50);
}

export async function mountSamplingDesign() {
  const root = document.getElementById('sampling-root');
  if (!root) return;
  if (!mounted) {
    const sources = await api.samplingSources();
    root.innerHTML = markup(sources);
    mounted = true;
    document.getElementById('sd-bbox-draw').addEventListener('click', toggleBboxDrawer);
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
          bbox: (() => {
            const parts = document.getElementById('sd-bbox').value
              .split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
            return parts.length === 4 ? parts : undefined;
          })(),
          region_polygon: regionPolygon || undefined,
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
