import 'ol/ol.css';
import Map from 'ol/Map';
import View from 'ol/View';
import { Tile as TileLayer, Image as ImageLayer, Vector as VectorLayer } from 'ol/layer';
import { OSM, XYZ, ImageWMS, Vector as VectorSource, Cluster } from 'ol/source';
import { fromLonLat, toLonLat } from 'ol/proj';
import { ScaleLine, defaults as defaultControls } from 'ol/control';
import Overlay from 'ol/Overlay';
import { Circle as CircleStyle, Fill, Icon, RegularShape, Stroke, Style, Text } from 'ol/style';
import { GeoJSON } from 'ol/format';
import { getCenter } from 'ol/extent';
import api, { MAPSERVER_URL } from './api-client.js';
import adminDashboard from './admin-dashboard.js';
import { t, AVAILABLE, currentLang, setInstanceDefault, switchLanguage } from './i18n.js';

// Global variables
let map;
let appConfig = {};
let currentLayers = {};
let profileLayers = {};
let profileColors = {};
let profileMapsetIds = {};
let profileSymbology = {};             // mapset_id -> {shape,size,color,opacity} (admin-set)
let blurredMapsetIds = new Set();        // mapset_ids whose profile coords are blurred
let locationsOnlyMapsetIds = new Set();  // mapset_ids sharing points only, no attribute data
let hideDownloadMapsetIds = new Set();   // mapset_ids whose per-project download button is hidden
let activeLayer = null;
let activePopup = null;   // the map info-popup overlay (set in setupPopup)

// Close the map info-popup if it's open. Called whenever the active raster
// layer changes or is unselected, so a stale popup doesn't linger.
function closeInfoPopup() {
  if (activePopup) activePopup.setPosition(undefined);
}

// ==================== Initialization ====================

async function initializeApp() {
  try {
    console.log('Starting application initialization...');
    showLoading(true);

    // Load settings from API
    console.log('Fetching settings...');
    const settings = await api.getSettings();
    console.log('Settings loaded:', settings);
    appConfig = settingsArrayToObject(settings);
    setInstanceDefault((appConfig.LANGUAGE || '').trim().toLowerCase());
    applyStaticTranslations();

    // Apply settings to UI
    applySettings();

    // Initialize map
    console.log('Initializing map...');
    initializeMap();

    // Load layers from API
    console.log('Loading layers...');
    await loadLayers();

    // Load profiles
    console.log('Loading profiles...');
    await loadProfiles();

    // Administrative division boundaries — listed inside the "Base layers"
    // group (which loadLayers has already built).
    console.log('Loading administrative divisions...');
    await loadAdminDivisions();

    // Setup UI controls
    setupControls();

    // Check if user is logged in
    // if (api.restoreSession()) {
    //   showAdminPanel();
    // }
    api.restoreSession();

    console.log('Application initialized successfully!');
    showLoading(false);
  } catch (error) {
    console.error('Failed to initialize app:', error);
    console.error('Error details:', error.message, error.stack);
    showError(t('err.loadApp') + error.message);
    showLoading(false);
  }
}

function settingsArrayToObject(settingsArray) {
  const config = {};
  settingsArray.forEach(s => config[s.key] = s.value);
  return config;
}

function applySettings() {
  // Update logo
  if (appConfig.ORG_LOGO_URL) {
    document.querySelector('.header .logo').src = appConfig.ORG_LOGO_URL;
  }

  // Update title
  if (appConfig.APP_TITLE) {
    document.querySelector('.header h1').textContent = appConfig.APP_TITLE;
    document.title = appConfig.APP_TITLE;
  }
}

// ==================== Map Initialization ====================

function initializeMap() {
  const latitude = parseFloat(appConfig.LATITUDE || 27.5);
  const longitude = parseFloat(appConfig.LONGITUDE || 89.7);
  const zoom = parseInt(appConfig.ZOOM || 9);

  // Base layers
  const baseLayers = {
    'esri-imagery': new TileLayer({
      source: new XYZ({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attributions: 'Tiles © Esri'
      }),
      visible: appConfig.BASE_MAP_DEFAULT === 'esri-imagery'
    }),
    'osm': new TileLayer({
      source: new OSM(),
      visible: appConfig.BASE_MAP_DEFAULT === 'osm'
    }),
    'terrain': new TileLayer({
      source: new XYZ({
        url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
        attributions: '© OpenTopoMap'
      }),
      visible: appConfig.BASE_MAP_DEFAULT === 'terrain'
    }),
    // Neutral hillshade backdrop — EOX::Maps Terrain Light (WMTS via the
    // XYZ-compatible REST endpoint; rendering CC-BY 4.0).
    'eox-terrain-light': new TileLayer({
      source: new XYZ({
        url: 'https://tiles.maps.eox.at/wmts/1.0.0/terrain-light_3857/default/g/{z}/{y}/{x}.jpg',
        attributions: 'Terrain Light © EOX (CC-BY 4.0), data © OpenStreetMap contributors and others',
        maxZoom: 16
      }),
      visible: appConfig.BASE_MAP_DEFAULT === 'eox-terrain-light'
    })
  };

  map = new Map({
    target: 'map',
    layers: Object.values(baseLayers),
    view: new View({
      center: fromLonLat([longitude, latitude]),
      zoom: zoom
    }),
    controls: defaultControls({ 
      attribution: false,
      zoom: false  // Add this to remove default zoom controls
    }).extend([
      new ScaleLine({ target: 'scale-line' })
    ])
  });

  // Store base layers for later use
  map.set('baseLayers', baseLayers);
  updateControlTheme(appConfig.BASE_MAP_DEFAULT || 'esri-imagery');

  // Instance preference: start with the layer panel collapsed (burger only).
  if (appConfig.LAYER_PANEL_COLLAPSED === 'true') {
    const ls = document.getElementById('layer-switcher');
    if (ls) ls.classList.add('collapsed');
  }

  // Setup popup
  setupPopup();
}

// ==================== Layer Loading ====================

async function loadLayers() {
  try {
    const layers = await api.getLayers();
    
    // Group layers by project_name
    const groupedLayers = layers.reduce((acc, layer) => {
      const group = layer.project_name || 'Rasters';
      if (!acc[group]) {
        acc[group] = [];
      }
      acc[group].push(layer);
      return acc;
    }, {});

    // Create layer groups in UI
    const layerGroupsContainer = document.getElementById('layer-groups');
    layerGroupsContainer.innerHTML = '';

    // Add data layer groups
    for (const [groupName, groupLayers] of Object.entries(groupedLayers)) {
      addLayerGroup(layerGroupsContainer, groupName, groupLayers);
    }

    // Add base maps group last
    addBaseMapsGroup(layerGroupsContainer);

    // Load default layer if one is flagged in the layer list
    const defaultLayer = layers.find(l => l.is_default);
    if (defaultLayer) {
      const radio = document.getElementById(`layer-${defaultLayer.layer_id}`);
      if (radio) {
        radio.checked = true;
        switchLayer(defaultLayer);
      }
    }

  } catch (error) {
    console.error('Failed to load layers:', error);
    showError(t('err.loadLayers'));
  }
}

// ==================== Administrative divisions ====================
// Admin-uploaded polygon boundary layers, drawn as client-side vector layers
// (no MapServer involvement) with the symbology configured in the admin
// panel. Geometry loads lazily on the first tick of each layer's checkbox.

let adminDivisionLayers = {};   // division_id -> { layer, loaded }

function hexToRgba(hex, alpha) {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex || '');
  if (!m) return `rgba(204, 204, 204, ${alpha})`;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

function adminDivisionLineDash(strokeType, width) {
  const w = Math.max(Number(width) || 1.5, 1);
  switch (strokeType) {
    case 'dashed':   return [6 * w, 4 * w];
    case 'dotted':   return [1, 3 * w];
    case 'dash-dot': return [8 * w, 3 * w, 1, 3 * w];
    default:         return undefined;   // solid / continuous
  }
}

function adminDivisionStyle(d) {
  const base = new Style({
    stroke: new Stroke({
      color: d.stroke_color || '#444444',
      width: Number(d.stroke_width) || 1.5,
      lineDash: adminDivisionLineDash(d.stroke_type, d.stroke_width),
      lineCap: d.stroke_type === 'dotted' ? 'round' : 'butt'
    }),
    fill: new Fill({
      color: hexToRgba(d.fill_color || '#cccccc',
                       d.fill_opacity == null ? 0 : Number(d.fill_opacity))
    })
  });
  if (!d.label_attribute) return base;
  // Text label per feature from the admin-chosen attribute; dark text with a
  // light halo stays readable over any basemap. Cached per value.
  const cache = {};
  return (feature) => {
    const v = feature.get(d.label_attribute);
    if (v == null || v === '') return base;
    const key = String(v);
    if (!cache[key]) {
      cache[key] = [base, new Style({
        text: new Text({
          text: key,
          font: '12px system-ui, sans-serif',
          fill: new Fill({ color: '#2b2b2b' }),
          stroke: new Stroke({ color: 'rgba(255,255,255,0.85)', width: 3 }),
          overflow: false
        })
      })];
    }
    return cache[key];
  };
}

async function loadAdminDivisions() {
  let divisions = [];
  try {
    divisions = await api.getAdminDivisions();
  } catch (error) {
    console.error('Failed to load administrative divisions:', error);
    return;
  }
  if (!divisions.length) return;

  // The division layers live inside the "Base layers" group, listed above
  // the basemap radios.
  const baseGroup = document.getElementById('base-layers-group');
  const contentDiv = baseGroup && baseGroup.querySelector('.layer-group-content');
  if (!contentDiv) {
    console.error('Base layers group not found — cannot list administrative divisions');
    return;
  }
  const frag = document.createDocumentFragment();

  divisions.forEach(d => {
    const item = document.createElement('div');
    item.className = 'layer-item';
    const cbId = `admdiv-${d.division_id}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = cbId;
    const label = document.createElement('label');
    label.htmlFor = cbId;
    label.textContent = d.name;
    item.appendChild(cb);
    item.appendChild(label);
    frag.appendChild(item);

    // Above rasters (ImageLayers, zIndex 0) but under profile clusters (1000).
    const layer = new VectorLayer({
      source: new VectorSource(),
      style: adminDivisionStyle(d),
      zIndex: 900,
      visible: false,
      // Zoom visibility: render only when zoomed in beyond this level
      // (NULL/0 = always). The checkbox still controls overall visibility.
      minZoom: (d.min_zoom != null && d.min_zoom > 0) ? d.min_zoom : -Infinity
    });
    map.addLayer(layer);
    adminDivisionLayers[d.division_id] = { layer, loaded: false };

    const applyVisibility = async (checked) => {
      const entry = adminDivisionLayers[d.division_id];
      if (checked && !entry.loaded) {
        try {
          const fc = await api.getAdminDivisionGeoJson(d.division_id);
          entry.layer.getSource().addFeatures(
            new GeoJSON().readFeatures(fc, { featureProjection: 'EPSG:3857' }));
          entry.loaded = true;
        } catch (err) {
          console.error('Failed to load division layer:', err);
          cb.checked = false;
          return;
        }
      }
      entry.layer.setVisible(checked);
    };
    cb.addEventListener('change', (e) => applyVisibility(e.target.checked));

    // Published layers start ticked unless the admin set Active = No.
    // Deliberately not awaited — geometry downloads must not delay start-up.
    const startActive = d.active_default !== false;
    cb.checked = startActive;
    if (startActive) applyVisibility(true);
  });

  contentDiv.insertBefore(frag, contentDiv.firstChild);
}

function addBaseMapsGroup(container) {
  const groupDiv = document.createElement('div');
  groupDiv.className = 'layer-group collapsed';
  groupDiv.id = 'base-layers-group';
  groupDiv.innerHTML = `
    <div class="layer-group-header">${t('groups.baseLayers')}</div>
    <div class="layer-group-content">
      <div class="layer-item">
        <input type="radio" name="basemap" id="basemap-esri" value="esri-imagery" 
               ${appConfig.BASE_MAP_DEFAULT === 'esri-imagery' ? 'checked' : ''}>
        <label for="basemap-esri">${t('basemap.satellite')}</label>
      </div>
      <div class="layer-item">
        <input type="radio" name="basemap" id="basemap-osm" value="osm"
               ${appConfig.BASE_MAP_DEFAULT === 'osm' ? 'checked' : ''}>
        <label for="basemap-osm">${t('basemap.osm')}</label>
      </div>
      <div class="layer-item">
        <input type="radio" name="basemap" id="basemap-terrain" value="terrain"
               ${appConfig.BASE_MAP_DEFAULT === 'terrain' ? 'checked' : ''}>
        <label for="basemap-terrain">${t('basemap.terrain')}</label>
      </div>
      <div class="layer-item">
        <input type="radio" name="basemap" id="basemap-eox" value="eox-terrain-light"
               ${appConfig.BASE_MAP_DEFAULT === 'eox-terrain-light' ? 'checked' : ''}>
        <label for="basemap-eox">${t('basemap.eox')}</label>
      </div>
    </div>
  `;

  container.appendChild(groupDiv);

  // Add event listeners for basemap switching
  groupDiv.querySelectorAll('input[name="basemap"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      switchBasemap(e.target.value);
    });
  });

  // Make group collapsible (expanded by default)
  groupDiv.querySelector('.layer-group-header').addEventListener('click', () => {
    groupDiv.classList.toggle('collapsed');
  });
}

function groupDisplayName(name) {
  // Historic project-name override, now also the translation hook.
  if (name === 'Soil Nutrients') return t('groups.maps');
  return name;
}

function addLayerGroup(container, groupName, layers) {
  const groupDiv = document.createElement('div');
  groupDiv.className = 'layer-group';
  const displayName = groupDisplayName(groupName);

  const headerDiv = document.createElement('div');
  headerDiv.className = 'layer-group-header';
  headerDiv.textContent = displayName;
  groupDiv.appendChild(headerDiv);

  const contentDiv = document.createElement('div');
  contentDiv.className = 'layer-group-content';

  // Tag filter (driven by layer.keywords) — shown for any group that has keywords
  let activeTags = new Set();
  {
    const allTags = new Set();
    layers.forEach(l => (l.keywords || []).forEach(k => k && allTags.add(k)));
    if (allTags.size > 0) {
      const filterWrapper = document.createElement('div');
      filterWrapper.className = 'layer-tag-filter-wrapper';

      const filterToggle = document.createElement('div');
      filterToggle.className = 'layer-tag-filter-toggle';
      filterToggle.textContent = t('layers.filterByKeywords');
      filterWrapper.appendChild(filterToggle);

      const filterDiv = document.createElement('div');
      filterDiv.className = 'layer-tag-filter';
      Array.from(allTags).sort().forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'layer-tag';
        chip.textContent = tag;
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          if (activeTags.has(tag)) {
            activeTags.delete(tag);
            chip.classList.remove('active');
          } else {
            activeTags.add(tag);
            chip.classList.add('active');
          }
          applyTagFilter();
        });
        filterDiv.appendChild(chip);
      });
      filterWrapper.appendChild(filterDiv);

      filterToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        filterWrapper.classList.toggle('collapsed');
      });

      contentDiv.appendChild(filterWrapper);
    }
  }

  const itemByLayerId = {};
  layers.forEach(layer => {
    const layerItem = createLayerItem(layer);
    itemByLayerId[layer.layer_id] = { el: layerItem, keywords: layer.keywords || [] };
    contentDiv.appendChild(layerItem);
  });

  function applyTagFilter() {
    Object.values(itemByLayerId).forEach(({ el, keywords }) => {
      const visible = activeTags.size === 0 ||
        keywords.some(k => activeTags.has(k));
      el.style.display = visible ? '' : 'none';
    });
  }

  groupDiv.appendChild(contentDiv);
  container.appendChild(groupDiv);

  // Make group collapsible (expanded by default)
  headerDiv.addEventListener('click', () => {
    groupDiv.classList.toggle('collapsed');
  });
}

function createLayerItem(layer) {
  const itemDiv = document.createElement('div');
  itemDiv.className = 'layer-item';
  
  // e.g. "Bulk Density of the fine earth fraction (2024, 0-30, MEAN, kg/dm³)"
  // — year (from mapset.creation_date), depth, statistical dimension and
  // unit in one parenthesis. A trailing "(YYYY)" in the title is stripped so
  // the year isn't shown twice (and serves as fallback when creation_date is
  // not set). "X" means "no statistical dimension" and is not shown.
  const ym = /^(.*)\s+\((\d{4})\)\s*$/.exec(layer.property_name || '');
  const baseName = ym ? ym[1] : layer.property_name;
  const year = layer.year || (ym && ym[2]);
  const stats = layer.dimension_stats === 'X' ? null : layer.dimension_stats;
  const dims = [year, layer.dimension, stats, layer.unit_of_measure_id]
    .filter(Boolean).join(', ');
  const layerName = dims ? `${baseName} (${dims})` : layer.property_name;

  itemDiv.innerHTML = `
    <input type="radio" name="data-layer" id="layer-${layer.layer_id}" value="${layer.layer_id}">
    <label for="layer-${layer.layer_id}" title="${layerName}">${layerName}</label>
    <div class="layer-icons">
      ${layer.metadata_url ? `<a href="#" class="metadata-link" data-url="${layer.metadata_url}" title="${t('icons.metadata')}"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23666'%3E%3Cpath d='M13 9h-2V7h2m0 10h-2v-6h2m-1-9A10 10 0 0 0 2 12a10 10 0 0 0 10 10 10 10 0 0 0 10-10A10 10 0 0 0 12 2z'/%3E%3C/svg%3E" alt="${t('icons.info')}"></a>` : ''}
      ${layer.download_url ? `<a href="${layer.download_url}" download title="${t('icons.downloadGeotiff')}"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23666'%3E%3Cpath d='M5 20h14v-2H5m14-9h-4V3H9v6H5l7 7 7-7z'/%3E%3C/svg%3E" alt="${t('icons.download')}"></a>` : ''}
    </div>
  `;

  const radio = itemDiv.querySelector('input[type="radio"]');
  // Track pre-click state so a click on an already-selected radio toggles it off
  let wasChecked = false;
  itemDiv.addEventListener('mousedown', () => { wasChecked = radio.checked; });
  radio.addEventListener('click', (e) => {
    if (wasChecked) {
      e.preventDefault();
      radio.checked = false;
      closeInfoPopup();   // layer unselected → drop any open info-popup
      if (activeLayer) {
        map.removeLayer(activeLayer);
        activeLayer = null;
        const legend = document.getElementById('legend');
        if (legend) legend.style.display = 'none';
      }
    }
  });
  radio.addEventListener('change', (e) => {
    if (e.target.checked) {
      switchLayer(layer);
    }
  });

  // Add metadata link handler
  const metadataLink = itemDiv.querySelector('.metadata-link');
  if (metadataLink) {
    metadataLink.addEventListener('click', async (e) => {
      e.preventDefault();
      const metadataUrl = e.currentTarget.dataset.url;
      await showMetadataPopup(metadataUrl);
    });
  }

  return itemDiv;
}

// The floating controls are white glyphs — unreadable over light basemaps.
// Flip the family dark whenever a light basemap is active.
const LIGHT_BASEMAPS = new Set(['osm', 'terrain', 'eox-terrain-light']);
function updateControlTheme(basemapId) {
  document.body.classList.toggle('light-basemap', LIGHT_BASEMAPS.has(basemapId));
}

// Keep the legend and scale bar visible when the attribute table covers the
// bottom of the map: lift them above the panel by its current height.
function updateBottomOverlays() {
  const panel = document.getElementById('profiles-data-modal');
  const open = panel && panel.style.display !== 'none';
  const offset = open ? panel.getBoundingClientRect().height : 0;
  const legend = document.getElementById('legend');
  if (legend) legend.style.bottom = offset ? `${offset + 40}px` : '';
  const scale = document.querySelector('.scale-line');
  if (scale) scale.style.bottom = offset ? `${offset + 8}px` : '';
}

function switchBasemap(basemapId) {
  updateControlTheme(basemapId);
  const baseLayers = map.get('baseLayers');
  Object.entries(baseLayers).forEach(([id, layer]) => {
    layer.setVisible(id === basemapId);
  });
}

function switchLayer(layerConfig) {
  // A different layer is being selected → drop any open info-popup.
  closeInfoPopup();
  // Remove currently active layer
  if (activeLayer) {
    map.removeLayer(activeLayer);
    document.getElementById('legend').style.display = 'none';
  }

  // Create and add new layer
  const layer = createWMSLayer(layerConfig);
  map.addLayer(layer);
  activeLayer = layer;

  // Reflect the layer's starting opacity on the slider.
  const opacitySlider = document.getElementById('opacity');
  if (opacitySlider) {
    opacitySlider.value = layerConfig.default_opacity == null ? 1 : Number(layerConfig.default_opacity);
  }

  // Show legend (dynamic when the layer ships legend classes).
  showLegend(layerConfig);

  // Store current layer config
  currentLayers[layerConfig.layer_id] = layerConfig;
}

function createWMSLayer(layerConfig) {
  // Parse the get_map_url to extract the map parameter AND the cache-buster
  // token (_v) the API stamps on so re-rendered tiles aren't served from
  // browser / proxy cache.
  let mapParam = null;
  let cacheToken = null;

  if (layerConfig.get_map_url) {
    try {
      const url = new URL(layerConfig.get_map_url);
      mapParam = url.searchParams.get('map');
      cacheToken = url.searchParams.get('_v');
    } catch (e) {
      console.warn('Could not parse get_map_url:', layerConfig.get_map_url);
    }
  }

  // MapServer base URL
  const mapServerUrl = MAPSERVER_URL;

  const params = {
    'LAYERS': layerConfig.layer_id,
    'FORMAT': 'image/png',
    'TRANSPARENT': true
  };

  // Add map parameter if found
  if (mapParam) {
    params['map'] = mapParam;
  }
  if (cacheToken) {
    params['_v'] = cacheToken;
  }

  const layer = new ImageLayer({
    source: new ImageWMS({
      url: mapServerUrl,
      params: params,
      ratio: 1,
      serverType: 'mapserver'
    })
  });

  layer.set('layerId', layerConfig.layer_id);
  layer.set('featureInfoUrl', layerConfig.get_feature_info_url);
  // Admin-set initial opacity (the visitor's slider still overrides it).
  layer.setOpacity(layerConfig.default_opacity == null ? 1 : Number(layerConfig.default_opacity));

  return layer;
}


// ==================== Metadata ====================

// Allow only http(s) URLs through; everything else (javascript:, data:, etc.) becomes "#".
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

function formatMetadata(m) {
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
    html += `<h3 style="margin-top:0;color:#2c3e50;border-bottom:2px solid #3498db;padding-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
      <span style="flex:1;">${e(title)}</span>${xmlBtn}
    </h3>`;
  }

  if (m.abstract || m.project_description) {
    const text = m.abstract || m.project_description;
    html += `<div style="margin:15px 0;padding:10px;background:#f8f9fa;border-left:3px solid #3498db;border-radius:3px;">
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
             style="max-width:100%;max-height:320px;border:1px solid #ddd;border-radius:4px;background:#fff;">
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
    html += `<div style="margin:18px 0;"><h4 style="color:#2c3e50;margin-bottom:8px;">Keywords</h4>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">`
      + allKw.map(([type, k]) =>
          `<span style="background:#e8f4f8;color:#2980b9;padding:4px 10px;border-radius:14px;font-size:12px;" title="${e(type)}">${e(k)}</span>`
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
    html += `<div style="margin:18px 0;"><h4 style="color:#2c3e50;margin-bottom:8px;">Lineage</h4>
      <div style="padding:10px;background:#f8f9fa;border-radius:3px;line-height:1.5;">${e(m.lineage_statement)}</div></div>`;
  }

  // ---------- Contacts ----------
  if (Array.isArray(m.contacts) && m.contacts.length) {
    html += `<div style="margin:18px 0;"><h4 style="color:#2c3e50;margin-bottom:8px;">Contacts</h4>`;
    m.contacts.forEach(c => {
      html += `<div style="margin-bottom:10px;padding:10px;background:#f8f9fa;border-radius:5px;border-left:3px solid #27ae60;">
        <div style="font-weight:bold;color:#2c3e50;">${e(c.individual_id || '')} · ${e(c.organisation_id || '')}</div>
        ${c.position ? `<div><strong>Position:</strong> ${e(c.position)}</div>` : ''}
        ${c.role ? `<div><strong>Role:</strong> ${e(c.role)}${c.tag ? ' / ' + e(c.tag) : ''}</div>` : ''}
        ${c.organisation_country || c.organisation_city ? `<div style="color:#555;font-size:13px;">${e([c.organisation_city, c.organisation_country].filter(Boolean).join(', '))}</div>` : ''}
        ${c.individual_email ? `<div><strong>Email:</strong> <a href="${e(safeMailto(c.individual_email))}" style="color:#3498db;">${e(c.individual_email)}</a></div>` : ''}
      </div>`;
    });
    html += `</div>`;
  }

  // ---------- Online resources ----------
  if (Array.isArray(m.online_resources) && m.online_resources.length) {
    html += `<div style="margin:18px 0;"><h4 style="color:#2c3e50;margin-bottom:8px;">${t('meta.onlineResources')}</h4>
      <div style="display:flex;flex-direction:column;gap:6px;">`
      + m.online_resources.map(u => {
          const icon = u.protocol?.startsWith('WWW:LINK') || u.protocol?.startsWith('WWW:DOWNLOAD') ? '📥' : '🔗';
          return `<a href="${e(safeUrl(relMapserverUrl(u.url)))}" target="_blank" rel="noopener noreferrer" style="padding:8px;background:#fff;border:1px solid #ddd;border-radius:4px;text-decoration:none;color:#2c3e50;display:flex;gap:10px;align-items:center;">
            <span style="font-size:18px;">${icon}</span>
            <div style="flex:1;">
              <div style="font-weight:600;">${e(u.url_name || u.protocol)}</div>
              <div style="font-size:12px;color:#666;">${e(u.protocol)}</div>
              ${u.url_description ? `<div style="font-size:12px;color:#666;">${e(u.url_description)}</div>` : ''}
            </div>
          </a>`;
        }).join('')
      + `</div></div>`;
  }

  // ---------- Footer: file identifier ----------
  if (m.file_identifier) {
    html += `<div style="margin-top:20px;font-size:11px;color:#888;font-family:monospace;">file identifier: ${e(m.file_identifier)}</div>`;
  }

  return html;
}

// Helper: 2-column section with rows, with optional raw HTML in value cell.
function sectionTable(title, rows, e, raw = false) {
  if (!rows.length) return '';
  let html = `<div style="margin:18px 0;"><h4 style="color:#2c3e50;margin-bottom:8px;">${e(title)}</h4>
    <table style="width:100%;border-collapse:collapse;">`;
  rows.forEach(([k, v]) => {
    const valueCell = raw ? v : e(String(v));
    html += `<tr style="border-bottom:1px solid #eee;">
      <td style="padding:6px 8px;font-weight:bold;color:#555;width:32%;vertical-align:top;">${e(k)}</td>
      <td style="padding:6px 8px;">${valueCell}</td>
    </tr>`;
  });
  html += `</table></div>`;
  return html;
}


function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}


async function showMetadataPopup(metadataUrl) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 20px;';
  modal.innerHTML = `
    <div style="background: white; padding: 20px; border-radius: 8px; max-width: 880px; max-height: 90vh; overflow-y: auto; position: relative; width: 100%;">
      <button id="metadata-close" style="position: absolute; top: 10px; right: 10px; background: none; border: none; font-size: 24px; cursor: pointer; color: #666;">&times;</button>
      <h2 style="margin-top: 0;">${t('meta.title')}</h2>
      <div id="metadata-content" style="margin-top: 20px;">${t('meta.loading')}</div>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('metadata-close').addEventListener('click', () => document.body.removeChild(modal));
  modal.addEventListener('click', (e) => { if (e.target === modal) document.body.removeChild(modal); });

  try {
    // metadataUrl is now `/api/raster/metadata/<layer_id>` — needs the SPA's API key.
    const url = metadataUrl.startsWith('http')
      ? metadataUrl
      : `${api.baseURL}${metadataUrl}`;
    const response = await fetch(url, { headers: { 'X-API-Key': api.apiKey } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const metadata = await response.json();
    document.getElementById('metadata-content').innerHTML = formatMetadata(metadata);
  } catch (error) {
    console.error('Failed to load metadata:', error);
    document.getElementById('metadata-content').innerHTML =
      `<p style="color: red;">Failed to load metadata: ${escapeHtml(error.message)}</p>`;
  }
}


// ==================== Profile Layer ====================



async function loadProfiles() {
  try {
    const profiles = await api.getProfiles();

    // Which profile layers have spatial blur applied (booleans only — the
    // radius is never sent). Used to warn that locations are approximate.
    try {
      const flags = await api.getProfileBlurFlags();
      blurredMapsetIds = new Set((flags && flags.blurred_mapset_ids) || []);
      locationsOnlyMapsetIds = new Set((flags && flags.locations_only_mapset_ids) || []);
      hideDownloadMapsetIds = new Set((flags && flags.hide_download_mapset_ids) || []);
    } catch (e) {
      blurredMapsetIds = new Set();
      locationsOnlyMapsetIds = new Set();
      hideDownloadMapsetIds = new Set();
    }

    if (!profiles || profiles.length === 0) {
      console.log(t('profiles.noneInDb'));
      return;
    }

    console.log('Loading profiles:', profiles.length);
    console.log('First profile sample:', profiles[0]);
    
    // Get unique project names
    const projectNames = [...new Set(profiles.map(p => p.project_name || t('profiles.unknownProject')))];
    console.log('Projects found:', projectNames);

    // Generate colors for each project
    // Default symbology: every project starts as a brown soil-profile bar;
    // per-project colours/shapes come from the admin symbology below.
    profileColors = {};
    projectNames.forEach(n => { profileColors[n] = '#63452C'; });

    // Map project_name → mapset_id so the layer-control row can link to the
    // ISO 19139 metadata popup (the stub mapset_id is also the catalogue id).
    profileMapsetIds = {};
    profiles.forEach(p => {
      const name = p.project_name || t('profiles.unknownProject');
      if (p.mapset_id && !profileMapsetIds[name]) {
        profileMapsetIds[name] = p.mapset_id;
      }
    });

    // Admin-set marker symbology (shape/size/colour/opacity per project);
    // a configured colour overrides the generated palette entry.
    try {
      profileSymbology = await api.getProfileSymbology() || {};
    } catch (e) {
      console.warn('profile symbology unavailable:', e.message);
      profileSymbology = {};
    }
    Object.entries(profileMapsetIds).forEach(([name, mapsetId]) => {
      const sym = profileSymbology[mapsetId];
      if (sym && sym.color) profileColors[name] = sym.color;
    });

    // Admin-defined panel order (lower first, unset last, then by name).
    projectNames.sort((a, b) => {
      const oa = (profileSymbology[profileMapsetIds[a]] || {}).order;
      const ob = (profileSymbology[profileMapsetIds[b]] || {}).order;
      const na = oa == null ? Infinity : Number(oa);
      const nb = ob == null ? Infinity : Number(ob);
      return na - nb || a.localeCompare(b);
    });
    const orderedColors = {};
    projectNames.forEach(n => { orderedColors[n] = profileColors[n]; });
    profileColors = orderedColors;
    
    // Create GeoJSON format parser
    const geoJsonFormat = new GeoJSON();
    
    // Create ALL features in one array (not separated by project)
    const allFeatures = profiles.map(profile => {
      try {
        if (!profile.geometry) {
          console.warn('Profile missing geometry:', profile.profile_code);
          return null;
        }

        const feature = geoJsonFormat.readFeature(profile.geometry, {
          dataProjection: 'EPSG:4326',
          featureProjection: 'EPSG:3857'
        });
        
        // Set properties including project name for styling
        const coords = profile.geometry && profile.geometry.coordinates;
        feature.setProperties({
          profile_id: profile.gid,
          profile_code: profile.profile_code,
          project_name: profile.project_name || t('profiles.unknownProject'),
          altitude: profile.altitude,
          date: profile.date,
          sampling_date: profile.date,
          longitude: Array.isArray(coords) ? coords[0] : null,
          latitude: Array.isArray(coords) ? coords[1] : null
        });
        
        return feature;
      } catch (e) {
        console.error('Failed to create feature for profile:', profile.profile_code, e);
        return null;
      }
    }).filter(f => f !== null);

    if (allFeatures.length === 0) {
      console.warn(t('profiles.noValidFeatures'));
      return;
    }

    console.log(`Created ${allFeatures.length} total features`);

    // Group features by project for per-dataset clustering
    const featuresByProject = {};
    projectNames.forEach(name => { featuresByProject[name] = []; });
    allFeatures.forEach(f => {
      const name = f.get('project_name');
      (featuresByProject[name] = featuresByProject[name] || []).push(f);
    });

    // Build one clustered layer per project
    projectNames.forEach(name => {
      const vectorSource = new VectorSource({ features: featuresByProject[name] });
      const clusterSource = new Cluster({ distance: 100, source: vectorSource });
      // Admin can publish a layer without activating it by default — it then
      // starts unticked and the visitor opts in.
      const startVisible = projectSymbology(name).active !== false;
      const layer = new VectorLayer({
        source: clusterSource,
        style: getUnifiedClusterStyle,
        zIndex: 1000,
        visible: startVisible
      });
      layer.set('name', name);
      profileLayers[name] = { visible: startVisible, layer };
      map.addLayer(layer);
    });

    // Keep a combined reference used by the data panel and highlight layer
    profileLayers['all'] = { get: (key) => key === 'allFeatures' ? allFeatures : undefined };

    // Add checkbox controls
    addProfileLayerControl();

  } catch (error) {
    console.error('Failed to load profiles:', error);
    console.error('Error details:', error.message, error.stack);
  }
}



function getUnifiedClusterStyle(feature) {
  const features = feature.get('features');
  const size = features.length;
  
  if (size > 1) {
    // Clustered style - count projects in cluster
    const projectCounts = {};
    features.forEach(f => {
      const projectName = f.get('project_name');
      projectCounts[projectName] = (projectCounts[projectName] || 0) + 1;
    });
    
    // Get dominant project color (project with most profiles in cluster)
    let dominantProject = Object.keys(projectCounts)[0];
    let maxCount = 0;
    Object.entries(projectCounts).forEach(([project, count]) => {
      if (count > maxCount) {
        maxCount = count;
        dominantProject = project;
      }
    });
    
    const color = profileColors[dominantProject] || '#63452C';
    const sym = projectSymbology(dominantProject);
    const clusterOpacity = sym.opacity == null ? 0.8 : Number(sym.opacity);

    // Convert hex to rgba
    const hexToRgba = (hex, alpha) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    
    // Clusters wear the dominant project's symbology too — same shape,
    // colour and opacity as its single points, sized by member count.
    return new Style({
      image: markerImage(
        sym.shape || 'profile',
        15 + Math.min(size / 2, 10),
        new Fill({ color: hexToRgba(color, clusterOpacity) }),
        new Stroke({ color: color, width: 2 }),
        color, clusterOpacity
      ),
      text: new Text({
        text: size.toString(),
        fill: new Fill({ color: '#fff' }),
        font: 'bold 12px sans-serif'
      })
    });
  } else {
    // Single point style - use project color
    const projectName = features[0].get('project_name');
    const color = profileColors[projectName] || '#63452C';
    
    const hexToRgba = (hex, alpha) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };
    
    const sym = projectSymbology(projectName);
    return new Style({
      image: markerImage(
        sym.shape || 'profile',
        sym.size == null ? 8 : Number(sym.size),
        new Fill({ color: hexToRgba(color, sym.opacity == null ? 0.8 : Number(sym.opacity)) }),
        new Stroke({ color: '#fff', width: 2 }),
        color, sym.opacity == null ? 0.8 : Number(sym.opacity)
      )
    });
  }
}


// Admin symbology for a project name (may be undefined).
function projectSymbology(projectName) {
  const mapsetId = profileMapsetIds[projectName];
  return (mapsetId && profileSymbology[mapsetId]) || {};
}

// Mix a hex colour towards black (f < 0) or white (f > 0).
function shadeColor(hex, f) {
  const n = (i) => parseInt(hex.slice(i, i + 2), 16);
  const mix = (c) => Math.max(0, Math.min(255, Math.round(f < 0 ? c * (1 + f) : c + (255 - c) * f)));
  return '#' + [n(1), n(3), n(5)].map(c => mix(c).toString(16).padStart(2, '0')).join('');
}

// The profile bar carries a vertical gradient (darker topsoil → lighter
// subsoil). RegularShape can't gradient-fill, so it's an SVG data-URI Icon,
// cached per colour/size/opacity.
const profileBarIconCache = {};
function profileBarIcon(hexColor, radius, opacity) {
  const key = `${hexColor}|${radius}|${opacity}`;
  if (!profileBarIconCache[key]) {
    const w = Math.max(4, Math.round(radius * 0.8));
    const h = Math.round(radius * 2.2);
    const dark = shadeColor(hexColor, -0.35);
    const light = shadeColor(hexColor, 0.35);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w + 4}" height="${h + 4}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${dark}"/><stop offset="1" stop-color="${light}"/>` +
      `</linearGradient></defs>` +
      `<rect x="2" y="2" width="${w}" height="${h}" fill="url(#g)" fill-opacity="${opacity}" ` +
      `stroke="#fff" stroke-width="1.5"/></svg>`;
    profileBarIconCache[key] = new Icon({ src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg) });
  }
  return profileBarIconCache[key];
}

// Build the marker image for a shape. Circle is the default; the polygonal
// shapes use RegularShape; the profile bar is a gradient SVG icon (hexColor
// and opacity are only needed for that case).
function markerImage(shape, radius, fill, stroke, hexColor, opacity) {
  switch (shape) {
    case 'square':
      return new RegularShape({ points: 4, radius, angle: Math.PI / 4, fill, stroke });
    case 'triangle':
      return new RegularShape({ points: 3, radius, angle: 0, fill, stroke });
    case 'diamond':
      return new RegularShape({ points: 4, radius, angle: 0, fill, stroke });
    case 'star':
      return new RegularShape({ points: 5, radius, radius2: radius * 0.45, angle: 0, fill, stroke });
    case 'profile':
      return profileBarIcon(hexColor || '#63452C', radius, opacity == null ? 0.8 : opacity);
    default:
      return new CircleStyle({ radius, fill, stroke });
  }
}

// Small inline-SVG rendering of a project's marker for the layer panel —
// same shapes as markerImage, so the panel mimics the map.
function markerSvgIcon(shape, color, opacity, px = 20) {
  const shapes = {
    circle:   `<circle cx="9" cy="9" r="7"/>`,
    square:   `<rect x="2.5" y="2.5" width="13" height="13"/>`,
    triangle: `<polygon points="9,2 16,15.5 2,15.5"/>`,
    diamond:  `<polygon points="9,1.5 16.5,9 9,16.5 1.5,9"/>`,
    star:     `<polygon points="9,1.5 11.2,6.5 16.5,7 12.6,10.7 13.8,16 9,13.2 4.2,16 5.4,10.7 1.5,7 6.8,6.5"/>`,
    profile:  `<rect x="6" y="1.5" width="6" height="15"/>`,
  };
  if (shape === 'profile') {
    const gid = 'pg' + color.replace('#', '');
    return `<svg width="${px}" height="${px}" viewBox="0 0 18 18" aria-hidden="true">`
      + `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`
      + `<stop offset="0" stop-color="${shadeColor(color, -0.35)}"/>`
      + `<stop offset="1" stop-color="${shadeColor(color, 0.35)}"/></linearGradient></defs>`
      + `<rect x="6" y="1.5" width="6" height="15" fill="url(#${gid})" fill-opacity="${opacity}" stroke="#fff" stroke-width="1.2"/></svg>`;
  }
  return `<svg width="${px}" height="${px}" viewBox="0 0 18 18" aria-hidden="true">`
    + `<g fill="${color}" fill-opacity="${opacity}" stroke="#fff" stroke-width="1.2">${shapes[shape] || shapes.circle}</g></svg>`;
}

function addProfileLayerControl() {
  const profileGroup = document.createElement('div');
  profileGroup.className = 'layer-group';
  
  // Create header
  const header = document.createElement('div');
  header.className = 'layer-group-header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'flex-start';
  header.style.gap = '8px';

  const headerLabel = document.createElement('span');
  headerLabel.textContent = t('groups.soilProfiles');
  header.appendChild(headerLabel);

  const showDataBtn = document.createElement('button');
  showDataBtn.type = 'button';
  showDataBtn.id = 'profiles-data-btn';
  showDataBtn.textContent = t('profiles.data');
  showDataBtn.className = 'btn btn-primary';
  showDataBtn.style.padding = '2px 8px';
  showDataBtn.style.fontSize = '0.8em';
  showDataBtn.style.marginLeft = 'auto';
  showDataBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('profiles-data-modal');
    if (panel && panel.style.display !== 'none') {
      panel.style.display = 'none';
      updateBottomOverlays();
      selectedProfileCodes.clear();
      refreshHighlight();
      showDataBtn.textContent = t('profiles.data');
    } else {
      showVisibleProfilesData();
      showDataBtn.textContent = t('profiles.hide');
    }
  });
  header.appendChild(showDataBtn);

  profileGroup.appendChild(header);
  
  // Create content container
  const content = document.createElement('div');
  content.className = 'layer-group-content';
  
  // Add a checkbox and colour picker for each project
  Object.entries(profileColors).forEach(([projectName, color]) => {
    const layerItem = document.createElement('div');
    layerItem.className = 'layer-item';
    layerItem.style.display = 'flex';
    layerItem.style.alignItems = 'center';
    layerItem.style.gap = '8px';
    
    const checkboxId = `layer-profile-${projectName.replace(/\s+/g, '-').toLowerCase()}`;
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = checkboxId;
    checkbox.checked = profileLayers[projectName] ? profileLayers[projectName].visible : true;
    
    const label = document.createElement('label');
    label.htmlFor = checkboxId;
    label.textContent = projectName;
    label.style.flex = '1';
    
    // Static marker swatch — a miniature of the admin-set symbology
    // (shape, colour and opacity), so the panel mimics the map.
    const sym = projectSymbology(projectName);
    const colorWrapper = document.createElement('span');
    colorWrapper.style.lineHeight = '0';
    colorWrapper.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))';
    colorWrapper.innerHTML = markerSvgIcon(
      sym.shape || 'profile', color, sym.opacity == null ? 0.85 : Number(sym.opacity));
    
    layerItem.appendChild(checkbox);
    layerItem.appendChild(label);

    // Metadata "i" icon — same style as the raster layer items. The stub
    // mapset_id IS the catalogue identifier, so /api/raster/metadata/<id>
    // resolves for both grid and vector layers.
    const mapsetId = profileMapsetIds[projectName];

    // Privacy warnings for this layer — a single ⚠ listing every applicable
    // restriction (never any value).
    const warnings = [];
    if (mapsetId && locationsOnlyMapsetIds.has(mapsetId)) {
      warnings.push('This layer shares only profile locations — no observational/attribute data is shared.');
    }
    if (mapsetId && blurredMapsetIds.has(mapsetId)) {
      warnings.push('Profile locations on this layer are approximate (privacy protection applied).');
    }
    if (warnings.length) {
      const warn = document.createElement('span');
      warn.className = 'layer-privacy-warning';
      warn.textContent = '⚠';
      warn.title = warnings.join('\n');
      warn.setAttribute('aria-label', warnings.join(' '));
      warn.style.cursor = 'help';
      warn.style.color = '#b8860b';
      layerItem.appendChild(warn);
    }

    if (mapsetId) {
      const infoIcons = document.createElement('div');
      infoIcons.className = 'layer-icons';
      infoIcons.innerHTML = `<a href="#" class="metadata-link" title="${t('icons.metadata')}"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23666'%3E%3Cpath d='M13 9h-2V7h2m0 10h-2v-6h2m-1-9A10 10 0 0 0 2 12a10 10 0 0 0 10 10 10 10 0 0 0 10-10A10 10 0 0 0 12 2z'/%3E%3C/svg%3E" alt="${t('icons.info')}"></a>`;
      infoIcons.querySelector('a').addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await showMetadataPopup(`/api/raster/metadata/${encodeURIComponent(mapsetId)}`);
      });
      layerItem.appendChild(infoIcons);
    }

    // Per-project download — exports the profiles belonging to this project
    // (in the same CSV columns the data panel uses). Suppressed for projects
    // flagged "Hide download" in the admin Soil profiles tab.
    if (!(mapsetId && hideDownloadMapsetIds.has(mapsetId))) {
      const dlIcons = document.createElement('div');
      dlIcons.className = 'layer-icons';
      dlIcons.innerHTML = `<a href="#" title="${t('icons.downloadCsv')}"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23666'%3E%3Cpath d='M5 20h14v-2H5m14-9h-4V3H9v6H5l7 7 7-7z'/%3E%3C/svg%3E" alt="${t('icons.download')}"></a>`;
      dlIcons.querySelector('a').addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await downloadProjectProfilesCsv(projectName);
        } catch (err) {
          console.error('Profile CSV download failed:', err);
          alert(t('err.csvDownload') + (err && err.message ? err.message : err));
        }
      });
      layerItem.appendChild(dlIcons);
    }

    layerItem.appendChild(colorWrapper);
    content.appendChild(layerItem);
    
    // Toggle visibility by filtering features
    checkbox.addEventListener('change', (e) => {
      profileLayers[projectName].visible = e.target.checked;
      const lyr = profileLayers[projectName].layer;
      if (lyr) lyr.setVisible(e.target.checked);
      const panel = document.getElementById('profiles-data-modal');
      if (panel && panel.style.display !== 'none') {
        refreshVisibleProfilesData();
      }
    });

  });
  
  profileGroup.appendChild(content);

  // Insert at the beginning of layer groups
  const layerGroupsContainer = document.getElementById('layer-groups');
  layerGroupsContainer.insertBefore(profileGroup, layerGroupsContainer.firstChild);

  // Make collapsible (expanded by default)
  header.addEventListener('click', () => {
    profileGroup.classList.toggle('collapsed');
  });
}


// ==================== GetFeatureInfo ====================

async function showRasterInfo(evt, popup) {
  // DST outputs get a richer popup: a breakdown of every input raster used
  // in the recipe, its value at the clicked pixel, and the reclassification.
  const activeId = activeLayer.get('layerId');
  const activeConfig = currentLayers[activeId];
  if (activeConfig && activeConfig.is_dst) {
    await showDstPixelInfo(evt, popup, activeId, activeConfig);
    return;
  }

  const viewResolution = map.getView().getResolution();
  const source = activeLayer.getSource();
  const url = source.getFeatureInfoUrl(
    evt.coordinate,
    viewResolution,
    'EPSG:3857',
    { 'INFO_FORMAT': 'text/html' }
  );

  if (url) {
    try {
      const response = await fetch(url);
      const htmlText = await response.text();
      
      if (htmlText && htmlText.trim() && !htmlText.includes('no features')) {
        // Transform coordinates to WGS84
        const lonLat = toLonLat(evt.coordinate);
        const longitude = lonLat[0].toFixed(6);
        const latitude = lonLat[1].toFixed(6);
        
        // Extract value from HTML (adjust regex based on your MapServer output)
        const valueMatch = htmlText.match(/Value:\s*([0-9.-]+)/);
        const value = valueMatch ? valueMatch[1] : 'N/A';
        
        // Get current layer info
        const layerId = activeLayer.get('layerId');
        const layerConfig = currentLayers[layerId];
        const layerName = layerConfig ? layerConfig.property_name : 'Unknown';
        const unit = layerConfig ? layerConfig.unit_of_measure_id || '' : '';
        
        // Format like profile popup
        const html = `
          <div class="feature-info-layer">
            <h3>${layerName}</h3>
            <div class="feature-info-item">
              <div class="feature-info-property"><strong>Value:</strong> ${value} ${unit}</div>
              <div class="feature-info-property"><strong>Latitude:</strong> ${latitude}°</div>
              <div class="feature-info-property"><strong>Longitude:</strong> ${longitude}°</div>
            </div>
          </div>
        `;
        
        document.getElementById('popup-content').innerHTML = html;
        popup.setPosition(evt.coordinate);
      } else {
        popup.setPosition(undefined);
      }
    } catch (error) {
      console.error('Failed to get feature info:', error);
      popup.setPosition(undefined);
    }
  }
}


// DST output popup — a table of each input raster used in the recipe with
// its pixel value and the reclassified score, plus the aggregated output.
async function showDstPixelInfo(evt, popup, layerId, layerConfig) {
  const lonLat = toLonLat(evt.coordinate);
  const lon = lonLat[0];
  const lat = lonLat[1];
  try {
    const data = await api.getDstPixel(layerId, lon, lat);
    const title = (layerConfig && layerConfig.property_name) || layerId;
    const fmt = (v) => (v == null) ? '—' : (Number.isInteger(v) ? v : Number(v).toFixed(3));
    const rows = (data.inputs || []).map(i => `
      <tr>
        <td style="padding:2px 6px;">${escapeHtml(i.label || i.layer_id)}</td>
        <td style="padding:2px 6px;text-align:right;">${fmt(i.value)} ${escapeHtml(i.unit_of_measure_id || '')}</td>
        <td style="padding:2px 6px;text-align:center;color:#666;">≥ ${fmt(i.threshold)}</td>
        <td style="padding:2px 6px;text-align:right;font-weight:600;">${fmt(i.reclass)}</td>
      </tr>`).join('');
    const agg = escapeHtml(data.aggregation || 'sum');
    const html = `
      <div class="feature-info-layer">
        <h3>${escapeHtml(title)}</h3>
        <table style="border-collapse:collapse;font-size:12px;width:100%;min-width:510px;">
          <thead>
            <tr style="border-bottom:1px solid #ccc;color:#555;">
              <th style="padding:2px 6px;text-align:left;width:54%;">${t('dst.raster')}</th>
              <th style="padding:2px 6px;text-align:right;width:25%;">${t('dst.value')}</th>
              <th style="padding:2px 6px;text-align:center;">${t('dst.threshold')}</th>
              <th style="padding:2px 6px;text-align:right;">${t('dst.reclass')}</th>
            </tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="4" style="padding:4px 6px;color:#888;">${t('dst.noInputs')}</td></tr>`}</tbody>
          <tfoot>
            <tr style="border-top:2px solid #999;font-weight:700;">
              <td style="padding:4px 6px;" colspan="3">${t('dst.output')} (${agg})</td>
              <td style="padding:4px 6px;text-align:right;">${fmt(data.output_value)}</td>
            </tr>
          </tfoot>
        </table>
        <div class="feature-info-item" style="margin-top:6px;color:#666;font-size:11px;">
          <div><strong>Latitude:</strong> ${lat.toFixed(6)}°</div>
          <div><strong>Longitude:</strong> ${lon.toFixed(6)}°</div>
        </div>
      </div>`;
    document.getElementById('popup-content').innerHTML = html;
    popup.setPosition(evt.coordinate);
  } catch (error) {
    console.error('Failed to get DST pixel info:', error);
    popup.setPosition(undefined);
  }
}


// ==================== Popup ====================

function setupPopup() {
  const popup = new Overlay({
    element: document.getElementById('popup'),
    autoPan: true,
    autoPanAnimation: { duration: 250 }
  });
  map.addOverlay(popup);
  activePopup = popup;   // expose for closeInfoPopup()

  // Close popup
  document.getElementById('popup-closer').addEventListener('click', () => {
    popup.setPosition(undefined);
  });

  // Dynamic-legend hover: track the raster value under the pointer.
  map.on('pointermove', (evt) => {
    if (evt.dragging) return;
    if (!activeLayer || !legendState) return;
    scheduleLegendProbe(evt.coordinate);
  });
  map.getViewport().addEventListener('pointerleave', () => setLegendCursor(null));

  // Handle map clicks
  map.on('singleclick', async (evt) => {
    const features = map.getFeaturesAtPixel(evt.pixel, {
      layerFilter: (lyr) => lyr !== highlightLayer
    });
    
    // Check for profile points first (priority)
    if (features && features.length > 0) {
      const feature = features[0];
      const clusterFeatures = feature.get('features');
      
      if (clusterFeatures && clusterFeatures.length === 1) {
        // Clicking a profile opens the attribute table with it selected —
        // no popup card.
        const code = clusterFeatures[0].get('profile_code');
        const panel = document.getElementById('profiles-data-modal');
        if (!panel || panel.style.display === 'none') {
          await showVisibleProfilesData();
          const btn = document.getElementById('profiles-data-btn');
          if (btn) btn.textContent = t('profiles.hide');
        }
        toggleProfileSelection(code, { scrollIntoView: true });
        return; // Stop here, don't check raster
      } else if (clusterFeatures && clusterFeatures.length > 1) {
        // Cluster: zoom in and open the attribute table alongside, so the
        // profiles coming into view are immediately browsable.
        const extent = clusterFeatures[0].getGeometry().getExtent();
        map.getView().fit(extent, { duration: 500, maxZoom: map.getView().getZoom() + 2 });
        const panel = document.getElementById('profiles-data-modal');
        if (!panel || panel.style.display === 'none') {
          await showVisibleProfilesData();
          const btn = document.getElementById('profiles-data-btn');
          if (btn) btn.textContent = t('profiles.hide');
        }
        return; // Stop here
      }
    }
    
    // No profile clicked, check for active raster layer
    if (activeLayer) {
      await showRasterInfo(evt, popup);
    } else {
      popup.setPosition(undefined);
    }
  });
}


// ==================== Dynamic legend ====================
// Built from soil_data.class rows shipped on each layer (legend_classes) —
// the exact colours MapServer renders — with a cursor that tracks the pixel
// value under the pointer via throttled WMS GetFeatureInfo probes.

let legendState = null;
let legendProbeCoord = null;
let legendProbeTimer = null;
let legendProbeSeq = 0;

function showLegend(layerConfig) {
  const legendContainer = document.getElementById('legend');
  const legendContent = legendContainer.querySelector('.legend-content');
  legendState = null;
  const classes = (layerConfig && layerConfig.legend_classes) || [];
  legendContainer.classList.toggle('bare', classes.length > 0);
  if (classes.length) {
    buildDynamicLegend(legendContent, layerConfig, classes);
  } else if (layerConfig && layerConfig.get_legend_url) {
    // Fallback: the static MapServer legend image.
    // get_legend_url is emitted as http://localhost/mapserver/… — relativize it
    // so the legend image loads from the SIS host, not the visitor's machine.
    legendContent.innerHTML = `<img src="${relMapserverUrl(layerConfig.get_legend_url)}" alt="${t('legend.alt')}">`;
  } else {
    legendContainer.style.display = 'none';
    return;
  }
  legendContainer.style.display = 'block';
}

function buildDynamicLegend(container, layerConfig, classes) {
  const categorical = layerConfig.property_type === 'categorical';
  // Custom class breaks: non-uniform intervals — render like a classed map
  // (labels beside the blocks) rather than a linear ramp scale.
  const classed = categorical || (layerConfig.custom_classes && classes.length > 1);
  const min = layerConfig.stats_minimum != null ? layerConfig.stats_minimum : classes[0].value;
  let max = layerConfig.stats_maximum;
  if (max == null) {
    const iv = classes.length > 1 ? (classes[1].value - classes[0].value) : 1;
    max = classes[classes.length - 1].value + iv;
  }
  // Unit exceptions: no-unit markers show nothing; long unit names render
  // smaller (and may wrap) so they don't widen the whole stack.
  let unit = layerConfig.unit_of_measure_id || '';
  if (/^(dimensionless|no.?unit|unitless|none|-+)$/i.test(unit.trim())) unit = '';
  const unitLong = unit.length > 8;
  const range = max - min;
  // escapeHtml() covers text nodes; attributes also need quotes neutralised.
  const attr = (x) => escapeHtml(x).replace(/"/g, '&quot;');

  // Highest class on top; the value axis runs bottom (min) → top (max).
  const blocks = classes.slice().reverse().map(c =>
    `<div class="dyn-legend-block" style="background:${attr(c.color)};" title="${attr(c.label)}"></div>`
  ).join('');

  const bar = `
      <div class="dyn-legend-bar">
        ${blocks}
        <div class="dyn-legend-cursor" hidden>
          <span class="dyn-legend-chip"></span>
        </div>
      </div>`;

  // Plain quantitative: one centred stack — unit, max, bar, min.
  // Categorical / custom breaks: unit + bar with labels beside the blocks.
  container.innerHTML = classed
    ? `
    <div class="dyn-legend">
      ${unit ? `<div class="dyn-legend-unit${unitLong ? ' long' : ''}">${escapeHtml(unit)}</div>` : ''}
      ${bar}
      <div class="dyn-legend-labels categorical">${classes.slice().reverse().map(c =>
        `<span class="dyn-legend-cat">${escapeHtml(c.label)}</span>`).join('')}</div>
    </div>`
    : `
    <div class="dyn-legend stacked">
      ${unit ? `<div class="dyn-legend-unit${unitLong ? ' long' : ''}">${escapeHtml(unit)}</div>` : ''}
      <span class="dyn-legend-minmax">${fmtLegendVal(max, range)}</span>
      ${bar}
      <span class="dyn-legend-minmax">${fmtLegendVal(min, range)}</span>
    </div>`;

  legendState = {
    min, max, categorical, classed, classes,
    cursorEl: container.querySelector('.dyn-legend-cursor'),
    chipEl: container.querySelector('.dyn-legend-chip'),
  };
}

// Decimals proportional to the value range: fine ranges get more precision.
function fmtLegendVal(v, range) {
  if (v == null || !isFinite(v)) return '';
  const r = Math.abs(range) || 1;
  const dp = r < 1 ? 3 : r < 10 ? 2 : r < 100 ? 1 : 0;
  return Number(v).toFixed(dp);
}

function setLegendCursor(value) {
  if (!legendState || !legendState.cursorEl) return;
  const st = legendState;
  if (value == null || !isFinite(value)) { st.cursorEl.hidden = true; return; }
  const span = st.max - st.min;
  if (!(span > 0)) { st.cursorEl.hidden = true; return; }
  let frac;
  if (st.classed) {
    // Snap to the centre of the matching class block. Categorical shows the
    // class label; custom breaks show the actual pixel value.
    let idx = 0;
    for (let i = 0; i < st.classes.length; i++) {
      if (value >= st.classes[i].value) idx = i; else break;
    }
    frac = (idx + 0.5) / st.classes.length;
    st.chipEl.textContent = st.categorical && st.classes[idx]
      ? st.classes[idx].label : fmtLegendVal(value, span);
  } else {
    frac = Math.max(0, Math.min(1, (value - st.min) / span));
    st.chipEl.textContent = fmtLegendVal(value, span);
  }
  st.cursorEl.style.bottom = `${(frac * 100).toFixed(2)}%`;
  st.cursorEl.hidden = false;
}

// Trailing throttle (~100 ms) so panning the pointer does not flood MapServer.
// Probes overlap freely — with a round-trip longer than the probe interval,
// both discarding "stale" replies and aborting superseded requests starve the
// cursor (nothing ever lands while the pointer moves). Instead every reply is
// applied unless a NEWER one already has, so updates stream continuously with
// one round-trip of latency.
let legendProbeApplied = 0;

function scheduleLegendProbe(coordinate) {
  legendProbeCoord = coordinate;
  if (legendProbeTimer) return;
  legendProbeTimer = setTimeout(async () => {
    legendProbeTimer = null;
    const coord = legendProbeCoord;
    if (!coord || !activeLayer || !legendState) return;
    const source = activeLayer.getSource();
    if (!source || !source.getFeatureInfoUrl) return;
    const url = source.getFeatureInfoUrl(
      coord, map.getView().getResolution(), 'EPSG:3857',
      { 'INFO_FORMAT': 'text/html' });
    if (!url) return;
    const seq = ++legendProbeSeq;
    try {
      const text = await (await fetch(url)).text();
      if (seq <= legendProbeApplied || !legendState) return; // a newer reply already landed
      legendProbeApplied = seq;
      const m = text && text.match(/Value:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
      let v = m ? parseFloat(m[1]) : null;
      // Suppress NoData: the layer's declared sentinel, or the common ones.
      const cfg = currentLayers[activeLayer.get('layerId')];
      if (v != null && cfg && cfg.no_data_value != null && v === cfg.no_data_value) v = null;
      if (v != null && v <= -9998) v = null;
      setLegendCursor(v);
    } catch (e) {
      if (seq === legendProbeSeq) setLegendCursor(null);
    }
  }, 100);
}


// ==================== UI Controls ====================

function setupControls() {
  // Layer switcher collapse
  const collapseBtn = document.getElementById('collapse-btn');
  const layerSwitcher = document.getElementById('layer-switcher');
  
  collapseBtn.addEventListener('click', () => {
    layerSwitcher.classList.toggle('collapsed');
  });

  // Opacity control
  const opacitySlider = document.getElementById('opacity');
  opacitySlider.addEventListener('input', (e) => {
    if (activeLayer) {
      activeLayer.setOpacity(parseFloat(e.target.value));
    }
  });

  // Zoom controls
  document.getElementById('zoom-in').addEventListener('click', () => {
    const view = map.getView();
    view.setZoom(view.getZoom() + 1);
  });

  document.getElementById('zoom-out').addEventListener('click', () => {
    const view = map.getView();
    view.setZoom(view.getZoom() - 1);
  });

  // Add login button
  addLoginButton();
}

// Icon states for the floating auth button — same stroke style as the globe.
function setAuthButtonIcon(btn, kind, label) {
  const icons = {
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-3.5 4.5-5.5 8-5.5s6.5 2 8 5.5"/>',
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  };
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">'
    + icons[kind] + '</svg>';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function addLoginButton() {
  const loginBtn = document.createElement('button');
  loginBtn.id = 'login-btn';
  loginBtn.className = 'map-glyph';
  loginBtn.style.cssText = 'position: absolute; top: 20px; right: 58px; padding: 6px; background: none; border: none; cursor: pointer; z-index: 1001; line-height: 0;';
  
  // Check if user is already logged in (restore session)
  if (api.restoreSession()) {
    setAuthButtonIcon(loginBtn, 'user', t('auth.adminPanel'));
    loginBtn.onclick = showAdminPanel;  // CHANGED: Use .onclick instead of addEventListener
  } else {
    setAuthButtonIcon(loginBtn, 'user', t('auth.login'));
    loginBtn.onclick = showLoginModal;  // CHANGED: Use .onclick instead of addEventListener
  }

  document.body.appendChild(loginBtn);

  // Language button — globe only, at the right of the Login button. The
  // visitor's choice persists in localStorage and overrides the instance
  // default (LANGUAGE setting).
  const langBtn = document.createElement('button');
  langBtn.id = 'lang-btn';
  langBtn.type = 'button';
  // Stroke-drawn globe (no background) — same icon as grimoire.at's selector.
  langBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="9"/>'
    + '<ellipse cx="12" cy="12" rx="4" ry="9"/>'
    + '<path d="M3.6 8.5h16.8M3.6 15.5h16.8"/></svg>';
  langBtn.title = t('lang.label');
  langBtn.className = 'map-glyph';
  langBtn.style.cssText = 'position: absolute; top: 20px; right: 20px; padding: 6px; background: none; border: none; cursor: pointer; z-index: 1001; line-height: 0;';

  const langMenu = document.createElement('div');
  langMenu.id = 'lang-menu';
  langMenu.style.cssText = 'position: absolute; top: 56px; right: 20px; background: #fff; border: 1px solid #ddd; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 1002; display: none; min-width: 130px; overflow: hidden;';
  for (const [code, label] of AVAILABLE) {
    const item = document.createElement('div');
    item.textContent = label;
    item.style.cssText = 'padding: 8px 14px; cursor: pointer; font-size: 13px;'
      + (code === currentLang() ? 'font-weight: 700; background: #f2f7f2;' : '');
    item.addEventListener('mouseenter', () => { item.style.background = '#eef3ee'; });
    item.addEventListener('mouseleave', () => { item.style.background = code === currentLang() ? '#f2f7f2' : ''; });
    item.addEventListener('click', () => switchLanguage(code));
    langMenu.appendChild(item);
  }
  langBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    langMenu.style.display = langMenu.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', () => { langMenu.style.display = 'none'; });
  document.body.appendChild(langBtn);
  document.body.appendChild(langMenu);

  // A language switch made from inside the admin panel reloads the page;
  // reopen the panel so the user lands back where they were.
  try {
    if (sessionStorage.getItem('sis_reopen_admin') === '1') {
      sessionStorage.removeItem('sis_reopen_admin');
      if (api.isAuthenticated()) showAdminPanel();
    }
  } catch (e) { /* private mode */ }

  window.addEventListener('auth:expired', () => {
    if (adminDashboard && typeof adminDashboard.hide === 'function') adminDashboard.hide();
    setAuthButtonIcon(loginBtn, 'user', t('auth.login'));
    loginBtn.onclick = showLoginModal;
  });
}

// ==================== Admin Functions ====================

function showLoginModal() {
  // If already authenticated, show admin panel instead
  if (api.isAuthenticated()) {
    showAdminPanel();
    return;
  }

  // Create modal HTML
  const modal = document.createElement('div');
  modal.className = 'login-modal active';
  modal.innerHTML = `
    <div class="login-content">
      <h2>${t('auth.adminLogin')}</h2>
      <div id="login-error" class="login-error"></div>
      <form class="login-form" id="login-form">
        <div class="form-group">
          <label for="login-email">${t('auth.username')}</label>
          <input type="text" id="login-email" required>
        </div>
        <div class="form-group">
          <label for="login-password">${t('auth.password')}</label>
          <input type="password" id="login-password" required>
        </div>
        <div class="login-actions">
          <button type="submit" class="btn btn-primary">${t('auth.login')}</button>
          <button type="button" id="login-cancel" class="btn btn-secondary">${t('auth.cancel')}</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);

  // Handle form submission
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    
    try {
      await api.login(email, password);
      document.body.removeChild(modal);
      showAdminPanel();
    } catch (error) {
      document.getElementById('login-error').textContent = error.message;
      document.getElementById('login-error').classList.add('active');
    }
  });

  document.getElementById('login-cancel').addEventListener('click', () => {
    document.body.removeChild(modal);
  });
}

// Make it globally accessible:
window.showLoginModal = showLoginModal;
// Admin dashboard restores the button icon on hide/logout via this.
window.setAuthButtonIcon = setAuthButtonIcon;

function showAdminPanel() {
  // Show the admin dashboard
  adminDashboard.show();
  
  // Update login button to "Back to Map"
  const loginBtn = document.getElementById('login-btn');
  if (!loginBtn) return;
  
  setAuthButtonIcon(loginBtn, 'back', t('auth.backToMap'));
  
  // Set click handler for closing dashboard
  loginBtn.onclick = () => {
    // Close dashboard and return to map
    adminDashboard.hide();
    
    // Reset button to reopen dashboard
    setAuthButtonIcon(loginBtn, 'user', t('auth.adminPanel'));
    loginBtn.onclick = showAdminPanel; // This line is critical!
  };
}

window.showAdminPanel = showAdminPanel;

// ==================== Utility Functions ====================

function showLoading(show) {
  const loader = document.getElementById('loading-overlay');
  if (loader) {
    loader.style.display = show ? 'flex' : 'none';
  }
}

function applyStaticTranslations() {
  // The few strings that live in index.html rather than JS templates.
  const loading = document.querySelector('#loading-overlay div');
  if (loading) loading.textContent = t('app.loading');
  const opacity = document.querySelector('label[for="opacity"]');
  if (opacity) opacity.textContent = t('layers.opacity');
}

function showError(message) {
  alert(message);
}

// ==================== Start App ====================

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}

// ==================== Map Data Refresh ====================

function refreshMapData() {
  console.log('Refreshing map after admin changes...');
  window.location.reload();
}

window.refreshMapData = refreshMapData;

let _allObservationsCache = null;
let _observationBoundsCache = null;   // Map<"prop|proc", {value_min, value_max, typical_min, typical_max, unit}>
let _profilesPanelMoveHooked = false;
const selectedProfileCodes = new Set();
let highlightLayer = null;

function ensureHighlightLayer() {
  if (highlightLayer) return;
  highlightLayer = new VectorLayer({
    source: new VectorSource(),
    zIndex: 1500,
    style: new Style({
      image: new CircleStyle({
        radius: 12,
        stroke: new Stroke({ color: '#ffeb3b', width: 4 }),
        fill: new Fill({ color: 'rgba(255,235,59,0.25)' })
      })
    })
  });
  map.addLayer(highlightLayer);
}

function refreshHighlight() {
  ensureHighlightLayer();
  const src = highlightLayer.getSource();
  src.clear();
  const allFeatures = (profileLayers['all'] && profileLayers['all'].get('allFeatures')) || [];
  const feats = allFeatures
    .filter(f => selectedProfileCodes.has(f.get('profile_code')))
    .map(f => f.clone());
  src.addFeatures(feats);

  const modal = document.getElementById('profiles-data-modal');
  if (modal && modal._state && modal.style.display !== 'none') {
    renderProfilesDataTable();
  }
}

function toggleProfileSelection(profileCode, opts) {
  if (!profileCode) return;
  const wasSelected = selectedProfileCodes.has(profileCode);
  if (wasSelected) selectedProfileCodes.delete(profileCode);
  else selectedProfileCodes.add(profileCode);
  refreshHighlight();
  if (!wasSelected && opts && opts.scrollIntoView) scrollProfileRowIntoView(profileCode);
}
window.toggleProfileSelection = toggleProfileSelection;

function panMapToSelectedProfiles() {
  const unifiedLayer = profileLayers['all'];
  if (!unifiedLayer || selectedProfileCodes.size === 0) return;
  const allFeatures = unifiedLayer.get('allFeatures') || [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let count = 0;
  allFeatures.forEach(f => {
    if (!selectedProfileCodes.has(f.get('profile_code'))) return;
    const geom = f.getGeometry();
    if (!geom) return;
    const [x, y] = geom.getType() === 'Point' ? geom.getCoordinates() : getCenter(geom.getExtent());
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    count++;
  });
  if (!count) return;
  map.getView().animate({ center: [(minX + maxX) / 2, (minY + maxY) / 2], duration: 400 });
}

function scrollProfileRowIntoView() {
  const modal = document.getElementById('profiles-data-modal');
  if (!modal || !modal._state || modal.style.display === 'none') return;
  if (modal._state.page !== 0) {
    modal._state.page = 0;
    renderProfilesDataTable();
  }
  const scroller = document.querySelector('#profiles-data-modal div[style*="overflow:auto"]');
  if (scroller) scroller.scrollTop = 0;
}

async function showVisibleProfilesData() {
  if (!profileLayers['all']) {
    alert(t('profiles.notLoadedYet'));
    return;
  }
  ensureProfilesDataModal();
  const modal = document.getElementById('profiles-data-modal');
  modal.style.display = 'flex';
  updateBottomOverlays();

  if (!_profilesPanelMoveHooked) {
    map.on('moveend', () => {
      const panel = document.getElementById('profiles-data-modal');
      if (panel && panel.style.display !== 'none') {
        refreshVisibleProfilesData();
      }
    });
    _profilesPanelMoveHooked = true;
  }

  await refreshVisibleProfilesData();
}

async function refreshVisibleProfilesData() {
  const unifiedLayer = profileLayers['all'];
  if (!unifiedLayer) return;
  const allFeatures = unifiedLayer.get('allFeatures') || [];
  const extent = map.getView().calculateExtent(map.getSize());

  const visibleCodes = new Set(
    allFeatures
      .filter(f => {
        const proj = f.get('project_name');
        if (profileLayers[proj] && profileLayers[proj].visible === false) return false;
        const geom = f.getGeometry();
        return geom && geom.intersectsExtent(extent);
      })
      .map(f => f.get('profile_code'))
      .filter(Boolean)
  );

  const tbody = document.getElementById('profiles-data-tbody');
  if (!_allObservationsCache) {
    tbody.innerHTML = '<tr><td class="loading">Loading observations…</td></tr>';
    document.getElementById('profiles-data-count').textContent = '';
  }

  try {
    if (!_allObservationsCache) {
      _allObservationsCache = await api.getObservations();
    }
    if (!_observationBoundsCache) {
      _observationBoundsCache = new Map();
      try {
        const list = await api.getObservationBounds();
        list.forEach(b => {
          _observationBoundsCache.set(`${b.property_num_id}|${b.procedure_num_id}`, b);
        });
      } catch (e) {
        // Bounds are optional; if the endpoint fails we just don't draw bars.
        console.warn('Failed to load observation bounds:', e);
      }
    }
    // Plain object — this module imports OpenLayers' Map class, so
    // `new Map()` would build an OL Map, not a JS Map.
    const profileInfoByCode = {};
    allFeatures.forEach(f => {
      const code = f.get('profile_code');
      if (code) profileInfoByCode[code] = {
        profile_id: f.get('profile_id'),
        project_name: f.get('project_name') || '',
        latitude: f.get('latitude'),
        longitude: f.get('longitude'),
        altitude: f.get('altitude'),
        sampling_date: f.get('sampling_date') || f.get('date') || ''
      };
    });

    const baseCols = ['project_name', 'profile_id', 'profile_code', 'latitude', 'longitude', 'altitude', 'sampling_date', 'upper_depth', 'lower_depth'];
    const groups = {};
    const propColsSet = {};
    _allObservationsCache
      .filter(o => visibleCodes.has(o.profile_code))
      .forEach(o => {
        const key = o.profile_code + '|' +
          (o.upper_depth == null ? '' : o.upper_depth) + '|' +
          (o.lower_depth == null ? '' : o.lower_depth);
        let row = groups[key];
        if (!row) {
          const info = profileInfoByCode[o.profile_code] || {};
          row = {
            profile_id: info.profile_id != null ? info.profile_id : '',
            project_name: info.project_name || '',
            profile_code: o.profile_code,
            latitude: info.latitude != null ? Number(info.latitude).toFixed(5) : '',
            longitude: info.longitude != null ? Number(info.longitude).toFixed(5) : '',
            altitude: info.altitude != null ? info.altitude : '',
            sampling_date: info.sampling_date || '',
            upper_depth: o.upper_depth,
            lower_depth: o.lower_depth
          };
          groups[key] = row;
        }
        const prop = o.property_num_id || o.property_phys_chem_id || '';
        const proc = o.procedure_num_id || o.procedure_phys_chem_id || '';
        const unit = o.unit_of_measure_id || '';
        const colKey = [prop, proc, unit].filter(Boolean).join('.');
        if (!colKey) return;
        if (!propColsSet[colKey]) propColsSet[colKey] = { key: colKey, prop, proc, unit };
        row[colKey] = o.value;
      });

    const rows = Object.keys(groups).map(k => groups[k]);
    const propCols = Object.keys(propColsSet).sort().map(k => propColsSet[k]);
    const columns = baseCols.concat(propCols.map(c => c.key));
    const columnMeta = {};
    baseCols.forEach(c => { columnMeta[c] = { key: c, line1: c, line2: '', isBase: true }; });
    propCols.forEach(c => {
      columnMeta[c.key] = {
        key: c.key,
        line1: [c.prop, c.unit].filter(Boolean).join(' '),
        line2: c.proc || '',
        prop: c.prop,
        proc: c.proc,
      };
    });

    const modal = document.getElementById('profiles-data-modal');
    const prevPage = modal._state ? modal._state.page : 0;
    const hadState = !!(modal._state && modal._state.hiddenCols);
    const prevHidden = hadState ? modal._state.hiddenCols : new Set();
    const defaultHidden = ['profile_id', 'latitude', 'longitude', 'altitude', 'project_name'];
    const hiddenCols = hadState
      ? new Set([...prevHidden].filter(c => columns.includes(c)))
      : new Set(defaultHidden.filter(c => columns.includes(c)));
    modal._state = {
      rows,
      filtered: rows,
      page: prevPage,
      columns,
      columnMeta,
      hiddenCols,
      sort: [{ col: 'profile_code', dir: 'asc' }, { col: 'upper_depth', dir: 'asc' }]
    };
    renderProfilesDataTable();
  } catch (e) {
    tbody.innerHTML = `<tr><td class="empty-state">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function ensureProfilesDataModal() {
  if (document.getElementById('profiles-data-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'profiles-data-modal';
  modal.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:33vh;z-index:10000;display:flex;box-shadow:0 -4px 12px rgba(0,0,0,0.2);';
  modal.innerHTML = `
    <div style="background:#fff;width:100%;height:100%;display:flex;flex-direction:column;border-top:1px solid #ccc;position:relative;">
      <div id="profiles-data-resizer" title="${t('profiles.dragResize')}" style="position:absolute;top:0;left:0;right:0;height:6px;cursor:ns-resize;background:#eee;"></div>
      <style>
        #profiles-data-table { border-collapse: separate; border-spacing: 0; }
        #profiles-data-table th, #profiles-data-table td {
          padding: 2px 6px !important;
          line-height: 1.2 !important;
          white-space: nowrap;
        }
        #profiles-data-table tr { height: auto !important; }
        #profiles-data-table thead th {
          position: sticky;
          top: 0;
          background: #f5f5f5;
          z-index: 2;
          box-shadow: inset 0 -1px 0 #ccc;
        }
        #profiles-data-table td.pd-base,
        #profiles-data-table th.pd-base {
          width: 1%;
          background: #f0f4f8;
        }
        #profiles-data-table thead th.pd-base { background: #e4ecf3; }
        #profiles-data-table tr[style*="background:#fff8c4"] td.pd-base { background: #f5ecb4; }
      </style>
      <div style="overflow:auto;flex:1;padding:6px 16px 0 16px;font-size:0.78em;">
        <table class="admin-table" id="profiles-data-table" style="width:100%;font-size:inherit;">
          <thead><tr></tr></thead>
          <tbody id="profiles-data-tbody"></tbody>
        </table>
      </div>
      <div style="padding:4px 16px;border-top:1px solid #eee;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:0.85em;">
        <div style="display:flex;align-items:center;gap:8px;position:relative;">
          <span id="profiles-data-count" style="color:#555;"></span>
          <button type="button" id="profiles-data-columns-btn" class="btn btn-primary" style="padding:2px 8px;font-size:0.9em;">${t('profiles.columns')}</button>
          <div id="profiles-data-columns-popover" style="display:none;position:absolute;bottom:100%;left:0;margin-bottom:4px;background:#fff;border:1px solid #ccc;box-shadow:0 2px 8px rgba(0,0,0,0.15);padding:6px 8px;max-height:300px;overflow:auto;z-index:10;min-width:220px;"></div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          Rows:
          <select id="profiles-data-pagesize" style="padding:1px 2px;">
            <option>25</option><option selected>50</option><option>100</option><option>250</option>
          </select>
          <button type="button" id="profiles-data-prev" style="padding:2px 6px;">◀</button>
          <span id="profiles-data-pageinfo"></span>
          <button type="button" id="profiles-data-next" style="padding:2px 6px;">▶</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  updateBottomOverlays();

  const resizer = document.getElementById('profiles-data-resizer');
  let resizing = false;
  resizer.addEventListener('mousedown', (e) => {
    resizing = true;
    e.preventDefault();
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const newHeight = Math.max(80, Math.min(window.innerHeight - 60, window.innerHeight - e.clientY));
    modal.style.height = newHeight + 'px';
    updateBottomOverlays();
  });
  window.addEventListener('mouseup', () => {
    if (resizing) {
      resizing = false;
      document.body.style.userSelect = '';
    }
  });

  document.getElementById('profiles-data-tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-profile-code]');
    if (!tr) return;
    const code = tr.getAttribute('data-profile-code');
    const wasSelected = selectedProfileCodes.has(code);
    toggleProfileSelection(code);
    if (!wasSelected) panMapToSelectedProfiles();
  });
  document.getElementById('profiles-data-pagesize').addEventListener('change', () => {
    if (!modal._state) return;
    modal._state.page = 0;
    renderProfilesDataTable();
  });
  document.getElementById('profiles-data-prev').addEventListener('click', () => {
    if (modal._state && modal._state.page > 0) { modal._state.page--; renderProfilesDataTable(); }
  });
  document.getElementById('profiles-data-next').addEventListener('click', () => {
    if (!modal._state) return;
    const pageSize = parseInt(document.getElementById('profiles-data-pagesize').value, 10);
    const max = Math.ceil(modal._state.filtered.length / pageSize) - 1;
    if (modal._state.page < max) { modal._state.page++; renderProfilesDataTable(); }
  });

  const columnsBtn = document.getElementById('profiles-data-columns-btn');
  const columnsPop = document.getElementById('profiles-data-columns-popover');
  columnsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (columnsPop.style.display === 'none') {
      renderProfilesColumnsPopover();
      columnsPop.style.display = 'block';
    } else {
      columnsPop.style.display = 'none';
    }
  });
  document.addEventListener('click', (e) => {
    if (columnsPop.style.display !== 'none' && !columnsPop.contains(e.target) && e.target !== columnsBtn) {
      columnsPop.style.display = 'none';
    }
  });
}

function renderProfilesColumnsPopover() {
  const modal = document.getElementById('profiles-data-modal');
  if (!modal || !modal._state) return;
  const { columns, columnMeta, hiddenCols } = modal._state;
  const pop = document.getElementById('profiles-data-columns-popover');
  const rows = columns.map(c => {
    const meta = (columnMeta && columnMeta[c]) || { line1: c, line2: '' };
    const label = [meta.line1, meta.line2].filter(Boolean).join(' — ') || c;
    const checked = !hiddenCols.has(c) ? 'checked' : '';
    return `<label style="display:flex;align-items:center;gap:6px;padding:2px 0;white-space:nowrap;">
      <input type="checkbox" data-col="${escapeHtml(c)}" ${checked}>${escapeHtml(label)}
    </label>`;
  }).join('');
  pop.innerHTML = `
    <div style="display:flex;gap:6px;margin-bottom:4px;border-bottom:1px solid #eee;padding-bottom:4px;">
      <button type="button" id="profiles-cols-all" style="padding:1px 6px;font-size:0.9em;">${t('profiles.all')}</button>
      <button type="button" id="profiles-cols-none" style="padding:1px 6px;font-size:0.9em;">${t('profiles.none')}</button>
    </div>
    ${rows}
  `;
  pop.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const col = cb.dataset.col;
      if (cb.checked) hiddenCols.delete(col);
      else hiddenCols.add(col);
      renderProfilesDataTable();
    });
  });
  pop.querySelector('#profiles-cols-all').addEventListener('click', () => {
    hiddenCols.clear();
    renderProfilesColumnsPopover();
    renderProfilesDataTable();
  });
  pop.querySelector('#profiles-cols-none').addEventListener('click', () => {
    columns.forEach(c => hiddenCols.add(c));
    renderProfilesColumnsPopover();
    renderProfilesDataTable();
  });
}

// Per-project download — same rich CSV the Data panel produces, but
// filtered to one project. Builds rows from `allFeatures` (the source of
// truth before clustering) joined with the observations cache.
async function downloadProjectProfilesCsv(projectName) {
  const unifiedLayer = profileLayers['all'];
  const allFeatures = (unifiedLayer && unifiedLayer.get('allFeatures')) || [];
  const projectFeatures = allFeatures.filter(
    f => (f.get('project_name') || '') === projectName
  );
  if (!projectFeatures.length) {
    alert(t('profiles.noneForProject', {name: projectName}));
    return;
  }

  if (!_allObservationsCache) {
    try {
      _allObservationsCache = await api.getObservations();
    } catch (e) {
      alert(t('profiles.loadObsFailed') + (e && e.message ? e.message : e));
      return;
    }
  }

  // Plain object keyed by profile_code (NOT `new Map()` — this module
  // imports OpenLayers' Map class, which would shadow the JS built-in).
  const profileInfoByCode = {};
  projectFeatures.forEach(f => {
    const code = f.get('profile_code');
    if (!code) return;
    profileInfoByCode[code] = {
      profile_id: f.get('profile_id'),
      project_name: f.get('project_name') || '',
      latitude: f.get('latitude'),
      longitude: f.get('longitude'),
      altitude: f.get('altitude'),
      sampling_date: f.get('sampling_date') || f.get('date') || '',
    };
  });
  const codes = new Set(Object.keys(profileInfoByCode));

  const baseCols = ['project_name', 'profile_id', 'profile_code', 'latitude',
                    'longitude', 'altitude', 'sampling_date',
                    'upper_depth', 'lower_depth'];
  const groups = {};
  const propColsSet = {};
  _allObservationsCache
    .filter(o => codes.has(o.profile_code))
    .forEach(o => {
      const key = o.profile_code + '|' +
        (o.upper_depth == null ? '' : o.upper_depth) + '|' +
        (o.lower_depth == null ? '' : o.lower_depth);
      let row = groups[key];
      if (!row) {
        const info = profileInfoByCode[o.profile_code] || {};
        row = {
          profile_id: info.profile_id != null ? info.profile_id : '',
          project_name: info.project_name || '',
          profile_code: o.profile_code,
          latitude: info.latitude != null ? Number(info.latitude).toFixed(5) : '',
          longitude: info.longitude != null ? Number(info.longitude).toFixed(5) : '',
          altitude: info.altitude != null ? info.altitude : '',
          sampling_date: info.sampling_date || '',
          upper_depth: o.upper_depth,
          lower_depth: o.lower_depth,
        };
        groups[key] = row;
      }
      const prop = o.property_num_id || o.property_phys_chem_id || '';
      const proc = o.procedure_num_id || o.procedure_phys_chem_id || '';
      const unit = o.unit_of_measure_id || '';
      const colKey = [prop, proc, unit].filter(Boolean).join('.');
      if (!colKey) return;
      if (!propColsSet[colKey]) propColsSet[colKey] = true;
      row[colKey] = o.value;
    });

  const rows = Object.keys(groups).map(k => groups[k]);
  if (!rows.length) {
    // No observations for any of this project's profiles — fall back to a
    // profile-only dump so the user still gets something useful.
    projectFeatures.forEach(f => {
      const code = f.get('profile_code');
      if (!code) return;
      const info = profileInfoByCode[code] || {};
      rows.push({
        profile_id: info.profile_id != null ? info.profile_id : '',
        project_name: info.project_name || '',
        profile_code: code,
        latitude: info.latitude != null ? Number(info.latitude).toFixed(5) : '',
        longitude: info.longitude != null ? Number(info.longitude).toFixed(5) : '',
        altitude: info.altitude != null ? info.altitude : '',
        sampling_date: info.sampling_date || '',
        upper_depth: '',
        lower_depth: '',
      });
    });
  }
  const propCols = Object.keys(propColsSet).sort();
  const columns = baseCols.concat(propCols);

  const defuse = (s) => /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  const csv = [columns.join(',')].concat(
    rows.map(r => columns.map(c => {
      const raw = r[c] == null ? '' : String(r[c]);
      const v = defuse(raw);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(','))
  ).join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = projectName.replace(/[^A-Za-z0-9._-]+/g, '_');
  a.href = url; a.download = `${safe}_observations.csv`; a.click();
  URL.revokeObjectURL(url);
}

function downloadProfilesCsv() {
  const modal = document.getElementById('profiles-data-modal');
  if (!modal || !modal._state) {
    alert(t('profiles.openPanelFirst'));
    return;
  }
  const { filtered, columns } = modal._state;
  // Defuse Excel/LibreOffice formula injection: cells that begin with =, +,
  // -, @, tab, or CR get a leading apostrophe so spreadsheet apps treat
  // them as text. https://owasp.org/www-community/attacks/CSV_Injection
  const defuse = (s) => /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  const csv = [columns.join(',')].concat(
    filtered.map(r => columns.map(c => {
      const raw = r[c] == null ? '' : String(r[c]);
      const v = defuse(raw);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(','))
  ).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'visible_observations.csv'; a.click();
  URL.revokeObjectURL(url);
}

function toggleProfilesDataSort(col, additive) {
  const modal = document.getElementById('profiles-data-modal');
  if (!modal || !modal._state) return;
  const state = modal._state;
  if (!state.sort) state.sort = [];
  const idx = state.sort.findIndex(s => s.col === col);
  if (!additive) {
    if (state.sort.length === 1 && idx === 0) {
      state.sort = state.sort[0].dir === 'asc' ? [{ col, dir: 'desc' }] : [];
    } else {
      state.sort = [{ col, dir: 'asc' }];
    }
  } else {
    if (idx === -1) state.sort.push({ col, dir: 'asc' });
    else if (state.sort[idx].dir === 'asc') state.sort[idx].dir = 'desc';
    else state.sort.splice(idx, 1);
  }
  state.page = 0;
  renderProfilesDataTable();
}

function renderProfilesDataTable() {
  const modal = document.getElementById('profiles-data-modal');
  if (!modal || !modal._state) return;
  const { rows, columns, columnMeta } = modal._state;
  const hiddenCols = modal._state.hiddenCols || new Set();
  const visibleColumns = columns.filter(c => !hiddenCols.has(c));
  const sortList = modal._state.sort || [];
  const pageSize = parseInt(document.getElementById('profiles-data-pagesize').value, 10);

  let filtered = rows.slice();
  const asNum = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  filtered.sort((a, b) => {
    const aSel = selectedProfileCodes.has(a.profile_code) ? 0 : 1;
    const bSel = selectedProfileCodes.has(b.profile_code) ? 0 : 1;
    if (aSel !== bSel) return aSel - bSel;
    for (const { col, dir } of sortList) {
      const va = a[col], vb = b[col];
      const aEmpty = va === null || va === undefined || va === '';
      const bEmpty = vb === null || vb === undefined || vb === '';
      if (aEmpty && bEmpty) continue;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      const na = asNum(va), nb = asNum(vb);
      let cmp;
      if (na !== null && nb !== null) cmp = na - nb;
      else cmp = String(va).localeCompare(String(vb));
      if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });
  modal._state.filtered = filtered;

  const total = filtered.length;
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  if (modal._state.page > maxPage) modal._state.page = maxPage;
  const start = modal._state.page * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  const sortIndicator = c => {
    const i = sortList.findIndex(s => s.col === c);
    if (i === -1) return '';
    const arrow = sortList[i].dir === 'asc' ? '▲' : '▼';
    const badge = sortList.length > 1 ? `<sup style="font-size:0.75em;">${i + 1}</sup>` : '';
    return ` ${arrow}${badge}`;
  };
  const thead = document.querySelector('#profiles-data-table thead tr');
  thead.innerHTML = visibleColumns.map(c => {
    const meta = (columnMeta && columnMeta[c]) || { line1: c, line2: '' };
    const line1 = escapeHtml(meta.line1 || '') + sortIndicator(c);
    const line2 = escapeHtml(meta.line2 || '\u00A0');
    const baseCls = meta.isBase ? ' pd-base' : '';
    return `<th class="pd-sort${baseCls}" data-col="${escapeHtml(c)}" style="cursor:pointer;user-select:none;" title="Click to sort; Shift+click to add secondary sort">` +
      `<div>${line1}</div><div style="font-weight:normal;color:#666;">${line2}</div></th>`;
  }).join('');
  thead.querySelectorAll('.pd-sort').forEach(th => {
    th.addEventListener('click', (e) => toggleProfilesDataSort(th.dataset.col, e.shiftKey));
  });

  // Inline bar showing where the value sits inside the typical/admissable
  // range from soil_data.observation_num. Padded by 50% on each side so
  // out-of-typical values are visible at the edges instead of clipping.
  // Falls back gracefully when bounds are missing or partial.
  function renderObservationBar(meta, raw) {
    if (!meta || !meta.prop || !meta.proc) return '';
    if (raw == null || raw === '') return '';
    const v = parseFloat(raw);
    if (!isFinite(v)) return '';
    if (!_observationBoundsCache) return '';
    const b = _observationBoundsCache.get(`${meta.prop}|${meta.proc}`);
    if (!b) return '';
    let lo = (b.typical_min != null) ? b.typical_min : b.value_min;
    let hi = (b.typical_max != null) ? b.typical_max : b.value_max;
    if (lo == null || hi == null || hi <= lo) return '';
    const span = hi - lo;
    const pmin = lo - span * 0.5;
    const pmax = hi + span * 0.5;
    const pos = Math.max(0, Math.min(1, (v - pmin) / (pmax - pmin)));
    const tloPct = ((lo - pmin) / (pmax - pmin)) * 100;
    const thiPct = ((hi - pmin) / (pmax - pmin)) * 100;

    let color = '#28a745';                       // green: in typical
    if (v < lo) color = '#f0ad4e';               // yellow: below typical
    else if (v > hi) color = '#fd7e14';          // orange: above typical
    if (b.value_min != null && v < b.value_min) color = '#dc3545'; // red: below admissable
    if (b.value_max != null && v > b.value_max) color = '#dc3545'; // red: above admissable

    const title = `value ${v} | typical ${lo}-${hi}` +
      (b.value_min != null || b.value_max != null
        ? ` | admissable ${b.value_min ?? '−∞'}-${b.value_max ?? '+∞'}`
        : '');
    return `<span title="${escapeHtml(title)}" style="display:inline-block;width:50px;height:8px;background:#eee;position:relative;margin-left:6px;vertical-align:middle;border-radius:2px;">
      <span style="position:absolute;left:${tloPct.toFixed(1)}%;width:${(thiPct - tloPct).toFixed(1)}%;height:100%;background:#cfd8dc;border-radius:1px;"></span>
      <span style="position:absolute;left:${(pos * 100).toFixed(1)}%;width:2px;height:10px;top:-1px;background:${color};border-radius:1px;"></span>
    </span>`;
  }

  const tbody = document.getElementById('profiles-data-tbody');
  tbody.innerHTML = pageRows.length
    ? pageRows.map(r => {
        const code = r.profile_code || '';
        const selected = selectedProfileCodes.has(code);
        const bg = selected ? 'background:#fff8c4;' : '';
        return `<tr data-profile-code="${escapeHtml(code)}" style="cursor:pointer;${bg}">` +
          visibleColumns.map(c => {
            const meta = (columnMeta && columnMeta[c]) || {};
            const cls = meta.isBase ? ' class="pd-base"' : '';
            const raw = r[c];
            const valueText = escapeHtml(raw == null ? '' : String(raw));
            const bar = renderObservationBar(meta, raw);
            return `<td${cls} style="white-space:nowrap;">${valueText}${bar}</td>`;
          }).join('') +
          '</tr>';
      }).join('')
    : `<tr><td colspan="${visibleColumns.length || 1}" class="empty-state">${t('profiles.noObservations')}</td></tr>`;

  document.getElementById('profiles-data-count').textContent = `${total} observation${total === 1 ? '' : 's'}`;
  document.getElementById('profiles-data-pageinfo').textContent =
    total ? `Page ${modal._state.page + 1} / ${maxPage + 1}` : '—';
  document.getElementById('profiles-data-prev').disabled = modal._state.page === 0;
  document.getElementById('profiles-data-next').disabled = modal._state.page >= maxPage;
}

