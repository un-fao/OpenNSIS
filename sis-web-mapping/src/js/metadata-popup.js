/**
 * Shared metadata popup — the modal opened by the map layer panel's
 * metadata icon, reused by the public catalogue's record links. Fetches
 * the rich JSON from /api/raster/metadata/<id> and renders it; a caller
 * may pass fallback data (e.g. the pyCSW record itself, reshaped) that is
 * rendered instead when that endpoint has no row for the record.
 */
import api from './api-client.js';
import { t } from './i18n.js';

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function safeUrl(url) {
  if (!url) return '#';
  try {
    const u = new URL(url, window.location.origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '#';
  } catch (e) { return '#'; }
}

// MapServer URLs are emitted server-side as absolute http://localhost/mapserver/…
// (the API's MAPSERVER_WMS_URL), which points at the visitor's own machine, not
// the SIS host — so preview images and WMS links fail to load. Strip the origin
// so the browser requests /mapserver/… on whatever origin served the app.
function relMapserverUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url, window.location.origin);
    return /\/mapserver\b/.test(u.pathname) ? (u.pathname + u.search) : url;
  } catch (e) { return url; }
}

// Restrictive mailto: builder — only allow simple email-shaped strings.
function safeMailto(addr) {
  if (typeof addr !== 'string') return '#';
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(addr) ? `mailto:${addr}` : '#';
}

// Helper: 2-column section with rows, with optional raw HTML in value cell.
function sectionTable(title, rows, e, raw = false) {
  if (!rows.length) return '';
  let html = `<div style="margin:18px 0;"><h4 style="color:var(--color-text);margin-bottom:8px;">${e(title)}</h4>
    <table style="width:100%;border-collapse:collapse;">`;
  rows.forEach(([k, v]) => {
    const valueCell = raw ? v : e(String(v));
    html += `<tr style="border-bottom:1px solid var(--color-border);">
      <td style="padding:6px 8px;font-weight:bold;color:var(--color-text-muted);width:32%;vertical-align:top;">${e(k)}</td>
      <td style="padding:6px 8px;">${valueCell}</td>
    </tr>`;
  });
  html += `</table></div>`;
  return html;
}

export function formatMetadata(m) {
  // m is the rich JSON from /api/raster/metadata/<layer_id>. Every value
  // round-trips from soil_data.* so escape on output as a precaution.
  const e = escapeHtml;
  let html = '';

  const title = m.title || m.costum_name || m.layer_id;
  if (title) {
    // Route through the nginx gateway (api.baseURL) so the link works when
    // the SPA is served from a port that doesn't itself proxy /collections/.
    const xmlHref = m.file_identifier
      ? `${api.baseURL}/collections/metadata:main/items/${encodeURIComponent(m.file_identifier)}?f=xml`
      : null;
    const xmlBtn = xmlHref
      ? `<a href="${e(xmlHref)}" download="${e((m.layer_id || 'metadata') + '.xml')}"
            style="font-size:13px;font-weight:normal;padding:4px 10px;background:var(--color-primary,#2c5f2d);color:#fff;border-radius:4px;text-decoration:none;margin-left:12px;white-space:nowrap;"
            title="${t('meta.downloadXml')}">⬇ XML</a>`
      : '';
    html += `<h3 style="margin-top:0;color:var(--color-text);border-bottom:2px solid var(--color-primary);padding-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
      <span style="flex:1;">${e(title)}</span>${xmlBtn}
    </h3>`;
  }

  if (m.abstract || m.project_description) {
    const text = m.abstract || m.project_description;
    html += `<div style="margin:15px 0;padding:10px;background:var(--color-surface-alt);border-left:3px solid var(--color-primary);border-radius:3px;">
      <strong>${t('meta.abstract')}</strong>
      <p style="margin:8px 0 0 0;line-height:1.6;white-space:pre-line;">${e(text)}</p>
    </div>`;
  }

  // Browse-graphic / thumbnail (WMS GetMap JPEG)
  if (m.md_browse_graphic) {
    const safe = safeUrl(relMapserverUrl(m.md_browse_graphic));
    html += `<div style="margin:15px 0;text-align:center;">
      <a href="${e(safe)}" target="_blank" rel="noopener noreferrer" title="${t('meta.openPreview')}">
        <img src="${e(safe)}" alt="${t('meta.preview')}"
             style="max-width:100%;max-height:320px;border:1px solid var(--color-border-strong);border-radius:4px;background:#fff;">
      </a>
    </div>`;
  }

  // ---------- Identification ----------
  const idRows = [
    [t('meta.f.country'),         m.country_name ? `${m.country_name} (${m.country_id || ''})` : m.country_id],
    [t('meta.f.mapsetId'),       m.mapset_id],
    [t('meta.f.layerId'),        m.layer_id],
    [t('meta.f.project'),         m.project_name ? `${m.project_name} (${m.project_id || ''})` : m.project_id],
    [t('meta.f.soilProperty'),   m.property_name ? `${m.property_name} (${m.property_num_id || ''})` : m.property_num_id],
    [t('meta.f.unit'),            m.unit_of_measure_id],
    [t('meta.f.depth'),           m.dimension_depth ? `${m.dimension_depth} cm` : ''],
    [t('meta.f.statistic'),       m.dimension_stats],
    [t('meta.f.status'),          m.status],
    [t('meta.f.updateFrequency'), m.update_frequency],
    [t('meta.f.spatialType'),    m.spatial_representation_type_code],
    [t('meta.f.presentation'),    m.presentation_form],
    [t('meta.f.scope'),           m.scope_code],
    [t('meta.f.topicCategories'), Array.isArray(m.topic_category) ? m.topic_category.join(', ') : m.topic_category],
  ].filter(r => r[1] != null && r[1] !== '');
  html += sectionTable(t('meta.sec.identification'), idRows, e);

  // ---------- Dates ----------
  const dateRows = [
    [t('meta.f.createdOn'),     m.publication_date || m.creation_date],
    [t('meta.f.periodStart'),   m.time_period_begin],
    [t('meta.f.periodEnd'),     m.time_period_end],
    [t('meta.f.revisionDate'),  m.revision_date],
  ].filter(r => r[1]);
  if (dateRows.length) html += sectionTable(t('meta.sec.dates'), dateRows, e);

  // ---------- Spatial ----------
  const bbox = (m.west_bound_longitude != null) ? `
    <div style="font-family:monospace;font-size:13px;">
      W ${e(String(m.west_bound_longitude))}° / E ${e(String(m.east_bound_longitude))}°<br>
      S ${e(String(m.south_bound_latitude))}° / N ${e(String(m.north_bound_latitude))}°
    </div>` : '';
  const spatialRows = [
    [t('meta.f.crs'),        m.epsg ? `EPSG:${m.epsg}` : m.spatial_reference],
    [t('meta.f.resolution'), (m.distance != null) ? `${m.distance} ${m.distance_uom || ''}` : ''],
    [t('meta.f.bbox'), bbox],
    [t('meta.f.rasterSize'), (m.raster_size_x && m.raster_size_y) ? `${m.raster_size_x} × ${m.raster_size_y} px` : ''],
    [t('meta.f.dataType'),  m.data_type],
    [t('meta.f.nodata'),     m.no_data_value != null ? String(m.no_data_value) : ''],
  ].filter(r => r[1]);
  if (spatialRows.length) html += sectionTable(t('meta.sec.spatial'), spatialRows, e, /*raw=*/true);

  // ---------- Statistics ----------
  if (m.stats_minimum != null || m.stats_maximum != null) {
    const statsRows = [
      [t('meta.f.min'),  m.stats_minimum],
      [t('meta.f.max'),  m.stats_maximum],
      [t('meta.f.mean'), m.stats_mean],
      [t('meta.f.std'),  m.stats_std_dev],
    ].filter(r => r[1] != null);
    html += sectionTable(t('meta.sec.statistics'), statsRows, e);
  }

  // ---------- Keywords ----------
  const kw = (arr) => Array.isArray(arr) ? arr : (arr ? [arr] : []);
  const allKw = [
    ...kw(m.keyword_theme).map(k => ['theme', k]),
    ...kw(m.keyword_discipline).map(k => ['discipline', k]),
    ...kw(m.keyword_place).map(k => ['place', k]),
  ];
  if (allKw.length) {
    html += `<div style="margin:18px 0;"><h4 style="color:var(--color-text);margin-bottom:8px;">Keywords</h4>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">`
      + allKw.map(([type, k]) =>
          `<span style="background:var(--color-primary-light);color:var(--color-primary);padding:4px 10px;border-radius:14px;font-size:12px;" title="${e(type)}">${e(k)}</span>`
        ).join('')
      + `</div></div>`;
  }

  // ---------- Constraints / license ----------
  const constrRows = [
    [t('meta.f.licence'), m.other_constraints],
    [t('meta.f.accessConstraints'),          m.access_constraints],
    [t('meta.f.useConstraints'),             m.use_constraints],
  ].filter(r => r[1]);
  if (constrRows.length) html += sectionTable(t('meta.sec.constraints'), constrRows, e);

  // ---------- Lineage ----------
  if (m.lineage_statement) {
    html += `<div style="margin:18px 0;"><h4 style="color:var(--color-text);margin-bottom:8px;">Lineage</h4>
      <div style="padding:10px;background:var(--color-surface-alt);border-radius:3px;line-height:1.5;">${e(m.lineage_statement)}</div></div>`;
  }

  // ---------- Contacts ----------
  if (Array.isArray(m.contacts) && m.contacts.length) {
    html += `<div style="margin:18px 0;"><h4 style="color:var(--color-text);margin-bottom:8px;">Contacts</h4>`;
    m.contacts.forEach(c => {
      html += `<div style="margin-bottom:10px;padding:10px;background:var(--color-surface-alt);border-radius:5px;border-left:3px solid var(--color-success);">
        <div style="font-weight:bold;color:var(--color-text);">${e(c.individual_id || '')} · ${e(c.organisation_id || '')}</div>
        ${c.position ? `<div><strong>Position:</strong> ${e(c.position)}</div>` : ''}
        ${c.role ? `<div><strong>Role:</strong> ${e(c.role)}${c.tag ? ' / ' + e(c.tag) : ''}</div>` : ''}
        ${c.organisation_country || c.organisation_city ? `<div style="color:var(--color-text-muted);font-size:13px;">${e([c.organisation_city, c.organisation_country].filter(Boolean).join(', '))}</div>` : ''}
        ${c.individual_email ? `<div><strong>Email:</strong> <a href="${e(safeMailto(c.individual_email))}" style="color:var(--color-primary);">${e(c.individual_email)}</a></div>` : ''}
      </div>`;
    });
    html += `</div>`;
  }

  // ---------- Online resources ----------
  if (Array.isArray(m.online_resources) && m.online_resources.length) {
    html += `<div style="margin:18px 0;"><h4 style="color:var(--color-text);margin-bottom:8px;">${t('meta.onlineResources')}</h4>
      <div style="display:flex;flex-direction:column;gap:6px;">`
      + m.online_resources.map(u => {
          const icon = u.protocol?.startsWith('WWW:LINK') || u.protocol?.startsWith('WWW:DOWNLOAD') ? '📥' : '🔗';
          return `<a href="${e(safeUrl(relMapserverUrl(u.url)))}" target="_blank" rel="noopener noreferrer" style="padding:8px;background:var(--color-surface);border:1px solid var(--color-border-strong);border-radius:4px;text-decoration:none;color:var(--color-text);display:flex;gap:10px;align-items:center;">
            <span style="font-size:18px;">${icon}</span>
            <div style="flex:1;">
              <div style="font-weight:600;">${e(u.url_name || u.protocol)}</div>
              <div style="font-size:12px;color:var(--color-text-muted);">${e(u.protocol)}</div>
              ${u.url_description ? `<div style="font-size:12px;color:var(--color-text-muted);">${e(u.url_description)}</div>` : ''}
            </div>
          </a>`;
        }).join('')
      + `</div></div>`;
  }

  // ---------- Footer: file identifier ----------
  if (m.file_identifier) {
    html += `<div style="margin-top:20px;font-size:11px;color:var(--color-text-muted);font-family:monospace;">file identifier: ${e(m.file_identifier)}</div>`;
  }

  return html;
}

export async function showMetadataPopup(metadataUrl, fallbackData = null) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 20px;';
  modal.innerHTML = `
    <div style="background: var(--color-surface); color: var(--color-text); padding: 20px; border-radius: 8px; max-width: 880px; max-height: 90vh; overflow-y: auto; position: relative; width: 100%;">
      <button id="metadata-close" style="position: absolute; top: 10px; right: 10px; background: none; border: none; font-size: 24px; cursor: pointer; color: var(--color-text-muted);">&times;</button>
      <h2 style="margin-top: 0;">${t('meta.title')}</h2>
      <div id="metadata-content" style="margin-top: 20px;">${t('meta.loading')}</div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('metadata-close').addEventListener('click', () => document.body.removeChild(modal));
  modal.addEventListener('click', (e) => { if (e.target === modal) document.body.removeChild(modal); });

  try {
    // metadataUrl is `/api/raster/metadata/<id>` — needs the SPA's API key.
    const url = metadataUrl.startsWith('http')
      ? metadataUrl
      : `${api.baseURL}${metadataUrl}`;
    const response = await fetch(url, { headers: { 'X-API-Key': api.apiKey } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const metadata = await response.json();
    document.getElementById('metadata-content').innerHTML = formatMetadata(metadata);
  } catch (error) {
    if (fallbackData) {
      // Not a raster layer (or the lookup failed) — render what the
      // catalogue record itself carries.
      document.getElementById('metadata-content').innerHTML = formatMetadata(fallbackData);
      return;
    }
    console.error('Failed to load metadata:', error);
    document.getElementById('metadata-content').innerHTML =
      `<p style="color: var(--color-danger);">Failed to load metadata: ${escapeHtml(error.message)}</p>`;
  }
}
