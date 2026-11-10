/**
 * Formatted metadata view for a sampling design — one renderer shared by
 * the map popup and the admin tab. Built from the structured manifest
 * (falling back to the plain abstract for designs generated before the
 * manifest carried display names).
 */
import { t } from './i18n.js';

const e = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function crsLabel(crs) {
  const m = /\+proj=laea \+lat_0=([-\d.]+) \+lon_0=([-\d.]+)/.exec(crs || '');
  if (m) return `LAEA (equal-area), centred ${Number(m[2]).toFixed(2)}, ${Number(m[1]).toFixed(2)}`;
  return crs || '';
}

export function formatSamplingMeta(name, manifest, abstract) {
  if (!manifest) {
    return `<h3 style="margin-top:0;">${e(name)}</h3>
      <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.55;margin:0;">${e(abstract || '')}</pre>`;
  }
  const p = manifest.params || {};
  const q = manifest.quality || {};
  const row = (label, val) => val == null || val === '' ? '' :
    `<tr><th style="text-align:left;padding:3px 14px 3px 0;color:var(--color-text-muted);font-weight:600;white-space:nowrap;vertical-align:top;">${e(label)}</th>
         <td style="padding:3px 0;">${val}</td></tr>`;
  const region = manifest.region_polygon_vertices
    ? `${t('a.sd.metaPolygon', {n: manifest.region_polygon_vertices})} · [${(manifest.region_bbox || []).map((v) => Number(v).toFixed(2)).join(', ')}]`
    : (manifest.region_bbox ? `[${manifest.region_bbox.map((v) => Number(v).toFixed(2)).join(', ')}]` : '');

  const stages = `
    <ol style="margin:4px 0 0;padding-left:1.3em;line-height:1.5;">
      <li>${e(t('a.sd.metaStage1', {n: p.n_psu || '?', size: p.psu_size_m || 2000}))}
        <span style="color:var(--color-text-muted);">(${e((manifest.covariates_stage1 || []).join(', '))})</span></li>
      <li>${e(t('a.sd.metaStage2', {n: p.ssu_per_psu || '?', size: p.ssu_size_m || 100}))}</li>
      <li>${e(t('a.sd.metaStage3', {n: p.pts_per_ssu || '?'}))}</li>
    </ol>`;

  const srcRows = (manifest.sources || []).map((s) => {
    const label = s.name || s.id;
    const href = s.link || s.url || s.url_base || (s.stac ? s.stac.split(' ')[0] : '');
    return `<tr>
      <td style="padding:3px 12px 3px 0;">${href
        ? `<a href="${e(href)}" target="_blank" rel="noopener">${e(label)}</a>` : e(label)}</td>
      <td style="padding:3px 12px 3px 0;white-space:nowrap;">${e(s.licence || '')}</td>
      <td style="padding:3px 0;font-family:var(--font-mono,monospace);font-size:12px;">${e(s.checksum || '')}</td>
    </tr>`;
  }).join('');

  return `
    <h3 style="margin:0 0 2px;">${e(name)}</h3>
    <p style="margin:0 0 12px;color:var(--color-text-muted);font-size:13.5px;">${e(manifest.method || '')}</p>
    <table style="border-collapse:collapse;font-size:14px;">
      ${row(t('a.sd.metaGenerated'), e((manifest.generated_at || '').replace('T', ' ').slice(0, 16)))}
      ${row(t('a.country'), e(manifest.iso3))}
      ${row(t('a.sd.metaRegion'), e(region))}
      ${row(t('a.sd.metaProjection'), e(crsLabel(manifest.crs)))}
      ${row(t('a.sd.seed'), e(manifest.seed))}
      ${row(t('a.sd.metaConstraint'), p.cropland_only === false ? e(t('a.sd.metaNoConstraint')) : e(t('a.sd.croplandOnly')))}
      ${row(t('a.sd.metaQuality'), q.stage1_mssd != null ? e(Number(q.stage1_mssd).toFixed(4)) + ' (MSSD)' : '')}
    </table>
    <h4 style="margin:14px 0 2px;">${e(t('a.sd.metaStages'))}</h4>
    ${stages}
    <h4 style="margin:14px 0 4px;">${e(t('a.sd.sources'))}</h4>
    <p style="margin:0 0 6px;color:var(--color-text-muted);font-size:12.5px;">${e(t('a.sd.ephemeral'))}</p>
    <table style="border-collapse:collapse;font-size:13.5px;">
      <tr>
        <th style="text-align:left;padding:3px 12px 3px 0;color:var(--color-text-muted);">${e(t('a.sd.sources'))}</th>
        <th style="text-align:left;padding:3px 12px 3px 0;color:var(--color-text-muted);">${e(t('a.licence'))}</th>
        <th style="text-align:left;padding:3px 0;color:var(--color-text-muted);">${e(t('a.sd.metaChecksum'))}</th>
      </tr>
      ${srcRows}
    </table>`;
}
