/**
 * Database tab (Admin Panel) — the soil profile data as it sits in the
 * database: plots / profiles, horizons, analytical values and the field
 * description (FAO Guidelines for Soil Description code lists).
 *
 * Three views over one selection (project + profile-code search):
 *   Profiles  one row per profile, with the site description
 *   Horizons  one row per horizon, with analytical and descriptive columns
 *   Form      one profile at a time, with photographs, a location map, a
 *             to-scale profile sketch and the report (print / save as PDF)
 *
 * Editing needs Edit mode and the permission to edit (administrators, or an
 * account an administrator marked as data editor). Nothing is written while
 * typing: edits are collected, in the tables and in the form alike, and go to
 * the database together when Save is pressed; Cancel drops them.
 */
import api from './api-client.js';
import { t } from './i18n.js';
import OlMap from 'ol/Map';   // not "Map": the built-in Map is used below
import View from 'ol/View';
import { Tile as TileLayer, Vector as VectorLayer } from 'ol/layer';
import { OSM, Vector as VectorSource } from 'ol/source';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { fromLonLat, toLonLat } from 'ol/proj';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style';

const e = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  view: 'plots',          // plots | elements | form
  project: '',
  q: '',
  sort: 'plot_code',
  dir: 'asc',
  page: 0,
  pageSize: 50,
  edit: false,
  rows: [],
  total: 0,
  data: null,             // last table response (column sets)
  record: null,           // form: the profile on screen
  formTotal: 0,
  formOffset: 0,
  selEl: null,            // form: selected horizon (element_id)
  pending: new Map(),     // form: unsaved changes, keyed
  showAll: false,         // form, edit mode: list every property, not only the filled ones
  extra: new Set(),       // form, edit mode: empty properties the user asked to fill in
  extraObs: new Set(),    // form, edit mode: analytical columns added but still empty
  colMenu: null,          // which table's column chooser is open
  changed: new Set(),     // tables: "<row id>:<column key>" of cells edited but not saved
};
let M = null;             // meta + indexes
let mounted = false;
let formMap = null;
let searchTimer = null;
const photoUrls = new Map();   // "<id>:<size>" → object URL

// ---- code lists -----------------------------------------------------------

const GROUPS = {
  plot: [
    ['landuse', /^(landUse|crop|vegetation|humanInfluence)/i],
    ['landform', /^(majorLandForm|landformComplex|physiography|slope)/i],
    ['parent', /^(geology|lithology|parent|surfaceAge|weatheringRock)/i],
    ['erosion', /^erosion/i],
    ['outcrops', /^(rockOutcrops|weatheringFragments)/i],
    ['weather', /^weatherConditions/i],
    ['other', /./],
  ],
  surface: [['surface', /./]],
  profile: [['profile', /./]],
  element: [
    ['boundary', /^boundary/i],
    ['structure', /^structure/i],
    ['consistence', /^(consistence|stickiness|plasticity)/i],
    ['mottles', /^mottles/i],
    ['coatings', /^coating/i],
    ['cementation', /^cementation/i],
    ['pores', /^(pores|porosity|voids)/i],
    ['roots', /^(roots|biological)/i],
    ['fragments', /^(rock|fragment|weatheringFragments|mineralFragments)/i],
    ['concentrations', /^mineralConc/i],
    ['carbonates', /^(carbonates|gypsum|salt)/i],
    ['texture', /^(sandyTexture|bulkDensity)/i],
    ['peat', /^peat/i],
    ['surface', /^(cracks|bleachedSand)/i],
    ['other', /./],
  ],
};

function indexMeta(meta) {
  M = meta;
  M.prop = {};
  M.cat = {};
  M.byLevel = { plot: [], surface: [], profile: [], element: [] };
  meta.desc_properties.forEach((p) => {
    M.prop[p.id] = p;
    p.categories.forEach((c) => { M.cat[c.id] = c; });
    p.levels.forEach((l) => M.byLevel[l].push(p));
  });
  M.obs = {};
  meta.observations.forEach((o) => { M.obs[o.observation_num_id] = o; });
}

const propName = (id) => (M.prop[id] ? M.prop[id].name : id);
// Some code-list names repeat their own code ("F Fine"): shown without it.
function catName(c) {
  const name = (c.name || '').trim();
  const code = (c.code || '').trim();
  if (code && name.length > code.length + 1 && name.startsWith(`${code} `)) return name.slice(code.length + 1).trim();
  return name || code;
}
function catLabel(id) {
  const c = M.cat[id];
  if (!c) return id || '';
  const name = catName(c);
  return c.code && c.code !== name ? `${c.code} – ${name}` : (name || id);
}
const catShort = (id) => (M.cat[id] ? catName(M.cat[id]) : (id || ''));
const catCode = (id) => (M.cat[id] ? (M.cat[id].code || '') : '');
function obsLabel(id) {
  const o = M.obs[id];
  return o ? (o.property_name || o.property_num_id) : `#${id}`;
}
const obsSub = (id) => {
  const o = M.obs[id];
  return o ? `${o.procedure_num_id} · ${o.unit_of_measure_id}` : '';
};
function obsLabels(ids) {
  const count = {};
  ids.forEach((id) => { const n = obsLabel(id); count[n] = (count[n] || 0) + 1; });
  const out = {};
  ids.forEach((id) => {
    const n = obsLabel(id);
    out[id] = count[n] > 1 ? `${n} (${M.obs[id].procedure_num_id})` : n;
  });
  return out;
}
// Depth plots in the report: the properties soil surveyors look at first.
const PLOT_FIRST = ['PH', 'ORGCAR', 'ORGMAT', 'TEXTCLAY', 'TEXTSAND', 'TEXTSILT', 'CEC', 'ELECCOND', 'NITTOT'];
function plotRank(id) {
  const pid = M.obs[id].property_num_id || '';
  const i = PLOT_FIRST.findIndex((p) => pid.startsWith(p));
  return i === -1 ? PLOT_FIRST.length : i;
}
const obsFull = (o) => `${o.property_name || o.property_num_id} — ${o.procedure_num_id} (${o.unit_of_measure_id})`;

function fmtNum(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') return v;           // censored marker
  return String(Number(Number(v).toPrecision(6)));
}
const fmtCoord = (v) => (v === null || v === undefined ? '' : Number(v).toFixed(6));
const depths = (el) => `${el.upper_depth}–${el.lower_depth} cm`;

function groupProps(level, props) {
  const out = [];
  const taken = new Set();
  GROUPS[level].forEach(([name, re]) => {
    const list = props.filter((p) => !taken.has(p.id) && re.test(p.id));
    list.forEach((p) => taken.add(p.id));
    if (list.length) out.push([name, list]);
  });
  return out;
}

// ---- status ---------------------------------------------------------------

let statusSeq = 0;
function status(msg, kind) {
  const el = document.getElementById('pdb-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = `pdb-status${kind ? ` pdb-status-${kind}` : ''}`;
  statusSeq += 1;
  if (msg && kind === 'ok') {
    // Confirmations fade; a later message is never wiped by an older timer.
    const mine = statusSeq;
    setTimeout(() => { if (statusSeq === mine) el.textContent = ''; }, 3500);
  }
}

const canEdit = () => !!(M && M.can_edit);
const editing = () => canEdit() && S.edit;
const dirty = () => S.pending.size > 0;

// ---- show / hide columns (remembered in this browser) ---------------------

const FIXED_COLS = { plots: ['plot_code'], elements: ['plot_code'] };
const hiddenSets = {};
function hiddenCols(table) {
  if (!hiddenSets[table]) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(`sis_pdb_cols_${table}`) || '[]'); } catch (err) { /* private mode */ }
    hiddenSets[table] = new Set(Array.isArray(list) ? list : []);
  }
  return hiddenSets[table];
}
function setHidden(table, key, hide) {
  const set = hiddenCols(table);
  if (key === null) set.clear();
  else if (hide) set.add(key);
  else set.delete(key);
  try { localStorage.setItem(`sis_pdb_cols_${table}`, JSON.stringify([...set])); } catch (err) { /* private mode */ }
}
function columnChooser(table, cols) {
  const hid = hiddenCols(table);
  const n = cols.filter((c) => hid.has(c.key)).length;
  return `<div class="pdb-colpick" data-table="${table}">
    <button type="button" class="btn btn-sm pdb-colpick-btn">${t('a.db.columns')}${
      n ? ` <span class="pdb-colpick-n">${t('a.db.columnsHidden', { n })}</span>` : ''}</button>
    <div class="pdb-colpick-menu"${S.colMenu === table ? '' : ' hidden'}>
      <button type="button" class="pdb-colpick-all" data-col-all ${n ? '' : 'disabled'}>${t('a.db.showAllCols')}</button>
      ${cols.map((c) => `<label><input type="checkbox" data-col-toggle="${e(c.key)}" ${hid.has(c.key) ? '' : 'checked'}>
        <span>${e(c.label)}${c.sub ? `<small>${e(c.sub)}</small>` : ''}</span></label>`).join('')}
    </div>
  </div>`;
}
// Re-render while the chooser is open without losing its scroll position.
function keepMenuScroll(render) {
  const before = document.querySelector('.pdb-colpick-menu:not([hidden])');
  const top = before ? before.scrollTop : 0;
  render();
  const after = document.querySelector('.pdb-colpick-menu:not([hidden])');
  if (after) after.scrollTop = top;
}

function leaveGuard() {
  if (!dirty()) return true;
  if (!confirm(t('a.db.discardConfirm'))) return false;
  S.pending.clear();
  S.changed.clear();
  return true;
}

// Edits wait here until Save. Changes to the same plot, horizon or sample
// are merged into one, so that e.g. both depths of a horizon are written
// together (changing them one after the other could break "lower > upper").
function queueChange(ch) {
  if (ch.kind === 'desc') {
    S.pending.set(`desc:${ch.level}:${ch.object_id}:${ch.property_desc_id}`, ch);
  } else if (ch.kind === 'num') {
    S.pending.set(`num:${ch.element_id}:${ch.observation_num_id}`, ch);
  } else {
    const key = `${ch.kind}:${ch.kind === 'plot' ? ch.plot_id : ch.element_id}`;
    const cur = S.pending.get(key);
    if (cur) Object.assign(cur.values, ch.values);
    else S.pending.set(key, ch);
  }
}

// ---- shell ----------------------------------------------------------------

function shell() {
  const opts = M.projects.map((p) =>
    `<option value="${e(p.project_id)}">${e(p.name || p.project_id)} (${p.profiles})</option>`).join('');
  return `
    <div class="admin-section pdb">
      <h3 class="admin-section-title">${t('a.db.title')}</h3>
      <p class="pdb-intro">${t('a.db.intro')}</p>
      <div class="pdb-toolbar">
        <select id="pdb-project" title="${t('a.db.project')}">
          <option value="">${t('a.db.allProjects')}</option>${opts}
        </select>
        <input type="search" id="pdb-q" placeholder="${t('a.db.search')}" autocomplete="off">
        <div class="pdb-views" role="tablist">
          <button type="button" data-view="plots">${t('a.db.viewProfiles')}</button>
          <button type="button" data-view="elements">${t('a.db.viewHorizons')}</button>
          <button type="button" data-view="form">${t('a.db.viewForm')}</button>
        </div>
        <span class="pdb-spacer"></span>
        ${canEdit() ? `
          <div class="pdb-mode" role="group" aria-label="${t('a.db.editMode')}" title="${t('a.db.editTip')}">
            <button type="button" data-mode="view">${t('a.db.modeView')}</button>
            <button type="button" data-mode="edit">${t('a.edit')}</button>
          </div>
          <button type="button" class="btn btn-sm" id="pdb-new" style="display:none;">${t('a.db.newProfile')}</button>`
        : `<span class="pdb-readonly" title="${t('a.db.readOnlyTip')}">${t('a.db.readOnly')}</span>`}
      </div>
      <div id="pdb-status" class="pdb-status"></div>
      <div id="pdb-body"></div>
      <div id="pdb-savebar" class="pdb-savebar" hidden>
        <span id="pdb-savebar-n"></span>
        <span class="pdb-spacer"></span>
        <button type="button" class="btn btn-sm" id="pdb-cancel">${t('a.cancel')}</button>
        <button type="button" class="btn btn-sm btn-primary" id="pdb-save">${t('a.save')}</button>
      </div>
      <datalist id="pdb-obs-list">${M.observations.map((o) => `<option value="${e(obsFull(o))}"></option>`).join('')}</datalist>
    </div>`;
}

function syncToolbar() {
  document.querySelectorAll('.pdb-views button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === S.view));
  document.querySelectorAll('.pdb-mode button').forEach((b) =>
    b.classList.toggle('active', (b.dataset.mode === 'edit') === editing()));
  const nw = document.getElementById('pdb-new');
  if (nw) nw.style.display = editing() ? '' : 'none';
  const root = document.querySelector('.pdb');
  if (root) root.classList.toggle('pdb-editing', editing());
  markDirty();
}

async function refresh() {
  syncToolbar();
  try {
    if (S.view === 'form') await loadForm({ offset: S.formOffset });
    else await loadTable();
  } catch (err) {
    status(err.message, 'err');
  }
}

// ---- tables ---------------------------------------------------------------

function plotColumns() {
  const cols = [
    { key: 'plot_code', label: t('a.db.code'), sort: 'plot_code', kind: 'text', cls: 'pdb-strong',
      get: (r) => r.plot_code, change: (r, v) => ({ kind: 'plot', plot_id: r.plot_id, values: { plot_code: v } }) },
    { key: 'project_id', label: t('a.db.project'), get: (r) => r.project_id },
    { key: 'type', label: t('a.db.type'), sort: 'type', kind: 'select', options: M.plot_types,
      get: (r) => r.type, change: (r, v) => ({ kind: 'plot', plot_id: r.plot_id, values: { type: v } }) },
    { key: 'sampling_date', label: t('a.db.date'), sort: 'sampling_date', kind: 'date',
      get: (r) => r.sampling_date, change: (r, v) => ({ kind: 'plot', plot_id: r.plot_id, values: { sampling_date: v } }) },
    { key: 'longitude', label: t('a.db.lon'), kind: 'num', num: true, fmt: fmtCoord,
      get: (r) => r.longitude, change: (r, v) => ({ kind: 'plot', plot_id: r.plot_id, values: { longitude: v } }) },
    { key: 'latitude', label: t('a.db.lat'), kind: 'num', num: true, fmt: fmtCoord,
      get: (r) => r.latitude, change: (r, v) => ({ kind: 'plot', plot_id: r.plot_id, values: { latitude: v } }) },
    { key: 'altitude', label: t('a.db.altitude'), sort: 'altitude', kind: 'num', num: true,
      get: (r) => r.altitude, change: (r, v) => ({ kind: 'plot', plot_id: r.plot_id, values: { altitude: v } }) },
    { key: 'positional_accuracy', label: t('a.db.accuracy'), kind: 'num', num: true,
      get: (r) => r.positional_accuracy,
      change: (r, v) => ({ kind: 'plot', plot_id: r.plot_id, values: { positional_accuracy: v } }) },
    { key: 'horizons', label: t('a.db.horizons'), num: true, get: (r) => r.horizons },
    { key: 'photos', label: t('a.db.photos'), num: true, get: (r) => r.photos || '' },
  ];
  const dc = (S.data && S.data.desc_columns) || {};
  ['plot', 'surface', 'profile'].forEach((level) => {
    (dc[level] || []).forEach((pid) => {
      if (!M.prop[pid]) return;
      cols.push({
        key: `d:${level}:${pid}`, label: propName(pid),
        sub: level === 'plot' ? '' : t(`a.db.level.${level}`),
        kind: level === 'profile' ? null : 'desc', prop: pid,
        get: (r) => r.desc[level][pid] || null, fmt: catShort, tip: catLabel,
        set: (r, v) => { if (v) r.desc[level][pid] = v; else delete r.desc[level][pid]; },
        change: (r, v) => ({ kind: 'desc', level, object_id: r.plot_id,
                             property_desc_id: pid, category_desc_id: v }),
      });
    });
  });
  return cols;
}

function elementColumns() {
  const elc = (field) => (r, v) => ({ kind: 'element', element_id: r.element_id, values: { [field]: v } });
  const spc = (field) => (r, v) => ({ kind: 'specimen', element_id: r.element_id, values: { [field]: v } });
  const cols = [
    { key: 'plot_code', label: t('a.db.code'), cls: 'pdb-strong', get: (r) => r.plot_code },
    { key: 'horizon', label: t('a.db.horizon'), kind: 'text', get: (r) => r.horizon, change: elc('horizon') },
    { key: 'upper_depth', label: t('a.db.upper'), kind: 'num', num: true, wrap: true, get: (r) => r.upper_depth, change: elc('upper_depth') },
    { key: 'lower_depth', label: t('a.db.lower'), kind: 'num', num: true, wrap: true, get: (r) => r.lower_depth, change: elc('lower_depth') },
    { key: 'type', label: t('a.db.type'), kind: 'select', options: M.element_types, required: true,
      get: (r) => r.type, change: elc('type') },
    { key: 'sample_field_id', label: t('a.db.fieldId'), kind: 'text', get: (r) => r.sample_field_id, change: spc('sample_field_id') },
    { key: 'sample_lab_id', label: t('a.db.labId'), kind: 'text', get: (r) => r.sample_lab_id, change: spc('sample_lab_id') },
  ];
  const nums = ((S.data && S.data.num_columns) || []).filter((id) => M.obs[id])
    .sort((a, b) => obsLabel(a).localeCompare(obsLabel(b)) || a - b);
  nums.forEach((id) => {
    cols.push({
      key: `n:${id}`, label: obsLabel(id), sub: obsSub(id), kind: 'obs', num: true,
      get: (r) => (r.num[id] === undefined ? null : r.num[id]), fmt: fmtNum,
      set: (r, v) => { if (v === null) delete r.num[id]; else r.num[id] = v; },
      change: (r, v) => ({ kind: 'num', element_id: r.element_id, observation_num_id: id, value: v }),
    });
  });
  ((S.data && S.data.desc_columns) || []).forEach((pid) => {
    if (!M.prop[pid]) return;
    cols.push({
      key: `d:${pid}`, label: propName(pid), kind: 'desc', prop: pid,
      get: (r) => r.desc[pid] || null, fmt: catShort, tip: catLabel,
      set: (r, v) => { if (v) r.desc[pid] = v; else delete r.desc[pid]; },
      change: (r, v) => ({ kind: 'desc', level: 'element', object_id: r.element_id,
                           property_desc_id: pid, category_desc_id: v }),
    });
  });
  return cols;
}

let COLS = [];

function cellHtml(row, col) {
  const v = col.get(row);
  const txt = v === null || v === undefined ? '' : (col.fmt ? col.fmt(v) : String(v));
  const tip = col.tip && v ? ` title="${e(col.tip(v))}"` : '';
  return `<span${tip}>${e(txt)}</span>`;
}

async function loadTable() {
  const body = document.getElementById('pdb-body');
  if (!body) return;
  const params = { project_id: S.project, q: S.q, limit: S.pageSize, offset: S.page * S.pageSize };
  let data;
  if (S.view === 'plots') {
    data = await api.pdbPlots({ ...params, sort: S.sort, dir: S.dir });
  } else {
    data = await api.pdbElements(params);
  }
  // A filter change can leave the page past the end: step back once.
  if (!data.rows.length && data.total > 0 && S.page > 0) {
    S.page = Math.max(0, Math.ceil(data.total / S.pageSize) - 1);
    return loadTable();
  }
  S.data = data;
  S.rows = data.rows;
  S.total = data.total;
  COLS = S.view === 'plots' ? plotColumns() : elementColumns();
  renderTable();
}

function renderTable() {
  const body = document.getElementById('pdb-body');
  if (!S.total) {
    body.innerHTML = `<div class="empty-state">${t('a.db.none')}</div>`;
    return;
  }
  const ed = editing();
  const fixed = FIXED_COLS[S.view];
  const hid = hiddenCols(S.view);
  // [column, its index in COLS]: cells keep the index so editing finds the column.
  const shown = COLS.map((c, j) => [c, j]).filter(([c]) => fixed.includes(c.key) || !hid.has(c.key));
  const head = shown.map(([c]) => {
    const sortable = S.view === 'plots' && c.sort;
    const arrow = sortable && S.sort === c.sort ? (S.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="${c.num ? 'pdb-num' : ''}${sortable ? ' pdb-sortable' : ''}${c.wrap ? ' pdb-th-wrap' : ''}"${sortable ? ` data-sort="${c.sort}"` : ''}>
      ${e(c.label)}${arrow}${c.sub ? `<small>${e(c.sub)}</small>` : ''}</th>`;
  }).join('');
  const rows = S.rows.map((r, i) => `<tr data-i="${i}">
      <td class="pdb-open"><button type="button" class="pdb-open-btn" data-i="${i}" title="${t('a.db.openForm')}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </button></td>` +
      shown.map(([c, j]) => `<td data-c="${j}" class="${c.num ? 'pdb-num ' : ''}${c.cls || ''}${ed && c.kind ? ' pdb-editable' : ''}${S.changed.has(`${rowId(r)}:${c.key}`) ? ' pdb-changed' : ''}">${cellHtml(r, c)}</td>`).join('')
      + '</tr>').join('');
  const from = S.page * S.pageSize + 1;
  const to = Math.min(S.total, from + S.rows.length - 1);
  const pages = Math.ceil(S.total / S.pageSize);
  body.innerHTML = `
    <div class="pdb-tablebar">
      <span class="pdb-spacer"></span>
      ${columnChooser(S.view, COLS.filter((c) => !fixed.includes(c.key)))}
    </div>
    <div class="pdb-table-wrap">
      <table class="admin-table pdb-table">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="pdb-pager">
      <span>${t('a.db.range', { from, to, total: S.total })}</span>
      <button type="button" class="btn btn-sm" id="pdb-prev" ${S.page === 0 ? 'disabled' : ''}>‹</button>
      <span>${S.page + 1} / ${pages}</span>
      <button type="button" class="btn btn-sm" id="pdb-next" ${S.page >= pages - 1 ? 'disabled' : ''}>›</button>
      ${ed ? `<span class="pdb-hint">${t('a.db.cellHint')}</span>` : ''}
    </div>`;
  document.getElementById('pdb-prev').addEventListener('click', () => { if (leaveGuard()) { S.page -= 1; refresh(); } });
  document.getElementById('pdb-next').addEventListener('click', () => { if (leaveGuard()) { S.page += 1; refresh(); } });
  markDirty();
}

// A table row is a plot (Profiles view) or a horizon (Horizons view).
const rowId = (r) => (S.view === 'plots' ? r.plot_id : r.element_id);

function parseCell(col, raw) {
  const s = String(raw ?? '').trim();
  if (col.kind === 'num') {
    if (s === '') return null;
    const n = Number(s.replace(',', '.'));
    if (Number.isNaN(n)) throw new Error(t('a.db.notNumber', { value: s }));
    return n;
  }
  if (col.kind === 'obs') {
    if (s === '') return null;
    if (M.censored.includes(s.toUpperCase())) return s.toUpperCase();
    const n = Number(s.replace(',', '.'));
    if (Number.isNaN(n)) throw new Error(t('a.db.notNumber', { value: s }));
    return n;
  }
  return s === '' ? null : s;
}

function startCellEdit(td) {
  if (td.querySelector('input,select')) return;
  const row = S.rows[Number(td.parentElement.dataset.i)];
  const col = COLS[Number(td.dataset.c)];
  if (!row || !col || !col.kind) return;
  const cur = col.get(row);
  let input;
  if (col.kind === 'select' || col.kind === 'desc') {
    input = document.createElement('select');
    const options = col.kind === 'desc'
      ? M.prop[col.prop].categories.map((c) => [c.id, catLabel(c.id)])
      : col.options.map((o) => [o, o]);
    if (!col.required) input.add(new Option('', ''));
    options.forEach(([val, label]) => input.add(new Option(label, val)));
    input.value = cur || '';
  } else {
    input = document.createElement('input');
    input.type = col.kind === 'date' ? 'date' : 'text';
    input.value = cur === null || cur === undefined ? '' : String(cur);
  }
  input.className = 'pdb-cell-input';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  if (input.select) input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    let val;
    try {
      val = save ? parseCell(col, input.value) : cur;
    } catch (err) {
      status(err.message, 'err');
      td.innerHTML = cellHtml(row, col);
      return;
    }
    const same = (val ?? null) === (cur ?? null)
      || (typeof val === 'number' && typeof cur === 'number' && Math.abs(val - cur) < 1e-9);
    if (!save || same) { td.innerHTML = cellHtml(row, col); return; }
    // Not written yet: the cell shows the new value, marked, until Save.
    queueChange(col.change(row, val));
    if (col.set) col.set(row, val); else row[col.key] = val;
    S.changed.add(`${rowId(row)}:${col.key}`);
    td.innerHTML = cellHtml(row, col);
    td.classList.add('pdb-changed');
    status('');
    markDirty();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  if (input.tagName === 'SELECT') input.addEventListener('change', () => finish(true));
}

// ---- form -----------------------------------------------------------------

async function loadForm(where) {
  const prevId = S.record ? S.record.plot_id : null;
  const res = await api.pdbRecordAt({
    project_id: S.project, q: S.q, sort: S.sort, dir: S.dir,
    offset: where.offset, plot_id: where.plotId,
  });
  S.record = res.record;
  S.formTotal = res.total;
  S.formOffset = res.offset;
  S.pending.clear();
  S.changed.clear();
  if (!prevId || !S.record || S.record.plot_id !== prevId) { S.extra.clear(); S.extraObs.clear(); }
  const els = allElements();
  if (!els.some((x) => x.element_id === S.selEl)) S.selEl = els.length ? els[0].element_id : null;
  renderForm();
}

function allElements() {
  if (!S.record) return [];
  return S.record.profiles.flatMap((p) => p.elements);
}
const selectedElement = () => allElements().find((x) => x.element_id === S.selEl) || null;

function field(label, inner, cls) {
  return `<div class="pdb-field ${cls || ''}"><label>${e(label)}</label><div>${inner}</div></div>`;
}

function plotField(name, label, value, type, options) {
  if (!editing()) {
    const shown = name === 'longitude' || name === 'latitude' ? fmtCoord(value) : (value ?? '');
    return field(label, `<span class="pdb-value">${e(shown) || '<span class="pdb-empty">–</span>'}</span>`);
  }
  if (options) {
    return field(label, `<select data-plot="${name}"><option value=""></option>${
      options.map((o) => `<option ${o === value ? 'selected' : ''}>${e(o)}</option>`).join('')}</select>`);
  }
  return field(label, `<input type="${type || 'text'}" data-plot="${name}" value="${e(value ?? '')}"${
    type === 'number' ? ' step="any"' : ''}>`);
}

function descBlock(level, objectId, values) {
  const props = M.byLevel[level];
  const ed = editing();
  const filled = props.filter((p) => values[p.id]);
  if (!ed) {
    if (!filled.length) return `<div class="pdb-empty">${t('a.db.noDesc')}</div>`;
    return groupProps(level, filled).map(([g, list]) => `
      <div class="pdb-group">
        ${GROUPS[level].length > 1 ? `<h5>${t(`a.db.g.${g}`)}</h5>` : ''}
        <div class="pdb-grid">${list.map((p) => field(p.name,
          `<span class="pdb-value" title="${e(p.definition || '')}">${e(catLabel(values[p.id]))}</span>`)).join('')}</div>
      </div>`).join('');
  }
  const asked = (p) => S.extra.has(`${level}:${objectId}:${p.id}`);
  const shown = S.showAll ? props : props.filter((p) => values[p.id] || asked(p));
  const rest = props.filter((p) => !values[p.id] && !asked(p));
  const sel = (p) => `<select data-desc="${level}" data-oid="${objectId}" data-prop="${e(p.id)}" title="${e(p.definition || '')}">
      <option value=""></option>${p.categories.map((c) =>
        `<option value="${e(c.id)}" ${values[p.id] === c.id ? 'selected' : ''}>${e(catLabel(c.id))}</option>`).join('')}
    </select>`;
  const groups = groupProps(level, shown).map(([g, list]) => `
      <div class="pdb-group">
        ${GROUPS[level].length > 1 ? `<h5>${t(`a.db.g.${g}`)}</h5>` : ''}
        <div class="pdb-grid">${list.map((p) => field(p.name, sel(p))).join('')}</div>
      </div>`).join('');
  const adder = !S.showAll && rest.length ? `
      <div class="pdb-add-prop">
        <select data-add-desc="${level}" data-oid="${objectId}">
          <option value="">${t('a.db.addProperty')}</option>
          ${groupProps(level, rest).map(([g, list]) => `<optgroup label="${e(t(`a.db.g.${g}`))}">${
            list.map((p) => `<option value="${e(p.id)}">${e(p.name)}</option>`).join('')}</optgroup>`).join('')}
        </select>
      </div>` : '';
  return (groups || (S.showAll ? '' : `<div class="pdb-empty">${t('a.db.noDesc')}</div>`)) + adder;
}

// The selected horizon's description. Its analytical values are in the
// horizons table above, one column per property.
function horizonPanel(el) {
  if (!el) return `<div class="pdb-empty">${t('a.db.noHorizons')}</div>`;
  return `
    <div class="pdb-hz-panel">
      <h4>${e(el.horizon || t('a.db.horizon'))} <span class="pdb-muted">· ${e(depths(el))} · ${t('a.db.description')}</span></h4>
      ${descBlock('element', el.element_id, el.desc)}
    </div>`;
}

// Analytical observations shown as columns in the form's horizons table:
// those with a value anywhere in the profile, plus columns just added.
function formObsIds() {
  const ids = new Set(allElements().flatMap((x) => Object.keys(x.num).map(Number)));
  S.extraObs.forEach((id) => ids.add(id));
  return [...ids].filter((id) => M.obs[id]).sort((a, b) => obsLabel(a).localeCompare(obsLabel(b)) || a - b);
}

// Columns of that table, all of which can be hidden.
function formColumns() {
  const ids = formObsIds();
  const labels = obsLabels(ids);
  return [
    { key: 'horizon', label: t('a.db.horizon') },
    { key: 'upper_depth', label: t('a.db.upper') },
    { key: 'lower_depth', label: t('a.db.lower') },
    { key: 'type', label: t('a.db.type') },
    { key: 'sample_field_id', label: t('a.db.fieldId') },
    { key: 'sample_lab_id', label: t('a.db.labId') },
    ...ids.map((id) => ({ key: `n:${id}`, label: labels[id], sub: obsSub(id) })),
    { key: 'ndesc', label: t('a.db.nDescFull') },
  ];
}

function horizonsTable() {
  const ed = editing();
  const multi = S.record.profiles.length > 1;
  // One column per analytical observation recorded anywhere in this profile,
  // less the ones switched off in the column chooser.
  const hid = hiddenCols('form');
  const show = (key) => !hid.has(key);
  const allObs = formObsIds();
  const labels = obsLabels(allObs);
  const obsIds = allObs.filter((id) => show(`n:${id}`));
  const numCell = (el, id) => {
    const v = el.num[id];
    return `<td class="pdb-num">${ed
      ? `<input type="text" class="pdb-num-input" data-num="${id}" data-el="${el.element_id}" value="${e(fmtNum(v))}">`
      : e(fmtNum(v))}</td>`;
  };
  const rows = S.record.profiles.flatMap((pr) => pr.elements.map((el) => {
    const sel = el.element_id === S.selEl;
    const inp = (f, v, cls) => (ed
      ? `<input type="text" class="${cls || ''}" data-elf="${f}" data-el="${el.element_id}" value="${e(v ?? '')}">`
      : e(v ?? ''));
    const typeCell = ed
      ? `<select data-elf="type" data-el="${el.element_id}">${M.element_types.map((o) =>
          `<option ${o === el.type ? 'selected' : ''}>${o}</option>`).join('')}</select>`
      : e(el.type);
    return `<tr class="pdb-hz-row${sel ? ' selected' : ''}" data-el-row="${el.element_id}">
      ${multi ? `<td>${e(pr.profile_code || '')}</td>` : ''}
      ${show('horizon') ? `<td class="pdb-strong">${inp('horizon', el.horizon)}</td>` : ''}
      ${show('upper_depth') ? `<td class="pdb-num">${inp('upper_depth', el.upper_depth, 'pdb-short')}</td>` : ''}
      ${show('lower_depth') ? `<td class="pdb-num">${inp('lower_depth', el.lower_depth, 'pdb-short')}</td>` : ''}
      ${show('type') ? `<td>${typeCell}</td>` : ''}
      ${show('sample_field_id') ? `<td>${ed ? `<input type="text" data-spf="sample_field_id" data-el="${el.element_id}" value="${e(el.sample_field_id ?? '')}">` : e(el.sample_field_id ?? '')}</td>` : ''}
      ${show('sample_lab_id') ? `<td>${ed ? `<input type="text" data-spf="sample_lab_id" data-el="${el.element_id}" value="${e(el.sample_lab_id ?? '')}">` : e(el.sample_lab_id ?? '')}</td>` : ''}
      ${obsIds.map((id) => numCell(el, id)).join('')}
      ${show('ndesc') ? `<td class="pdb-num pdb-muted">${Object.keys(el.desc).length || ''}</td>` : ''}
      ${ed ? `<td><button type="button" class="pdb-x" data-del-el="${el.element_id}" title="${t('a.db.deleteHorizon')}">×</button></td>` : ''}
    </tr>`;
  })).join('');
  const adder = ed ? `
    <div class="pdb-add-hz">
      <input type="text" id="pdb-hz-name" placeholder="${t('a.db.horizon')}">
      <input type="text" id="pdb-hz-upper" class="pdb-short" placeholder="${t('a.db.upper')}">
      <input type="text" id="pdb-hz-lower" class="pdb-short" placeholder="${t('a.db.lower')}">
      <select id="pdb-hz-type">${M.element_types.map((o) => `<option>${o}</option>`).join('')}</select>
      <button type="button" class="btn btn-sm" id="pdb-hz-add">${t('a.db.addHorizon')}</button>
    </div>` : '';
  // A new analytical property enters as an empty column, filled in cell by cell.
  const colAdder = ed ? `
    <div class="pdb-add-num">
      <input type="text" id="pdb-add-obs" list="pdb-obs-list" placeholder="${t('a.db.addValuePh')}">
      <button type="button" class="btn btn-sm" id="pdb-add-col-btn">${t('a.db.addColumn')}</button>
    </div>` : '';
  if (!rows) return `<div class="pdb-empty">${t('a.db.noHorizons')}</div>${adder}`;
  return `
    <table class="pdb-mini pdb-hz-table">
      <thead><tr>
        ${multi ? `<th>${t('a.db.profile')}</th>` : ''}
        ${show('horizon') ? `<th>${t('a.db.horizon')}</th>` : ''}
        ${show('upper_depth') ? `<th class="pdb-num pdb-th-wrap">${t('a.db.upper')}</th>` : ''}
        ${show('lower_depth') ? `<th class="pdb-num pdb-th-wrap">${t('a.db.lower')}</th>` : ''}
        ${show('type') ? `<th>${t('a.db.type')}</th>` : ''}
        ${show('sample_field_id') ? `<th>${t('a.db.fieldId')}</th>` : ''}
        ${show('sample_lab_id') ? `<th>${t('a.db.labId')}</th>` : ''}
        ${obsIds.map((id) => `<th class="pdb-num pdb-hz-obs" title="${e(obsFull(M.obs[id]))}">${e(labels[id])}<small>${e(M.obs[id].unit_of_measure_id)}</small></th>`).join('')}
        ${show('ndesc') ? `<th class="pdb-num" title="${t('a.db.nDescFull')}">${t('a.db.nDesc')}</th>` : ''}
        ${ed ? '<th></th>' : ''}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>${adder}${colAdder}`;
}

// Redraws only the horizons table and its chooser (the rest of the form,
// map included, stays as it is).
function refreshHorizonsTable() {
  const list = document.querySelector('.pdb-hz-list');
  const pick = document.getElementById('pdb-form-colpick');
  if (!list || !pick) { renderForm(); return; }
  keepMenuScroll(() => {
    list.innerHTML = horizonsTable();
    pick.innerHTML = columnChooser('form', formColumns());
  });
}

function photosBlock() {
  const ed = editing();
  const items = S.record.photos.map((p) => `
    <figure class="pdb-photo" data-photo="${p.photo_id}">
      <img alt="" data-photo-img="${p.photo_id}" data-size="thumb">
      ${ed ? `<input type="text" class="pdb-caption" data-caption="${p.photo_id}" value="${e(p.caption || '')}" placeholder="${t('a.db.caption')}">
              <button type="button" class="pdb-x pdb-photo-del" data-del-photo="${p.photo_id}" title="${t('a.delete')}">×</button>`
           : (p.caption ? `<figcaption>${e(p.caption)}</figcaption>` : '')}
    </figure>`).join('');
  return `
    <div class="pdb-photos">
      ${items || (ed ? '' : `<div class="pdb-empty">${t('a.db.noPhotos')}</div>`)}
      ${ed ? `<label class="pdb-photo-add">
          <input type="file" id="pdb-photo-file" accept="image/*" multiple hidden>
          <span>+ ${t('a.db.addPhotos')}</span>
        </label>` : ''}
    </div>`;
}

function renderForm() {
  const body = document.getElementById('pdb-body');
  if (!body) return;
  if (formMap) { formMap.setTarget(null); formMap = null; }
  const r = S.record;
  if (!r) {
    body.innerHTML = `<div class="empty-state">${t('a.db.none')}</div>`;
    return;
  }
  const ed = editing();
  const proj = r.projects.map((p) => p.name || p.project_id).join(', ');
  const profileDesc = r.profiles.map((pr) => {
    if (!M.byLevel.profile.length) return '';
    if (!ed && !Object.keys(pr.desc).length) return '';
    return descBlock('profile', pr.profile_id, pr.desc);
  }).join('');
  body.innerHTML = `
    <div class="pdb-nav">
      <button type="button" class="btn btn-sm" data-nav="first" ${S.formOffset <= 0 ? 'disabled' : ''} title="${t('a.db.first')}">⏮</button>
      <button type="button" class="btn btn-sm" data-nav="prev" ${S.formOffset <= 0 ? 'disabled' : ''} title="${t('a.db.prev')}">◀</button>
      <span class="pdb-nav-pos"><input type="text" id="pdb-goto" value="${S.formOffset + 1}"> / ${S.formTotal}</span>
      <button type="button" class="btn btn-sm" data-nav="next" ${S.formOffset >= S.formTotal - 1 ? 'disabled' : ''} title="${t('a.db.next')}">▶</button>
      <button type="button" class="btn btn-sm" data-nav="last" ${S.formOffset >= S.formTotal - 1 ? 'disabled' : ''} title="${t('a.db.last')}">⏭</button>
      <span class="pdb-spacer"></span>
      ${ed ? `
        <label class="pdb-showall"><input type="checkbox" id="pdb-showall" ${S.showAll ? 'checked' : ''}> ${t('a.db.showAll')}</label>
` : ''}
      <button type="button" class="btn btn-sm" id="pdb-report-btn">${t('a.db.report')}</button>
      ${ed && M.is_admin ? `<button type="button" class="btn btn-sm pdb-danger" id="pdb-del-plot">${t('a.db.deleteProfile')}</button>` : ''}
    </div>

    <div class="pdb-form">
      <div class="pdb-card pdb-head">
        <div class="pdb-head-main">
          <div class="pdb-title">${e(r.plot_code || `#${r.plot_id}`)}</div>
          <div class="pdb-subtitle">${e(proj)}</div>
          <div class="pdb-grid">
            ${plotField('plot_code', t('a.db.code'), r.plot_code)}
            ${plotField('type', t('a.db.type'), r.type, null, M.plot_types)}
            ${plotField('sampling_date', t('a.db.date'), r.sampling_date, 'date')}
            ${plotField('longitude', t('a.db.lon'), r.longitude, 'number')}
            ${plotField('latitude', t('a.db.lat'), r.latitude, 'number')}
            ${plotField('altitude', t('a.db.altitude'), r.altitude, 'number')}
            ${plotField('positional_accuracy', t('a.db.accuracy'), r.positional_accuracy, 'number')}
          </div>
        </div>
        <div class="pdb-head-map">
          <div id="pdb-map"></div>
          ${ed ? `<div class="pdb-hint">${t('a.db.mapHint')}</div>` : ''}
        </div>
      </div>

      <div class="pdb-card">
        <h4>${t('a.db.photos')}</h4>
        ${photosBlock()}
      </div>

      <div class="pdb-card">
        <h4>${t('a.db.site')}</h4>
        ${descBlock('plot', r.plot_id, r.desc.plot)}
      </div>

      <div class="pdb-card">
        <h4>${t('a.db.surface')}</h4>
        ${descBlock('surface', r.plot_id, r.desc.surface)}
        ${profileDesc ? `<div class="pdb-sep"></div>${profileDesc}` : ''}
      </div>

      <div class="pdb-card">
        <div class="pdb-card-head">
          <h4>${t('a.db.horizons')}</h4>
          <span class="pdb-spacer"></span>
          ${allElements().length ? `<span id="pdb-form-colpick">${columnChooser('form', formColumns())}</span>` : ''}
        </div>
        <div class="pdb-hz">
          <div class="pdb-sketch">${sketchSvg(allElements(), { selected: S.selEl, height: 340 })}</div>
          <div class="pdb-hz-list">${horizonsTable()}</div>
        </div>
        ${allElements().length ? horizonPanel(selectedElement()) : ''}
      </div>
    </div>`;
  loadPhotoImages(body);
  mountFormMap();
  markDirty();
}

function mountFormMap() {
  const target = document.getElementById('pdb-map');
  if (!target) return;
  const r = S.record;
  const has = r.longitude !== null && r.longitude !== undefined && r.latitude !== null && r.latitude !== undefined;
  const source = new VectorSource();
  if (has) source.addFeature(new Feature(new Point(fromLonLat([Number(r.longitude), Number(r.latitude)]))));
  formMap = new OlMap({
    target,
    layers: [
      new TileLayer({ source: new OSM({ crossOrigin: 'anonymous' }) }),
      new VectorLayer({ source, style: markerStyle() }),
    ],
    view: new View({
      center: has ? fromLonLat([Number(r.longitude), Number(r.latitude)]) : [0, 0],
      zoom: has ? 11 : 1,
    }),
    controls: [],
  });
  if (editing()) {
    formMap.on('singleclick', (ev) => {
      const [lon, lat] = toLonLat(ev.coordinate);
      setPlotValue('longitude', Number(lon.toFixed(6)));
      setPlotValue('latitude', Number(lat.toFixed(6)));
      source.clear();
      source.addFeature(new Feature(new Point(ev.coordinate)));
      const lo = document.querySelector('[data-plot="longitude"]');
      const la = document.querySelector('[data-plot="latitude"]');
      if (lo) lo.value = lon.toFixed(6);
      if (la) la.value = lat.toFixed(6);
      markDirty();
    });
  }
}

function markerStyle() {
  return new Style({
    image: new CircleStyle({
      radius: 7,
      fill: new Fill({ color: '#B3402F' }),
      stroke: new Stroke({ color: '#ffffff', width: 2 }),
    }),
  });
}

// ---- form: collecting changes --------------------------------------------

// The Save / Cancel bar: on screen whenever Edit mode is on, live once
// something has been changed.
function markDirty() {
  const bar = document.getElementById('pdb-savebar');
  if (!bar) return;
  bar.hidden = !editing();
  bar.classList.toggle('pdb-savebar-dirty', dirty());
  document.getElementById('pdb-save').disabled = !dirty();
  document.getElementById('pdb-cancel').disabled = !dirty();
  document.getElementById('pdb-savebar-n').textContent = dirty()
    ? t('a.db.unsaved', { n: S.pending.size }) : t('a.db.noUnsaved');
}

async function saveTable() {
  if (!dirty()) return;
  try {
    await api.pdbSave([...S.pending.values()]);
    S.pending.clear();
    S.changed.clear();
    await loadTable();
    status(t('a.db.saved'), 'ok');
  } catch (err) {
    status(err.message, 'err');
  }
}

function setPlotValue(name, value) {
  const key = `plot:${S.record.plot_id}`;
  const ch = S.pending.get(key) || { kind: 'plot', plot_id: S.record.plot_id, values: {} };
  ch.values[name] = value;
  S.pending.set(key, ch);
  S.record[name] = value;
}

function setElementValue(elementId, name, value) {
  const key = `element:${elementId}`;
  const ch = S.pending.get(key) || { kind: 'element', element_id: elementId, values: {} };
  ch.values[name] = value;
  S.pending.set(key, ch);
  const el = allElements().find((x) => x.element_id === elementId);
  if (el) el[name] = name.endsWith('_depth') && value !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
}

function setSpecimenValue(elementId, name, value) {
  const key = `specimen:${elementId}`;
  const ch = S.pending.get(key) || { kind: 'specimen', element_id: elementId, values: {} };
  ch.values[name] = value;
  S.pending.set(key, ch);
  const el = allElements().find((x) => x.element_id === elementId);
  if (el) el[name] = value;
}

function descTarget(level, oid) {
  if (level === 'plot') return S.record.desc.plot;
  if (level === 'surface') return S.record.desc.surface;
  if (level === 'profile') return (S.record.profiles.find((p) => p.profile_id === oid) || {}).desc;
  return (allElements().find((x) => x.element_id === oid) || {}).desc;
}

function setDesc(level, oid, prop, cat) {
  S.pending.set(`desc:${level}:${oid}:${prop}`, {
    kind: 'desc', level, object_id: oid, property_desc_id: prop, category_desc_id: cat || null,
  });
  const target = descTarget(level, oid);
  if (target) { if (cat) target[prop] = cat; else delete target[prop]; }
}

function setNum(elementId, obsId, raw) {
  const s = String(raw ?? '').trim();
  let value = null;
  if (s !== '') {
    if (M.censored.includes(s.toUpperCase())) value = s.toUpperCase();
    else {
      value = Number(s.replace(',', '.'));
      if (Number.isNaN(value)) { status(t('a.db.notNumber', { value: s }), 'err'); return false; }
    }
  }
  S.pending.set(`num:${elementId}:${obsId}`, {
    kind: 'num', element_id: elementId, observation_num_id: obsId, value,
  });
  const el = allElements().find((x) => x.element_id === elementId);
  if (el) { if (value === null) delete el.num[obsId]; else el.num[obsId] = value; }
  return true;
}

async function saveForm() {
  if (!dirty()) return true;
  try {
    await api.pdbSave([...S.pending.values()]);
    S.pending.clear();
    S.changed.clear();
    await loadForm({ plotId: S.record.plot_id });
    status(t('a.db.saved'), 'ok');
    return true;
  } catch (err) {
    status(err.message, 'err');
    return false;
  }
}

async function navigate(to) {
  if (!leaveGuard()) return;
  let off = S.formOffset;
  if (to === 'first') off = 0;
  else if (to === 'prev') off -= 1;
  else if (to === 'next') off += 1;
  else if (to === 'last') off = S.formTotal - 1;
  else off = to;
  S.selEl = null;
  try { await loadForm({ offset: Math.max(0, off) }); } catch (err) { status(err.message, 'err'); }
}

// ---- photographs ----------------------------------------------------------

async function photoUrl(id, size) {
  const key = `${id}:${size}`;
  if (!photoUrls.has(key)) {
    const blob = await api.pdbPhotoBlob(id, size);
    photoUrls.set(key, URL.createObjectURL(blob));
  }
  return photoUrls.get(key);
}

function loadPhotoImages(scope) {
  const jobs = [];
  scope.querySelectorAll('img[data-photo-img]').forEach((img) => {
    jobs.push(photoUrl(Number(img.dataset.photoImg), img.dataset.size || 'thumb')
      .then((url) => new Promise((resolve) => {
        img.onload = resolve; img.onerror = resolve; img.src = url;
      }))
      .catch(() => { img.alt = '?'; }));
  });
  return Promise.all(jobs);
}

// Full-size viewer. Left / right arrows (or the on-screen ones) move through
// the profile's photographs, wrapping at the ends; Esc or a click closes.
function lightbox(id) {
  const photos = S.record.photos;
  if (!photos.length) return;
  let i = Math.max(0, photos.findIndex((x) => x.photo_id === id));
  const many = photos.length > 1;
  const ov = document.createElement('div');
  ov.className = 'pdb-lightbox';
  ov.innerHTML = `
    ${many ? `<button type="button" class="pdb-lb-nav pdb-lb-prev" title="${t('a.db.prev')} (←)" aria-label="${t('a.db.prev')}">‹</button>` : ''}
    <figure><img alt=""><figcaption></figcaption></figure>
    ${many ? `<button type="button" class="pdb-lb-nav pdb-lb-next" title="${t('a.db.next')} (→)" aria-label="${t('a.db.next')}">›</button>` : ''}`;
  const show = async (n) => {
    i = (n + photos.length) % photos.length;
    const p = photos[i];
    ov.querySelector('figcaption').textContent =
      [p.caption || '', many ? `${i + 1} / ${photos.length}` : ''].filter(Boolean).join('  ·  ');
    try {
      const url = await photoUrl(p.photo_id, 'full');
      // Ignore a picture that arrives after the viewer has moved on.
      if (photos[i] === p) ov.querySelector('img').src = url;
    } catch (err) { /* keep the previous picture on screen */ }
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') close();
    else if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown' || ev.key === 'PageDown' || ev.key === ' ') show(i + 1);
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' || ev.key === 'PageUp') show(i - 1);
    else if (ev.key === 'Home') show(0);
    else if (ev.key === 'End') show(photos.length - 1);
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  };
  function close() {
    ov.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('click', (ev) => {
    if (ev.target.closest('.pdb-lb-prev')) show(i - 1);
    else if (ev.target.closest('.pdb-lb-next')) show(i + 1);
    else close();
  });
  document.body.appendChild(ov);
  show(i);
}

async function uploadPhotos(files) {
  const plotId = S.record.plot_id;
  let n = 0;
  for (const f of files) {
    status(t('a.db.uploading', { n: n + 1, total: files.length }));
    try {
      const photo = await api.pdbUploadPhoto(plotId, f, '');
      S.record.photos.push(photo);
      n += 1;
    } catch (err) {
      status(`${f.name}: ${err.message}`, 'err');
      break;
    }
  }
  if (n === files.length) status(t('a.db.saved'), 'ok');
  renderForm();
}

// ---- profile sketch and depth plots (inline SVG) -------------------------

function niceStep(max) {
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500];
  return steps.find((s) => max / s <= 8) || 1000;
}

// Earth tones by depth: darker topsoil, lighter subsoil. A schematic — the
// database holds no soil colour to draw from.
function horizonFill(mid, max) {
  const a = [74, 54, 38];
  const b = [205, 176, 132];
  const k = Math.min(1, Math.max(0, mid / (max || 1)));
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * Math.sqrt(k)));
  return { fill: `rgb(${c.join(',')})`, dark: (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) < 140 };
}

function boundaryPoints(y, x0, x1, shape, seed) {
  const pts = [];
  const n = 24;
  for (let i = 0; i <= n; i += 1) {
    const x = x0 + ((x1 - x0) * i) / n;
    let dy = 0;
    if (shape === 'W') dy = Math.sin((i / n) * Math.PI * 4) * 2.6;
    else if (shape === 'I') dy = Math.sin(i * 1.7 + seed) * 2.2 + Math.sin(i * 0.63 + seed * 2) * 2.4;
    pts.push([x, y + (i === 0 || i === n ? 0 : dy)]);
  }
  return pts;
}

function sketchSvg(elements, opts = {}) {
  const els = elements.filter((x) => x.lower_depth > x.upper_depth);
  if (!els.length) return '';
  const H = opts.height || 340;
  const top = 14;
  const bottom = 12;
  const x0 = 38;
  const w = opts.width || 96;
  const x1 = x0 + w;
  const max = Math.max(...els.map((x) => x.lower_depth));
  const sc = (H - top - bottom) / max;
  const y = (d) => top + d * sc;
  // The scale carries the horizon limits themselves, not round numbers.
  // Every limit gets a tick; where two fall too close for both numbers to
  // be read, the upper one keeps its number (the last limit always does).
  const limits = [...new Set(els.flatMap((x) => [x.upper_depth, x.lower_depth]))].sort((p, q) => p - q);
  const labelled = [];
  limits.forEach((d, i) => {
    const prev = labelled[labelled.length - 1];
    if (prev !== undefined && y(d) - y(prev) < 10) {
      if (i !== limits.length - 1) return;
      if (labelled.length > 1) labelled.pop();
    }
    labelled.push(d);
  });
  let ticks = '';
  limits.forEach((d) => {
    ticks += `<line x1="${x0 - 5}" x2="${x0}" y1="${y(d)}" y2="${y(d)}" class="sk-axis"/>`;
    if (labelled.includes(d)) ticks += `<text x="${x0 - 8}" y="${y(d) + 3.5}" class="sk-tick" text-anchor="end">${d}</text>`;
  });
  let shapes = '';
  let lines = '';
  let prev = null;   // boundary polyline of the horizon above, when contiguous
  els.forEach((el, i) => {
    const topo = catCode(el.desc.boundaryTopographyProperty);
    const dist = catCode(el.desc.boundaryDistinctnessProperty);
    const last = i === els.length - 1;
    const up = prev && prev.depth === el.upper_depth
      ? prev.pts : boundaryPoints(y(el.upper_depth), x0, x1, 'S', 0);
    const low = boundaryPoints(y(el.lower_depth), x0, x1, last ? 'S' : topo, i + 1);
    const d = `M${up.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' L')} L${
      [...low].reverse().map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' L')} Z`;
    const c = horizonFill((el.upper_depth + el.lower_depth) / 2, max);
    const sel = opts.selected === el.element_id;
    shapes += `<path d="${d}" fill="${c.fill}" class="sk-hz${sel ? ' sk-sel' : ''}" data-sk-el="${el.element_id}"><title>${e(el.horizon || '')} ${e(depths(el))}</title></path>`;
    const hgt = (el.lower_depth - el.upper_depth) * sc;
    if (hgt >= 11 && el.horizon) {
      shapes += `<text x="${(x0 + x1) / 2}" y="${y((el.upper_depth + el.lower_depth) / 2) + 3.5}" text-anchor="middle" class="sk-label" fill="${c.dark ? '#fff' : '#2a221a'}">${e(el.horizon)}</text>`;
    }
    if (!last) {
      const dash = dist === 'G' ? ' stroke-dasharray="5 3"' : dist === 'D' ? ' stroke-dasharray="1.5 3"' : topo === 'B' ? ' stroke-dasharray="9 4"' : '';
      lines += `<polyline points="${low.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}" class="sk-bound"${dash}/>`;
    }
    prev = { depth: el.lower_depth, pts: low };
  });
  return `<svg class="pdb-sketch-svg" viewBox="0 0 ${x1 + 4} ${H}" width="${x1 + 4}" height="${H}" role="img" aria-label="${e(t('a.db.sketch'))}">
    <text x="${x0 - 8}" y="9" class="sk-tick" text-anchor="end">cm</text>
    <line x1="${x0}" x2="${x0}" y1="${top}" y2="${H - bottom}" class="sk-axis"/>
    ${ticks}${shapes}${lines}
    <rect x="${x0}" y="${top}" width="${w}" height="${H - top - bottom}" class="sk-frame"/>
  </svg>`;
}

function depthPlotSvg(elements, obsId, H, label) {
  const els = elements.filter((x) => typeof x.num[obsId] === 'number' && x.lower_depth > x.upper_depth);
  if (els.length < 2) return '';
  const max = Math.max(...elements.map((x) => x.lower_depth));
  const top = 14;
  const bottom = 12;
  const W = 92;
  const x0 = 6;
  const x1 = W - 6;
  const sc = (H - top - bottom) / max;
  const y = (d) => top + d * sc;
  const vals = els.map((x) => x.num[obsId]);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08;
  const x = (v) => x0 + ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (x1 - x0);
  // A step line; it breaks where a horizon in between has no value.
  let path = '';
  let prevLower = null;
  els.forEach((el) => {
    const xv = x(el.num[obsId]).toFixed(1);
    path += `${prevLower === el.upper_depth ? 'L' : 'M'}${xv},${y(el.upper_depth).toFixed(1)} L${xv},${y(el.lower_depth).toFixed(1)} `;
    prevLower = el.lower_depth;
  });
  const o = M.obs[obsId];
  const step = niceStep(max);
  let grid = '';
  for (let d = 0; d <= max; d += step) grid += `<line x1="${x0}" x2="${x1}" y1="${y(d)}" y2="${y(d)}" class="dp-grid"/>`;
  return `<figure class="pdb-dplot">
    <figcaption title="${e(obsFull(o))}"><span>${e(label || o.property_name || o.property_num_id)}</span><small>${e(o.unit_of_measure_id)}</small></figcaption>
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      ${grid}
      <rect x="${x0}" y="${top}" width="${x1 - x0}" height="${H - top - bottom}" class="sk-frame"/>
      <path d="${path}" class="dp-line"/>
      <text x="${x0}" y="${H - 1}" class="sk-tick">${fmtNum(lo)}</text>
      <text x="${x1}" y="${H - 1}" class="sk-tick" text-anchor="end">${fmtNum(hi)}</text>
    </svg></figure>`;
}

// ---- report ---------------------------------------------------------------

function staticMap(holder, lon, lat) {
  // Renders an OpenLayers map once and swaps it for a plain image, which
  // prints reliably. If the tiles cannot be read back (no CORS) or do not
  // arrive (offline install), the holder is left as it is or removed.
  return new Promise((resolve) => {
    const center = fromLonLat([lon, lat]);
    const source = new VectorSource({ features: [new Feature(new Point(center))] });
    const map = new OlMap({
      target: holder,
      layers: [new TileLayer({ source: new OSM({ crossOrigin: 'anonymous' }) }),
               new VectorLayer({ source, style: markerStyle() })],
      view: new View({ center, zoom: 9 }),
      controls: [],
      interactions: [],
      pixelRatio: 2,
    });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) {
        try {
          const size = map.getSize();
          const out = document.createElement('canvas');
          out.width = size[0] * 2;
          out.height = size[1] * 2;
          const ctx = out.getContext('2d');
          holder.querySelectorAll('.ol-layer canvas').forEach((c) => {
            if (c.width > 0) ctx.drawImage(c, 0, 0, out.width, out.height);
          });
          const img = document.createElement('img');
          img.src = out.toDataURL('image/png');
          img.alt = '';
          map.setTarget(null);
          holder.innerHTML = '';
          holder.appendChild(img);
        } catch (err) { /* tainted canvas: keep the live map */ }
      }
      resolve();
    };
    map.once('rendercomplete', () => finish(true));
    setTimeout(() => finish(true), 6000);
  });
}

function reportDescList(level, values) {
  const filled = M.byLevel[level].filter((p) => values[p.id]);
  if (!filled.length) return '';
  return `<dl class="rp-dl">${filled.map((p) =>
    `<div><dt>${e(p.name)}</dt><dd>${e(catShort(values[p.id]))}${
      catCode(values[p.id]) && catCode(values[p.id]) !== catShort(values[p.id]) ? ` <span class="rp-code">${e(catCode(values[p.id]))}</span>` : ''}</dd></div>`).join('')}</dl>`;
}

function reportHtml(r, site) {
  const els = r.profiles.flatMap((p) => p.elements);
  const proj = r.projects.map((p) => p.name || p.project_id).join(', ');
  const has = r.longitude !== null && r.longitude !== undefined && r.latitude !== null && r.latitude !== undefined;
  const idRows = [
    [t('a.db.code'), r.plot_code],
    [t('a.db.project'), proj],
    [t('a.db.type'), r.type],
    [t('a.db.date'), r.sampling_date],
    [t('a.db.lon'), fmtCoord(r.longitude)],
    [t('a.db.lat'), fmtCoord(r.latitude)],
    [t('a.db.altitude'), r.altitude],
    [t('a.db.accuracy'), r.positional_accuracy],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  const siteDesc = reportDescList('plot', r.desc.plot);
  const surfDesc = reportDescList('surface', r.desc.surface);
  const profDesc = r.profiles.map((p) => reportDescList('profile', p.desc)).join('');

  // Horizon descriptions, narrative style: one paragraph per horizon.
  const hzParas = els.map((el) => {
    const filled = M.byLevel.element.filter((p) => el.desc[p.id]);
    if (!filled.length) return '';
    const parts = groupProps('element', filled).map(([, list]) =>
      list.map((p) => `${e(p.name.toLowerCase())}: <b>${e(catShort(el.desc[p.id]).toLowerCase())}</b>`).join(', ')).join('; ');
    return `<p class="rp-hz"><span class="rp-hz-name">${e(el.horizon || '–')}</span>
      <span class="rp-hz-depth">${e(depths(el))}</span> ${parts}.</p>`;
  }).filter(Boolean);
  // A heading never stays alone at the foot of a page: it is kept with the
  // first block that follows it.
  const withHead = (title, first, rest) =>
    `<section><div class="rp-keep"><h2>${title}</h2>${first}</div>${rest}</section>`;

  // Analytical table: horizons as rows, observations as columns (chunked).
  const obsIds = [...new Set(els.flatMap((el) => Object.keys(el.num).map(Number)))]
    .filter((id) => M.obs[id]).sort((a, b) => obsLabel(a).localeCompare(obsLabel(b)) || a - b);
  const labels = obsLabels(obsIds);
  const numTables = [];
  for (let i = 0; i < obsIds.length; i += 9) {
    const chunk = obsIds.slice(i, i + 9);
    numTables.push(`<table class="rp-table">
      <thead><tr><th>${t('a.db.horizon')}</th><th>${t('a.db.depth')}</th>${chunk.map((id) =>
        `<th class="rp-num">${e(labels[id])}<small>${e(M.obs[id].unit_of_measure_id)}</small></th>`).join('')}</tr></thead>
      <tbody>${els.map((el) => `<tr><td class="rp-nowrap"><b>${e(el.horizon || '')}</b></td><td class="rp-nowrap">${el.upper_depth}–${el.lower_depth}</td>${
        chunk.map((id) => `<td class="rp-num">${e(fmtNum(el.num[id]))}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`);
  }
  const methods = obsIds.length ? `<p class="rp-methods"><b>${t('a.db.methods')}:</b> ${obsIds.map((id) =>
    `${e(obsLabel(id))}: ${e(M.obs[id].procedure_num_id)}`).join('; ')}.</p>` : '';

  const H = 300;
  const plots = [...obsIds].sort((a, b) => plotRank(a) - plotRank(b))
    .map((id) => depthPlotSvg(els, id, H, labels[id])).filter(Boolean).slice(0, 5).join('');
  const sketch = sketchSvg(els, { height: H });

  const photos = r.photos.map((p) => `<figure class="rp-photo">
      <img alt="" data-photo-img="${p.photo_id}" data-size="full">
      ${p.caption ? `<figcaption>${e(p.caption)}</figcaption>` : ''}</figure>`).join('');

  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="rp-bar">
      <span>${t('a.db.reportHint')}</span>
      <span class="pdb-spacer"></span>
      <button type="button" class="btn btn-sm btn-primary" id="rp-print">${t('a.db.print')}</button>
      <button type="button" class="btn btn-sm" id="rp-close">${t('a.close')}</button>
    </div>
    <article class="rp-page">
      <header class="rp-header">
        <div>
          <div class="rp-kicker">${t('a.db.reportTitle')}</div>
          <h1>${e(r.plot_code || `#${r.plot_id}`)}</h1>
          <div class="rp-project">${e(proj)}</div>
        </div>
        <div class="rp-brand">
          ${site.logo ? `<img src="${e(site.logo)}" alt="">` : ''}
          <span>${e(site.title || '')}</span>
        </div>
      </header>

      <section class="rp-top">
        <table class="rp-id">${idRows.map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`).join('')}</table>
        ${has ? '<div class="rp-map" id="rp-map"></div>' : ''}
      </section>

      ${siteDesc ? `<section><h2>${t('a.db.site')}</h2>${siteDesc}</section>` : ''}
      ${surfDesc || profDesc ? `<section><h2>${t('a.db.surface')}</h2>${surfDesc}${profDesc}</section>` : ''}

      ${els.length ? `<section class="rp-keep">
        <h2>${t('a.db.profile')}</h2>
        <div class="rp-profile">
          <figure class="rp-sketch">${sketch}<figcaption>${t('a.db.sketchNote')}</figcaption></figure>
          ${plots}
        </div>
      </section>` : ''}

      ${hzParas.length ? withHead(t('a.db.hzDescription'), hzParas[0], hzParas.slice(1).join('')) : ''}
      ${numTables.length ? withHead(t('a.db.analytical'), numTables[0], numTables.slice(1).join('') + methods) : ''}
      ${photos ? `<section><h2>${t('a.db.photos')}</h2><div class="rp-photos">${photos}</div></section>` : ''}

      <footer class="rp-footer">
        <span>${e(site.title || '')} · ${e(location.host)}</span>
        <span>${t('a.db.codeLists')}</span>
        <span>${today}</span>
      </footer>
    </article>`;
}

let siteInfo = null;
async function getSiteInfo() {
  if (siteInfo) return siteInfo;
  siteInfo = { title: '', logo: '' };
  try {
    const s = (await api.getSite()) || {};
    siteInfo = { title: s.app_title || '', logo: ((s.content || {}).logo_url || s.org_logo || '') };
  } catch (err) { /* the report works without a brand */ }
  return siteInfo;
}

async function openReport() {
  if (!S.record) return;
  if (dirty() && !(await saveForm())) return;
  const r = S.record;
  const site = await getSiteInfo();
  const ov = document.createElement('div');
  ov.id = 'pdb-report';
  ov.innerHTML = reportHtml(r, site);
  document.body.appendChild(ov);
  document.documentElement.classList.add('pdb-report-open');
  const oldTitle = document.title;
  const close = () => {
    ov.remove();
    document.documentElement.classList.remove('pdb-report-open');
    document.title = oldTitle;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  ov.querySelector('#rp-close').addEventListener('click', close);
  const ready = [loadPhotoImages(ov)];
  const mapHolder = ov.querySelector('#rp-map');
  if (mapHolder) ready.push(staticMap(mapHolder, Number(r.longitude), Number(r.latitude)));
  const printBtn = ov.querySelector('#rp-print');
  printBtn.disabled = true;
  Promise.all(ready).then(() => { printBtn.disabled = false; ov.dataset.ready = '1'; });
  printBtn.addEventListener('click', () => {
    // The browser offers this as the file name when saving as PDF.
    document.title = `${r.plot_code || r.plot_id} - ${t('a.db.reportTitle')}`;
    window.print();
    setTimeout(() => { document.title = oldTitle; }, 1000);
  });
}

// ---- new profile ----------------------------------------------------------

function newProfileDialog() {
  const ov = document.createElement('div');
  ov.className = 'pdb-modal';
  ov.innerHTML = `
    <div class="pdb-modal-card" role="dialog" aria-modal="true">
      <h3>${t('a.db.newProfile')}</h3>
      <div class="pdb-grid pdb-grid-2">
        ${field(t('a.db.project'), `<select id="np-project">${M.projects.map((p) =>
          `<option value="${e(p.project_id)}" ${p.project_id === S.project ? 'selected' : ''}>${e(p.name || p.project_id)}</option>`).join('')}</select>`)}
        ${field(t('a.db.code'), '<input type="text" id="np-code">')}
        ${field(t('a.db.type'), `<select id="np-type"><option value=""></option>${M.plot_types.map((o) => `<option>${o}</option>`).join('')}</select>`)}
        ${field(t('a.db.date'), '<input type="date" id="np-date">')}
        ${field(t('a.db.lon'), '<input type="number" step="any" id="np-lon">')}
        ${field(t('a.db.lat'), '<input type="number" step="any" id="np-lat">')}
        ${field(t('a.db.altitude'), '<input type="number" id="np-alt">')}
      </div>
      <div class="pdb-modal-err" id="np-err"></div>
      <div class="pdb-modal-actions">
        <button type="button" class="btn btn-sm" id="np-cancel">${t('a.cancel')}</button>
        <button type="button" class="btn btn-sm btn-primary" id="np-create">${t('a.db.create')}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#np-cancel').addEventListener('click', close);
  ov.addEventListener('click', (ev) => { if (ev.target === ov) close(); });
  if (!M.projects.length) ov.querySelector('#np-err').textContent = t('a.db.noProjects');
  ov.querySelector('#np-create').addEventListener('click', async () => {
    const v = (id) => ov.querySelector(id).value.trim();
    const values = { plot_code: v('#np-code') };
    if (v('#np-type')) values.type = v('#np-type');
    if (v('#np-date')) values.sampling_date = v('#np-date');
    if (v('#np-lon') || v('#np-lat')) { values.longitude = v('#np-lon'); values.latitude = v('#np-lat'); }
    if (v('#np-alt')) values.altitude = v('#np-alt');
    try {
      const res = await api.pdbCreatePlot(v('#np-project'), values);
      close();
      const p = M.projects.find((x) => x.project_id === v('#np-project'));
      if (p) p.profiles += 1;
      S.view = 'form';
      S.selEl = null;
      syncToolbar();
      await loadForm({ plotId: res.plot_id });
    } catch (err) {
      ov.querySelector('#np-err').textContent = err.message;
    }
  });
  ov.querySelector('#np-code').focus();
}

// ---- events ---------------------------------------------------------------

function wire(root) {
  const redrawColumns = (table) => {
    if (table === 'form') refreshHorizonsTable();
    else keepMenuScroll(renderTable);
  };
  root.addEventListener('click', async (ev) => {
    const el = ev.target;
    // column chooser: open / close, show all; a click elsewhere closes it
    const pickBtn = el.closest('.pdb-colpick-btn');
    if (pickBtn) {
      const table = pickBtn.parentElement.dataset.table;
      S.colMenu = S.colMenu === table ? null : table;
      pickBtn.nextElementSibling.hidden = S.colMenu !== table;
      return;
    }
    if (el.closest('[data-col-all]')) {
      const table = el.closest('.pdb-colpick').dataset.table;
      setHidden(table, null);
      redrawColumns(table);
      return;
    }
    if (el.closest('.pdb-colpick')) return;
    if (S.colMenu) {
      S.colMenu = null;
      root.querySelectorAll('.pdb-colpick-menu').forEach((m) => { m.hidden = true; });
    }
    const viewBtn = el.closest('.pdb-views button');
    if (viewBtn) {
      if (viewBtn.dataset.view === S.view || !leaveGuard()) return;
      if (viewBtn.dataset.view === 'form') { S.formOffset = S.page * S.pageSize; S.selEl = null; }
      S.view = viewBtn.dataset.view;
      S.page = S.view === 'form' ? S.page : 0;
      status('');
      refresh();
      return;
    }
    const modeBtn = el.closest('.pdb-mode button');
    if (modeBtn) {
      const edit = modeBtn.dataset.mode === 'edit';
      if (edit === S.edit) return;
      // Going back to View with unsaved edits asks first.
      const had = dirty();
      if (!edit && !leaveGuard()) return;
      S.edit = edit;
      syncToolbar();
      try {
        if (S.view === 'form') {
          if (S.record) await loadForm({ plotId: S.record.plot_id });
        } else if (had) await loadTable();   // edits were dropped: show the stored data again
        else renderTable();
      } catch (err) { status(err.message, 'err'); }
      return;
    }
    if (el.id === 'pdb-new') { if (leaveGuard()) newProfileDialog(); return; }

    // tables
    const open = el.closest('.pdb-open-btn');
    if (open) {
      if (!leaveGuard()) return;
      const row = S.rows[Number(open.dataset.i)];
      S.view = 'form';
      S.selEl = row.element_id || null;
      syncToolbar();
      try { await loadForm({ plotId: row.plot_id }); } catch (err) { status(err.message, 'err'); }
      return;
    }
    const th = el.closest('th[data-sort]');
    if (th) {
      if (!leaveGuard()) return;
      if (S.sort === th.dataset.sort) S.dir = S.dir === 'asc' ? 'desc' : 'asc';
      else { S.sort = th.dataset.sort; S.dir = 'asc'; }
      S.page = 0;
      refresh();
      return;
    }
    const td = el.closest('td.pdb-editable');
    if (td && editing()) { startCellEdit(td); return; }

    // form
    const nav = el.closest('[data-nav]');
    if (nav) { navigate(nav.dataset.nav); return; }
    if (el.id === 'pdb-save') {
      if (S.view === 'form') saveForm(); else saveTable();
      return;
    }
    if (el.id === 'pdb-cancel') {
      // Drops every unsaved edit and shows the data as stored.
      S.pending.clear();
      S.changed.clear();
      status('');
      try {
        if (S.view === 'form') await loadForm({ plotId: S.record.plot_id });
        else await loadTable();
      } catch (err) { status(err.message, 'err'); }
      return;
    }
    if (el.id === 'pdb-report-btn') { openReport(); return; }
    if (el.id === 'pdb-del-plot') {
      if (!confirm(t('a.db.deleteProfileConfirm', { code: S.record.plot_code || S.record.plot_id }))) return;
      try {
        await api.pdbDeletePlot(S.record.plot_id);
        S.pending.clear();
        S.selEl = null;
        status(t('a.db.deleted'), 'ok');
        await loadForm({ offset: S.formOffset });
      } catch (err) { status(err.message, 'err'); }
      return;
    }
    const delEl = el.closest('[data-del-el]');
    if (delEl) {
      const target = allElements().find((x) => x.element_id === Number(delEl.dataset.delEl));
      if (!target || !confirm(t('a.db.deleteHorizonConfirm', { name: `${target.horizon || ''} ${depths(target)}` }))) return;
      if (dirty() && !(await saveForm())) return;
      try {
        await api.pdbDeleteElement(target.element_id);
        await loadForm({ plotId: S.record.plot_id });
        status(t('a.db.deleted'), 'ok');
      } catch (err) { status(err.message, 'err'); }
      return;
    }
    if (el.id === 'pdb-hz-add') {
      const values = {
        horizon: document.getElementById('pdb-hz-name').value.trim(),
        upper_depth: document.getElementById('pdb-hz-upper').value.trim(),
        lower_depth: document.getElementById('pdb-hz-lower').value.trim(),
        type: document.getElementById('pdb-hz-type').value,
      };
      if (dirty() && !(await saveForm())) return;
      try {
        const res = await api.pdbCreateElement(S.record.plot_id, values);
        S.selEl = res.element_id;
        await loadForm({ plotId: S.record.plot_id });
        status(t('a.db.saved'), 'ok');
      } catch (err) { status(err.message, 'err'); }
      return;
    }
    if (el.id === 'pdb-add-col-btn') {
      const label = document.getElementById('pdb-add-obs').value.trim();
      const obs = M.observations.find((o) => obsFull(o) === label);
      if (!obs) { status(t('a.db.pickProperty'), 'err'); return; }
      S.extraObs.add(obs.observation_num_id);
      setHidden('form', `n:${obs.observation_num_id}`, false);
      status('');
      refreshHorizonsTable();
      return;
    }
    const delPhoto = el.closest('[data-del-photo]');
    if (delPhoto) {
      if (!confirm(t('a.db.deletePhotoConfirm'))) return;
      try {
        const id = Number(delPhoto.dataset.delPhoto);
        await api.pdbDeletePhoto(id);
        S.record.photos = S.record.photos.filter((p) => p.photo_id !== id);
        renderForm();
      } catch (err) { status(err.message, 'err'); }
      return;
    }
    const photo = el.closest('img[data-photo-img]');
    if (photo && root.contains(photo)) { lightbox(Number(photo.dataset.photoImg)); return; }
    const sk = el.closest('[data-sk-el]');
    const hzRow = el.closest('[data-el-row]');
    if (sk || (hzRow && !el.closest('input,select,button'))) {
      const id = Number(sk ? sk.dataset.skEl : hzRow.dataset.elRow);
      if (id !== S.selEl) { S.selEl = id; renderForm(); }
    }
  });

  root.addEventListener('change', async (ev) => {
    const el = ev.target;
    if (el.dataset.colToggle) {
      const table = el.closest('.pdb-colpick').dataset.table;
      setHidden(table, el.dataset.colToggle, !el.checked);
      redrawColumns(table);
      return;
    }
    if (el.id === 'pdb-project') {
      if (!leaveGuard()) { el.value = S.project; return; }
      S.project = el.value; S.page = 0; S.formOffset = 0; S.selEl = null;
      refresh();
      return;
    }
    if (el.id === 'pdb-showall') { S.showAll = el.checked; renderForm(); return; }
    if (el.id === 'pdb-goto') {
      const n = parseInt(el.value, 10);
      if (!Number.isNaN(n)) navigate(Math.min(Math.max(1, n), S.formTotal) - 1);
      return;
    }
    if (el.id === 'pdb-photo-file') { if (el.files.length) uploadPhotos([...el.files]); return; }
    if (!editing() || S.view !== 'form') return;
    if (el.dataset.plot) {
      setPlotValue(el.dataset.plot, el.value.trim() === '' ? null : el.value.trim());
      markDirty();
    } else if (el.dataset.elf) {
      setElementValue(Number(el.dataset.el), el.dataset.elf, el.value.trim());
      markDirty();
    } else if (el.dataset.spf) {
      setSpecimenValue(Number(el.dataset.el), el.dataset.spf, el.value.trim() || null);
      markDirty();
    } else if (el.dataset.desc) {
      // Keep the field on the form even when it has just been emptied.
      S.extra.add(`${el.dataset.desc}:${el.dataset.oid}:${el.dataset.prop}`);
      setDesc(el.dataset.desc, Number(el.dataset.oid), el.dataset.prop, el.value);
      markDirty();
    } else if (el.dataset.addDesc) {
      // Puts an empty field for that property on the form; nothing is
      // recorded until a category is chosen.
      if (M.prop[el.value]) {
        S.extra.add(`${el.dataset.addDesc}:${el.dataset.oid}:${el.value}`);
        renderForm();
      }
    } else if (el.dataset.num) {
      if (setNum(Number(el.dataset.el), Number(el.dataset.num), el.value)) {
        // The value is on screen twice (horizons table and horizon panel).
        root.querySelectorAll(`[data-num="${el.dataset.num}"][data-el="${el.dataset.el}"]`)
          .forEach((i) => { if (i !== el) i.value = el.value.trim(); });
        markDirty();
      }
    } else if (el.dataset.caption) {
      try {
        const id = Number(el.dataset.caption);
        await api.pdbUpdatePhoto(id, { caption: el.value });
        const p = S.record.photos.find((x) => x.photo_id === id);
        if (p) p.caption = el.value.trim() || null;
        status(t('a.db.saved'), 'ok');
      } catch (err) { status(err.message, 'err'); }
    }
  });

  // Pointing at a horizon, in the table or in the sketch, lights up both.
  const hoverHorizon = (ev, on) => {
    const hit = ev.target.closest && ev.target.closest('[data-el-row], [data-sk-el]');
    if (!hit || !root.contains(hit)) return;
    const id = hit.dataset.elRow || hit.dataset.skEl;
    const row = root.querySelector(`[data-el-row="${id}"]`);
    const shape = root.querySelector(`.pdb-sketch [data-sk-el="${id}"]`);
    if (row) row.classList.toggle('pdb-hover', on);
    if (shape) shape.classList.toggle('sk-hover', on);
  };
  root.addEventListener('mouseover', (ev) => hoverHorizon(ev, true));
  root.addEventListener('mouseout', (ev) => hoverHorizon(ev, false));

  root.addEventListener('input', (ev) => {
    if (ev.target.id !== 'pdb-q') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (!leaveGuard()) { ev.target.value = S.q; return; }
      S.q = ev.target.value; S.page = 0; S.formOffset = 0; S.selEl = null;
      refresh();
    }, 300);
  });
}

window.addEventListener('beforeunload', (ev) => {
  if (mounted && dirty()) { ev.preventDefault(); ev.returnValue = ''; }
});

export async function mountProfileDatabase() {
  const root = document.getElementById('pdb-root');
  if (!root) return;
  if (!mounted) {
    root.innerHTML = `<div class="loading">${t('a.loading')}</div>`;
    try {
      indexMeta(await api.pdbMeta());
    } catch (err) {
      root.innerHTML = `<div class="empty-state">${e(err.message)}</div>`;
      return;
    }
    root.innerHTML = shell();
    wire(root);
    mounted = true;
  } else if (!dirty()) {
    // Counts change with every ingest or delete elsewhere in the panel.
    try {
      const meta = await api.pdbMeta();
      indexMeta(meta);
      const sel = document.getElementById('pdb-project');
      if (sel) {
        sel.innerHTML = `<option value="">${t('a.db.allProjects')}</option>` + M.projects.map((p) =>
          `<option value="${e(p.project_id)}">${e(p.name || p.project_id)} (${p.profiles})</option>`).join('');
        if (!M.projects.some((p) => p.project_id === S.project)) S.project = '';
        sel.value = S.project;
      }
    } catch (err) { /* keep what is on screen */ }
  } else {
    return;
  }
  refresh();
}
