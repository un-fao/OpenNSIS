/**
 * Public catalogue page (/catalogue) — every metadata record of the
 * instance, read from pyCSW's OGC API Records endpoint (the same records
 * that live in soil_data.mapset.xml and pyCSW's soil_data.records table,
 * already parsed to JSON and carrying the download / WMS / thumbnail
 * links). Card layout modelled on the ESDAC dataset listing.
 */
import api from './api-client.js';
import { t, setInstanceDefault } from './i18n.js';
import { applyNav, applyBrand, initHeaderControls, applyFooter } from './site-nav.js';
import { showMetadataPopup } from './metadata-popup.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// On the Parcel dev port /collections is not proxied; in production the
// page and pyCSW share the origin (nginx), so baseURL is ''.
const BASE = api.baseURL || '';
const COLLECTION = `${BASE}/collections/metadata:main/items`;

const FILE_GLYPH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

let records = [];

/** Absolute URLs minted inside the containers carry the deploy-time host
 *  (sometimes "localhost"); anything pointing at the instance's own
 *  MapServer is made relative so it works wherever the page is served. */
function ownUrl(href) {
  const i = String(href || '').indexOf('/mapserver');
  return i >= 0 ? href.slice(i) : href;
}

function parseRecord(f) {
  const p = f.properties || {};
  const links = f.links || [];
  const thumb = links.find((l) => (l.protocol || '').includes('image-thumbnail') || l.rel === 'preview');
  const download = links.find((l) => l.rel === 'download');
  const wms = links.find((l) => (l.protocol || '') === 'OGC:WMS');
  const themes = [];
  (p.themes || []).forEach((th) => (th.concepts || []).forEach((c) => {
    if (c.id && !themes.includes(c.id)) themes.push(c.id);
  }));
  const formats = (p.formats || []).map((x) => x.name)
    .filter((n) => n && !n.startsWith('WWW:'));
  const thumbUrl = thumb && ownUrl(thumb.href);
  return {
    id: f.id,
    title: p.title || f.id,
    year: String(p.updated || p.created || '').slice(0, 4),
    type: p.type || '',
    formats,
    themes,
    keywords: p.keywords || [],
    licence: p.license || '',
    thumb: thumbUrl,
    download: download && { href: ownUrl(download.href), name: download.name || 'download' },
    wms: wms && ownUrl(wms.href),
    record: `${COLLECTION}/${encodeURIComponent(f.id)}?f=html`,
    text: '',
    // What the popup renders when /api/raster/metadata has no row for this
    // record (non-raster datasets): the pyCSW record itself, reshaped to
    // the fields formatMetadata() expects.
    meta: {
      title: p.title || f.id,
      abstract: p.description,
      md_browse_graphic: thumbUrl,
      other_constraints: p.license,
      publication_date: p.created,
      revision_date: p.updated !== p.created ? p.updated : null,
      topic_category: themes,
      keyword_theme: p.keywords,
      file_identifier: f.id,
      online_resources: links
        .filter((l) => l.href && !['self', 'collection', 'preview'].includes(l.rel))
        .map((l) => ({ protocol: l.protocol || l.rel, url: ownUrl(l.href),
                       url_name: l.name || l.title, url_description: l.description })),
    },
  };
}

function card(r) {
  const typeLabel = r.type === 'dataset' ? t('site.cat.dataset') : r.type;
  const bullets = [typeLabel, ...r.formats].filter(Boolean)
    .map((x) => `<li>${esc(x)}</li>`).join('');
  const chips = r.keywords.slice(0, 8)
    .map((k) => `<span class="cat-chip">${esc(k)}</span>`).join('');
  const attach = [
    r.download && `<a href="${esc(r.download.href)}">${FILE_GLYPH} ${esc(r.download.name)}</a>`,
    r.wms && `<a href="${esc(r.wms)}" target="_blank" rel="noopener">${t('site.cat.wms')}</a>`,
    `<a class="cat-open" data-id="${esc(r.id)}" href="${esc(r.record)}">${t('site.cat.fullRecord')} →</a>`,
  ].filter(Boolean).join('');
  return `
  <article class="cat-card">
    <a class="cat-thumb cat-open" data-id="${esc(r.id)}" href="${esc(r.record)}">
      ${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
    </a>
    <div class="cat-body">
      <h3 class="cat-title"><a class="cat-open" data-id="${esc(r.id)}" href="${esc(r.record)}">${esc(r.title)}</a></h3>
      <div class="cat-cols">
        <div>
          <p class="cat-field"><strong>${t('site.cat.resourceType')}:</strong></p>
          <ul class="cat-bullets">${bullets}</ul>
          ${r.themes.length ? `<p class="cat-field"><strong>${t('site.cat.theme')}:</strong> ${r.themes.map(esc).join(', ')}</p>` : ''}
          ${r.licence ? `<p class="cat-field"><strong>${t('site.cat.licence')}:</strong> ${esc(r.licence)}</p>` : ''}
        </div>
        <div>
          ${r.year ? `<p class="cat-field"><strong>${t('site.cat.year')}:</strong> ${esc(r.year)}</p>` : ''}
          ${chips ? `<p class="cat-field"><strong>${t('site.cat.keywords')}:</strong></p><span class="cat-chips">${chips}</span>` : ''}
        </div>
      </div>
      <div class="cat-attach">${attach}</div>
    </div>
  </article>`;
}

function render() {
  const list = document.getElementById('cat-list');
  const empty = document.getElementById('cat-empty');
  const q = document.getElementById('cat-search').value.trim().toLowerCase();
  const year = document.getElementById('cat-year').value;
  const kw = document.getElementById('cat-kw').value;
  const shown = records.filter((r) =>
    (!q || r.text.includes(q))
    && (!year || r.year === year)
    && (!kw || r.keywords.includes(kw)));
  document.getElementById('cat-count').textContent = t('site.cat.count', { n: shown.length });
  list.innerHTML = shown.map(card).join('');
  empty.style.display = shown.length ? 'none' : '';
  empty.textContent = t('site.cat.empty');
}

/** Year and keyword dropdowns, built from what the records actually carry. */
function fillFilters() {
  const years = [...new Set(records.map((r) => r.year).filter(Boolean))]
    .sort((a, b) => b.localeCompare(a));
  const kws = [...new Set(records.flatMap((r) => r.keywords))]
    .sort((a, b) => a.localeCompare(b));
  const fill = (id, label, values) => {
    const sel = document.getElementById(id);
    sel.innerHTML = `<option value="">${esc(label)}</option>`
      + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    sel.addEventListener('change', render);
  };
  fill('cat-year', t('site.cat.anyYear'), years);
  fill('cat-kw', t('site.cat.anyKeyword'), kws);
}

async function init() {
  let pages = null;
  let siteContent = null;
  try {
    const site = (await api.getSite()) || {};
    siteContent = site.content;
    pages = siteContent?.pages;
    setInstanceDefault((site.language || '').trim().toLowerCase());
    applyBrand(site);
    applyFooter(site);
  } catch (e) { /* nav stays muted */ }
  initHeaderControls();
  applyNav('catalogue', pages, siteContent);
  document.getElementById('cat-title').textContent = t('site.nav.catalogue');
  const search = document.getElementById('cat-search');
  search.placeholder = t('site.cat.search');
  search.addEventListener('input', render);

  const list = document.getElementById('cat-list');
  // Record clicks open the same metadata popup as the map view's metadata
  // icon; the href (the raw pyCSW record) stays for middle-click / no JS.
  list.addEventListener('click', (ev) => {
    const a = ev.target.closest('a.cat-open');
    if (a) {
      ev.preventDefault();
      const r = records.find((x) => x.id === a.dataset.id);
      if (r) showMetadataPopup(`/api/raster/metadata/${encodeURIComponent(r.id)}`, r.meta);
      return;
    }
    // A keyword chip sets the keyword filter.
    const chip = ev.target.closest('.cat-chip');
    if (chip) {
      const sel = document.getElementById('cat-kw');
      sel.value = sel.value === chip.textContent ? '' : chip.textContent;
      render();
    }
  });

  const empty = document.getElementById('cat-empty');
  try {
    const res = await fetch(`${COLLECTION}?f=json&limit=1000`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    records = (data.features || []).map(parseRecord);
    records.forEach((r) => {
      r.text = [r.title, r.year, r.licence, ...r.themes, ...r.keywords].join(' ').toLowerCase();
    });
    records.sort((a, b) => (b.year || '').localeCompare(a.year || '')
      || a.title.localeCompare(b.title));
    fillFilters();
    render();
  } catch (e) {
    console.error('Catalogue load failed:', e);
    empty.textContent = t('site.cat.loadFailed');
  }
}

init();
