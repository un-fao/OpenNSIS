/**
 * Admin Panel Module
 * Manages Settings and Layers through a tabbed interface
 */

import api from './api-client.js';
import { AVAILABLE as LANGUAGES, currentLang, switchLanguage, t } from './i18n.js';
import Map from 'ol/Map';
import View from 'ol/View';
import { Tile as TileLayer } from 'ol/layer';
import { OSM, XYZ } from 'ol/source';
import { fromLonLat, toLonLat } from 'ol/proj';
import Chart from 'chart.js/auto';

const BASE_MAP_OPTIONS = {
  'esri-imagery': {
    label: 'Satellite',
    factory: () => new TileLayer({
      source: new XYZ({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attributions: 'Tiles © Esri',
        crossOrigin: 'anonymous'
      })
    })
  },
  'osm': {
    label: 'OpenStreetMap',
    factory: () => new TileLayer({ source: new OSM() })
  },
  'terrain': {
    label: 'Open TopoMap',
    factory: () => new TileLayer({
      source: new XYZ({
        url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
        attributions: '© OpenTopoMap (CC-BY-SA)',
        crossOrigin: 'anonymous'
      })
    })
  },
  // Keep in sync with the map view's baseLayers in main.js.
  'eox-terrain-light': {
    label: 'EOX Terrain Light',
    factory: () => new TileLayer({
      source: new XYZ({
        url: 'https://tiles.maps.eox.at/wmts/1.0.0/terrain-light_3857/default/g/{z}/{y}/{x}.jpg',
        attributions: 'Terrain Light © EOX (CC-BY 4.0)',
        crossOrigin: 'anonymous',
        maxZoom: 16
      })
    })
  }
};

class AdminDashboard {
  constructor() {
    this.currentTab = 'administration';
    this.settings = [];
    this.layers = [];
    this.users = [];
    this.isAdmin = false;
    this.editingItem = null;
    // ETL state
    this.etlCodelists = {};
    this.etlUploadResult = null;
    this.etlDatasets = [];
  }

  /**
   * Initialize and show the admin dashboard
   */
  async show() {
    // Check admin status before building UI
    try {
      const auth = await api.verifyAuth();
      this.isAdmin = !!auth.is_admin;
      this.currentUserId = auth.user_id || null;
    } catch (e) {
      this.isAdmin = false;
      this.currentUserId = null;
    }

    // Create dashboard HTML if it doesn't exist
    if (!document.getElementById('admin-dashboard')) {
      this.createDashboardHTML();
    }

    const dashboard = document.getElementById('admin-dashboard');
    dashboard.classList.add('active');
    document.body.classList.toggle('is-admin', !!this.isAdmin);

    // Gate the Administration tab by admin status
    const adminTabBtn = document.querySelector('.tab-btn[data-tab="administration"]');
    const adminPane = document.getElementById('administration-tab');
    if (this.isAdmin) {
      if (adminTabBtn) adminTabBtn.style.display = '';
      if (adminPane) adminPane.style.display = '';
      this.switchTab('administration');
      await this.loadSettings();
      await this.loadUsers();
      this.renderSettings();
      this.renderUsers();
      this.loadSoftwareVersion();
      this.initViewEditor();
      this.initGlosis();
      if (!this.admDivInited) {
        this.initAdminDivisionsTab();
        this.admDivInited = true;
      }
      this.loadAdminDivisions().then(() => this.renderAdminDivisions());
    } else {
      if (adminTabBtn) adminTabBtn.style.display = 'none';
      if (adminPane) adminPane.style.display = 'none';
      this.switchTab('layers');
    }

    await this.loadLayers();
    this.renderLayers();
    await this.loadSoilProfileLayers();
    this.renderSoilProfileLayers();
  }

  /**
   * Hide the admin dashboard
   */
  hide() {
    this.flushPendingSoilProfileEdits();
    const dashboard = document.getElementById('admin-dashboard');
    if (dashboard) {
      dashboard.classList.remove('active');
    }
    
    // Update the map login button back to "Admin Panel"
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn && api.isAuthenticated()) {
      if (window.setAuthButtonIcon) window.setAuthButtonIcon(loginBtn, 'user', t('auth.adminPanel'));
      else loginBtn.textContent = t('auth.adminPanel');
      loginBtn.onclick = () => {
        if (window.showAdminPanel) {
          window.showAdminPanel();
        }
      };
    }
    
    // Trigger map refresh to reload settings and layers
    if (window.refreshMapData && typeof window.refreshMapData === 'function') {
      console.log('[Admin Panel] Triggering map data refresh');
      window.refreshMapData();
    }
  }

  /**
   * Logout and close dashboard
   */
  logout() {
    // Perform logout
    api.logout();
    
    // Hide dashboard
    this.hide();
    
    // Reset login button to initial state
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) {
      if (window.setAuthButtonIcon) window.setAuthButtonIcon(loginBtn, 'user', t('auth.login'));
      else loginBtn.textContent = t('auth.login');
      loginBtn.onclick = () => {
        if (window.showLoginModal) {
          window.showLoginModal();
        } else if (api.isAuthenticated()) {
          window.showAdminPanel();
        } else {
          // Fallback: create simple login prompt
          const email = prompt(t('auth.username'));
          const password = prompt(t('auth.password'));
          if (email && password) {
            api.login(email, password)
              .then(() => {
                if (window.showAdminPanel) {
                  window.showAdminPanel();
                }
              })
              .catch(err => alert(t('a.err.loginFailed') + err.message));
          }
        }
      };
    }
    
    // Show confirmation
    alert(t('a.loggedOut'));
  }

  /**
   * Create the dashboard HTML structure
   */
  createDashboardHTML() {
    const dashboardHTML = `
      <div id="admin-dashboard" class="admin-dashboard">
        <div class="dashboard-content">
          <div class="dashboard-header">
            <h2>${t('a.adminPanel')}</h2>
            <div class="dashboard-header-actions">
              <button class="close-dashboard" id="close-dashboard">${t('a.backToMap')}</button>
              <button class="logout-btn" id="logout-dashboard">${t('a.logout')}</button>
              <div style="position:relative;display:flex;align-items:center;">
                <button type="button" class="admin-lang-btn" id="admin-lang-btn" title="${t('lang.label')}" aria-label="${t('lang.label')}">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.6 8.5h16.8M3.6 15.5h16.8"/></svg>
                </button>
                <div id="admin-lang-menu" style="position:absolute;top:calc(100% + 8px);right:0;background:#fff;border:1px solid #ddd;border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.15);display:none;min-width:130px;overflow:hidden;z-index:10001;"></div>
              </div>
            </div>
          </div>
          
          <ul class="dashboard-tabs">
            <li><button class="tab-btn" data-tab="account">${t('a.tab.account')}</button></li>
            <li><button class="tab-btn active" data-tab="administration">${t('a.tab.administration')}</button></li>
            <li><button class="tab-btn" data-tab="projects">${t('a.tab.projects')}</button></li>
            <li><button class="tab-btn" data-tab="layers">${t('a.tab.soilProfiles')}</button></li>
            <li><button class="tab-btn" data-tab="add-raster">${t('a.tab.rasters')}</button></li>
            <li><button class="tab-btn" data-tab="dst">${t('a.tab.dst')}</button></li>
            <li><button class="tab-btn" data-tab="dashboard">${t('a.tab.dashboard')}</button></li>
          </ul>

          <div class="dashboard-body">
            <!-- Administration Tab -->
            <div id="administration-tab" class="tab-pane active">
              <div class="admin-section">
                <h3 class="admin-section-title">${t('a.settings')}</h3>

                <div class="settings-map-layout">
                  <div class="settings-table-side">
                    <div id="settings-table-container">
                      <table class="admin-table" id="settings-table" style="width:auto;">
                        <thead>
                          <tr>
                            <th>${t('a.key')}</th>
                            <th style="width:350px;">${t('a.value')}</th>
                          </tr>
                        </thead>
                        <tbody id="settings-tbody">
                          <tr><td colspan="2" class="loading">${t('a.loadingSettings')}</td></tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div class="settings-map-side">
                    <div id="view-editor-map" style="width:100%;aspect-ratio:21/9;border:1px solid #ccc;border-radius:4px;min-height:180px;"></div>
                  </div>
                </div>
                <!-- hidden form elements kept for compatibility -->
                <form id="setting-form" style="display:none;">
                  <input type="text" id="setting-key">
                  <input type="text" id="setting-value">
                  <select id="setting-value-select"></select>
                  <span id="setting-btn-text"></span>
                  <button id="cancel-setting" type="button"></button>
                </form>
              </div>

              <hr class="admin-divider">

              <div class="admin-section">
                <h3 class="admin-section-title">${t('a.admdiv.title')}</h3>
                <p style="font-size:var(--fs-sm);color:#555;max-width:760px;">
                  ${t('a.admdiv.intro')}
                </p>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 16px;">
                  <input type="text" id="admdiv-name" placeholder="${t('a.admdiv.namePh')}" style="width:240px;">
                  <input type="file" id="admdiv-file" accept=".geojson,.json,.zip,.gpkg,.kml,.kmz">
                  <button type="button" id="admdiv-upload-btn" class="btn btn-primary btn-sm">${t('a.admdiv.upload')}</button>
                  <span id="admdiv-upload-status" style="font-size:var(--fs-sm);"></span>
                </div>
                <div style="overflow-x:auto;">
                  <table class="admin-table" id="admdiv-table">
                    <thead>
                      <tr>
                        <th title="${t('a.orderTip')}">${t('a.order')}</th>
                        <th>${t('a.name')}</th>
                        <th>${t('a.features')}</th>
                        <th>${t('a.strokeColour')}</th>
                        <th>${t('a.strokeWidth')}</th>
                        <th>${t('a.strokeType')}</th>
                        <th>${t('a.fillColour')}</th>
                        <th title="${t('a.fillOpacityTip')}">${t('a.fillOpacity')}</th>
                        <th title="${t('a.publishedTip')}">${t('a.published')}</th>
                        <th title="${t('a.sp.activeTip')}">${t('a.active')}</th>
                        <th>${t('a.delete')}</th>
                      </tr>
                    </thead>
                    <tbody id="admdiv-tbody">
                      <tr><td colspan="11" class="loading">${t('a.loadingLayers')}</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <hr class="admin-divider">

              <div class="admin-section">
                <h3 class="admin-section-title">${t('a.users')}</h3>
                <div id="users-table-container">
                <table class="admin-table" id="users-table">
                  <thead>
                    <tr>
                      <th>${t('a.username')}</th>
                      <th>${t('a.admin')}</th>
                      <th>${t('a.active')}</th>
                      <th>${t('a.created')}</th>
                      <th>${t('a.lastLogin')}</th>
                      <th style="width: 120px;">${t('a.actions')}</th>
                    </tr>
                  </thead>
                  <tbody id="users-tbody">
                    <tr><td colspan="6" class="loading">${t('a.loadingUsers')}</td></tr>
                  </tbody>
                </table>
              </div>
                <div style="margin-top:var(--sp-3);">
                  <form id="user-form" style="display:flex;align-items:flex-end;gap:var(--sp-3);flex-wrap:wrap;">
                    <div class="form-group" style="margin:0;">
                      <label for="user-email" style="font-size:var(--fs-xs);margin-bottom:2px;">${t('a.username')}</label>
                      <input type="text" id="user-email" required style="padding:4px 8px;font-size:var(--fs-sm);">
                    </div>
                    <div class="form-group" style="margin:0;">
                      <label for="user-password" style="font-size:var(--fs-xs);margin-bottom:2px;">${t('a.password')}</label>
                      <input type="password" id="user-password" required style="padding:4px 8px;font-size:var(--fs-sm);">
                    </div>
                    <label class="checkbox-label" style="font-size:var(--fs-sm);margin-bottom:4px;">
                      <input type="checkbox" id="user-is-admin"> ${t('a.admin')}
                    </label>
                    <button type="submit" class="btn btn-primary btn-sm">${t('a.addUser')}</button>
                    <button type="button" class="btn btn-secondary btn-sm" id="cancel-user" style="display:none;">${t('a.cancel')}</button>
                  </form>
                </div>
              </div>

              <hr class="admin-divider">

              <div class="admin-section" id="software-section">
                <h3 class="admin-section-title">${t('a.sw.title')}</h3>
                <p style="color:#555;font-size:var(--fs-sm);margin:0 0 var(--sp-3);">
                  ${t('a.sw.intro')} <code>un-fao/OpenNSIS</code> ${t('a.sw.intro2')} (<code>./update.sh</code>) ${t('a.sw.intro3')}
                </p>
                <div style="display:flex;align-items:center;gap:var(--sp-3);flex-wrap:wrap;">
                  <span>${t('a.sw.installed')}&nbsp;<code id="sw-current">…</code></span>
                  <button type="button" class="btn btn-sm btn-primary" id="sw-check-btn">${t('a.sw.check')}</button>
                  <span id="sw-status" style="font-size:var(--fs-sm);color:#555;"></span>
                </div>
                <div id="sw-result" style="display:none;margin-top:var(--sp-3);"></div>
              </div>

              <hr class="admin-divider">

              <div class="admin-section" id="glosis-section">
                <h3 class="admin-section-title">${t('a.glosis.title')}</h3>
                <p style="color:#555;font-size:var(--fs-sm);margin:0 0 var(--sp-3);">
                  ${t('a.glosis.p1')}<br>${t('a.glosis.p2')}<br>${t('a.glosis.p3')}
                </p>
                <div style="display:flex;align-items:center;gap:var(--sp-3);margin-bottom:var(--sp-3);">
                  <span><strong>${t('a.glosis.status')}</strong> <span id="glosis-status">…</span></span>
                  <button type="button" class="btn btn-success btn-sm" id="glosis-enable-btn">${t('a.glosis.enable')}</button>
                  <button type="button" class="btn btn-sm" id="glosis-disable-btn" style="background:#ffc107;color:#212529;">${t('a.glosis.disable')}</button>
                  <button type="button" class="btn btn-sm" id="glosis-disable-delete-btn" style="background:#dc3545;color:#fff;">${t('a.glosis.disableDelete')}</button>
                </div>

                <div style="margin-bottom:var(--sp-3);">
                  <strong>${t('a.glosis.endpoints')}</strong>
                  <ul id="glosis-endpoints" style="margin:4px 0 0 18px;font-size:var(--fs-sm);"></ul>
                </div>

              </div>

            </div>

            <!-- Dashboard Tab -->
            <div id="dashboard-tab" class="tab-pane">
              <div id="dashboard-empty" style="padding:var(--sp-5,24px);color:#777;">${t('a.dash.loading')}</div>
              <div id="dashboard-content" style="display:none;">
                <div class="stat-card-grid" id="stat-card-grid"></div>
                <div class="chart-grid">
                  <div class="chart-card">
                    <h4 class="chart-title">${t('a.dash.profilesPerProject')}</h4>
                    <div class="chart-wrap"><canvas id="chart-profiles-per-project"></canvas></div>
                  </div>
                  <div class="chart-card">
                    <h4 class="chart-title">${t('a.dash.rastersPerProject')}</h4>
                    <div class="chart-wrap"><canvas id="chart-rasters-per-project"></canvas></div>
                  </div>
                  <div class="chart-card">
                    <h4 class="chart-title">${t('a.dash.topProperties')}</h4>
                    <div class="chart-wrap"><canvas id="chart-top-properties"></canvas></div>
                  </div>
                  <div class="chart-card chart-card-wide">
                    <h4 class="chart-title">${t('a.dash.profilesPerYear')}</h4>
                    <div class="chart-wrap"><canvas id="chart-profiles-per-year"></canvas></div>
                  </div>
                  <div class="chart-card">
                    <h4 class="chart-title">${t('a.dash.depthDist')}</h4>
                    <div class="chart-wrap"><canvas id="chart-depth-distribution"></canvas></div>
                  </div>
                  <div class="chart-card">
                    <h4 class="chart-title">${t('a.dash.valueRange')}</h4>
                    <div class="chart-wrap"><canvas id="chart-value-summary"></canvas></div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Projects Tab -->
            <div id="projects-tab" class="tab-pane">
              <section class="layers-section">
                <h3 class="layers-section-title">${t('a.proj.title')}</h3>
                <p style="color:#666;margin:0 0 12px;">${t('a.proj.intro')}</p>
                <div style="margin-bottom:14px;">
                  <button type="button" class="btn btn-primary btn-sm" onclick="adminDashboard.openProjectModal(null)">${t('a.proj.new')}</button>
                </div>
                <table class="admin-table" id="projects-table">
                  <thead>
                    <tr>
                      <th>${t('a.name')}</th>
                      <th>${t('a.id')}</th>
                      <th>${t('a.description')}</th>
                      <th title="${t('a.proj.profilesTip')}">${t('a.sp.profiles')}</th>
                      <th title="${t('a.proj.rastersTip')}">${t('a.tab.rasters')}</th>
                      <th>${t('a.edit')}</th>
                      <th>${t('a.delete')}</th>
                    </tr>
                  </thead>
                  <tbody id="projects-tbody">
                    <tr><td colspan="7" class="loading">${t('a.loadingProjects')}</td></tr>
                  </tbody>
                </table>
              </section>
            </div>

            <!-- Layers Tab -->
            <div id="layers-tab" class="tab-pane">

              <!-- Upload CSV (formerly the standalone ETL tab) -->
              <section class="layers-section">
                <h3 class="layers-section-title">${t('a.etl.uploadCsv')}</h3>
                <div class="etl-steps">

                  <!-- List view (always visible unless detail panel open) -->
                  <div id="etl-list-view">
                    <div style="display:flex;align-items:center;gap:var(--sp-3);margin-bottom:var(--sp-4);">
                      <input type="file" id="etl-file-input" accept=".csv">
                      <button type="button" class="btn btn-primary btn-sm" id="etl-upload-btn">${t('a.etl.uploadCsv')}</button>
                      <span id="etl-upload-status" style="font-size:var(--fs-sm);"></span>
                    </div>
                    <div id="etl-datasets-list"></div>
                  </div>

                  <!-- Detail panel (hidden until Open is clicked) -->
                  <div id="etl-detail-panel" style="display:none;">

                    <div style="margin-bottom:var(--sp-4);">
                      <button type="button" class="btn btn-secondary btn-sm" id="etl-back-btn">${t('a.etl.backToList')}</button>
                      <span id="etl-detail-title" style="font-weight:600;margin-left:var(--sp-3);"></span>
                    </div>

                    <!-- Preview -->
                    <details id="etl-preview-section" class="etl-section" open>
                      <summary class="etl-section-title" style="cursor:pointer;">${t('a.etl.preview')} <span id="etl-preview-info" style="font-weight:normal;font-size:var(--fs-sm);color:#555;"></span></summary>
                      <div class="etl-preview-scroll" style="margin-top:var(--sp-3);">
                        <table class="admin-table" id="etl-preview-table">
                          <thead id="etl-preview-thead"></thead>
                          <tbody id="etl-preview-tbody"></tbody>
                        </table>
                      </div>
                      <div id="etl-preview-pager" style="display:flex;align-items:center;gap:var(--sp-3);font-size:var(--fs-sm);margin-bottom:var(--sp-3);">
                        <button type="button" class="btn btn-sm" id="etl-preview-prev">${t('a.etl.previous')}</button>
                        <span id="etl-preview-page-info"></span>
                        <button type="button" class="btn btn-sm" id="etl-preview-next">${t('a.etl.next')}</button>
                      </div>
                    </details>

                    <!-- Metadata -->
                    <div id="etl-section-metadata" class="etl-section">
                      <h3 class="etl-section-title">${t('a.etl.metadata')}</h3>
                      <form id="etl-metadata-form">
                        <div class="etl-metadata-grid" style="margin-bottom:var(--sp-4);">
                          <label for="etl-project">${t('a.project')}</label>
                          <div>
                            <select id="etl-project" required><option value="">${t('a.loading')}</option></select>
                          </div>
                        </div>

                        <div class="etl-metadata-grid" style="margin-bottom:var(--sp-4);">
                          <label for="etl-abstract">${t('a.etl.abstract')}</label>
                          <div><textarea id="etl-abstract" rows="6" style="width:400px;max-width:none;font-family:inherit;font-size:var(--fs-sm);padding:4px 8px;border:1px solid var(--color-border-strong);border-radius:var(--radius-sm);" placeholder="${t('a.etl.abstractPh')}"></textarea></div>
                          <label for="etl-license">${t('a.licence')}</label>
                          <div>
                            <select id="etl-license" style="width:100%;">
                              <option value="">${t('a.select')}</option>
                              <option value="CC BY">CC BY</option>
                              <option value="CC BY-SA">CC BY-SA</option>
                              <option value="CC BY-NC">CC BY-NC</option>
                              <option value="CC BY-NC-SA">CC BY-NC-SA</option>
                              <option value="CC BY-ND">CC BY-ND</option>
                              <option value="CC BY-NC-ND">CC BY-NC-ND</option>
                              <option value="CC0">CC0</option>
                              <option value="Public Domain Mark">Public Domain Mark</option>
                            </select>
                          </div>
                          <label for="etl-epsg">${t('a.etl.epsg')}</label>
                          <div><input type="text" id="etl-epsg" value="4326" style="width:80px;padding:2px 6px;font-size:var(--fs-sm);"></div>
                        </div>

                      </form>
                    </div>

                    <!-- Standardisation -->
                    <div id="etl-mapping-section" class="etl-section">
                      <h3 class="etl-section-title">${t('a.etl.standardisation')}</h3>
                      <table class="admin-table" id="etl-mapping-table">
                        <thead>
                          <tr>
                            <th>${t('a.etl.csvColumn')}</th>
                            <th>${t('a.etl.destination')}</th>
                            <th>${t('a.property')}</th>
                            <th>${t('a.procedure')}</th>
                            <th>${t('a.unit')}</th>
                            <th>${t('a.validation')}</th>
                          </tr>
                        </thead>
                        <tbody id="etl-mapping-tbody"></tbody>
                      </table>
                    </div>

                    <!-- Save / Validate -->
                    <div style="margin-top:var(--sp-5);display:flex;align-items:center;gap:var(--sp-3);">
                      <button type="button" class="btn btn-primary" id="etl-save-btn">${t('a.save')}</button>
                      <button type="button" class="btn" id="etl-validate-btn" style="background:#17a2b8;color:#fff;">${t('a.etl.validate')}</button>
                      <span id="etl-save-status" style="font-size:var(--fs-sm);"></span>
                    </div>

                  </div>

                </div>
              </section>

              <!-- Soil profiles section -->
              <section class="layers-section">
                <h3 class="layers-section-title">${t('a.sp.title')}</h3>
                <div id="soil-profile-layers-container">
                  <table class="admin-table" id="soil-profile-layers-table">
                    <thead>
                      <tr>
                        <th style="width:64px;" title="${t('a.orderTip')}">${t('a.order')}</th>
                        <th>${t('a.project')}</th>
                        <th>${t('a.sp.profiles')}</th>
                        <th>${t('a.sp.measurements')}</th>
                        <th title="${t('a.sp.symbologyTip')}">${t('a.sp.symbology')}</th>
                        <th>${t('a.sp.publicLimit')}</th>
                        <th title="${t('a.sp.blurTip')}">${t('a.sp.blur')}</th>
                        <th title="${t('a.sp.shareAttrsTip')}">${t('a.sp.shareAttrs')}</th>
                        <th title="${t('a.sp.showDlTip')}">${t('a.sp.showDl')}</th>
                        <th>${t('a.published')}</th>
                        <th title="${t('a.sp.activeTip')}">${t('a.active')}</th>
                        <th title="${t('a.sp.pruneTip')}">${t('a.sp.prune')}</th>
                      </tr>
                    </thead>
                    <tbody id="soil-profile-layers-tbody">
                      <tr><td colspan="9" class="loading">${t('a.sp.loading')}</td></tr>
                    </tbody>
                  </table>
                </div>
              </section>

            </div>

            <!-- Rasters Tab (formerly "Add Raster"; now also holds the rasters list moved from the Layers tab) -->
            <div id="add-raster-tab" class="tab-pane">

              <div style="display:flex;gap:var(--sp-5);align-items:flex-start;flex-wrap:wrap;">
              <section class="layers-section" style="flex:0 0 820px;max-width:820px;">
                <h3 class="layers-section-title">${t('a.raster.upload')}</h3>

                <div style="display:grid;grid-template-columns:auto 1fr;gap:var(--sp-2) var(--sp-3);align-items:center;">
                  <label>${t('a.raster.file')}</label>
                  <div>
                    <input type="file" id="raster-file-input" accept=".tif,.tiff">
                  </div>

                  <label>${t('a.country')}</label>
                  <select id="raster-country" style="width:320px;"><option value="">${t('a.loading')}</option></select>

                  <label>${t('a.project')}</label>
                  <div>
                    <select id="raster-project">
                      <option value="">${t('a.select')}</option>
                    </select>
                  </div>

                  <label>${t('a.raster.mappedProp')}</label>
                  <div>
                    <select id="raster-property-num" style="width:320px;"><option value="">${t('a.loading')}</option></select>
                    <div id="raster-property-new" style="display:none;margin-top:6px;">
                      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                        <input type="text" id="raster-new-property-id"
                               placeholder="${t('a.etl.procIdPh')}"
                               pattern="[A-Z0-9_]+"
                               title="${t('a.etl.procIdTip')}"
                               style="width:160px;text-transform:uppercase;">
                        <input type="text" id="raster-new-property-name"
                               placeholder="${t('a.raster.displayNamePh')}"
                               style="width:200px;">
                        <select id="raster-new-property-type" style="width:140px;" title="${t('a.propertyType')}">
                          <option value="quantitative">quantitative</option>
                          <option value="categorical">categorical</option>
                        </select>
                        <button type="button" class="btn btn-sm btn-primary" id="raster-add-property-btn">${t('a.add')}</button>
                        <span id="raster-new-property-status" style="font-size:var(--fs-sm);"></span>
                      </div>
                    </div>
                  </div>

                  <label>${t('a.unit')}</label>
                  <select id="raster-unit" style="width:140px;"><option value="">${t('a.pickPropertyFirst')}</option></select>

                  <label>${t('a.raster.createdOn')}</label>
                  <div style="display:flex;align-items:center;gap:var(--sp-3);">
                    <input type="text" id="raster-publication-date"
                           placeholder="YYYY-MM-DD"
                           pattern="\d{4}-\d{1,2}-\d{1,2}"
                           maxlength="10"
                           title="Format: YYYY-MM-DD"
                           style="width:140px;">
                    <span style="color:#666;font-size:var(--fs-sm);">${t('a.raster.createdOnHint')}</span>
                  </div>

                  <label>${t('a.raster.periodStart')}</label>
                  <div style="display:flex;align-items:center;gap:var(--sp-3);">
                    <input type="text" id="raster-time-period-begin"
                           placeholder="YYYY-MM-DD"
                           pattern="\d{4}-\d{1,2}-\d{1,2}"
                           maxlength="10"
                           title="Format: YYYY-MM-DD"
                           style="width:140px;">
                    <span style="color:#666;font-size:var(--fs-sm);">${t('a.raster.periodStartHint')}</span>
                  </div>

                  <label>${t('a.raster.periodEnd')}</label>
                  <div style="display:flex;align-items:center;gap:var(--sp-3);">
                    <input type="text" id="raster-time-period-end"
                           placeholder="YYYY-MM-DD"
                           pattern="\d{4}-\d{1,2}-\d{1,2}"
                           maxlength="10"
                           title="Format: YYYY-MM-DD"
                           style="width:140px;">
                    <span style="color:#666;font-size:var(--fs-sm);">${t('a.raster.periodEndHint')}</span>
                  </div>

                  <label>${t('a.raster.depth')}</label>
                  <div style="display:flex;gap:6px;align-items:center;">
                    <input type="number" id="raster-depth-upper" placeholder="${t('a.upper')}" min="0" max="1000" step="1" class="no-spinner" style="width:90px;">
                    <span>${t('a.to')}</span>
                    <input type="number" id="raster-depth-lower" placeholder="${t('a.lower')}" min="0" max="1000" step="1" class="no-spinner" style="width:90px;">
                  </div>

                  <label>${t('a.raster.stats')}</label>
                  <select id="raster-stats" style="width:140px;">
                    <option value="">${t('a.select')}</option>
                    <option value="MEAN">MEAN</option>
                    <option value="SDEV">SDEV</option>
                    <option value="UNCT">UNCT</option>
                  </select>

                  <label>${t('a.licence')}</label>
                  <select id="raster-license" style="width:220px;">
                    <option value="">${t('a.select')}</option>
                    <option value="CC BY">CC BY</option>
                    <option value="CC BY-SA">CC BY-SA</option>
                    <option value="CC BY-NC">CC BY-NC</option>
                    <option value="CC BY-NC-SA">CC BY-NC-SA</option>
                    <option value="CC BY-ND">CC BY-ND</option>
                    <option value="CC BY-NC-ND">CC BY-NC-ND</option>
                    <option value="CC0">CC0</option>
                    <option value="Public Domain Mark">Public Domain Mark</option>
                  </select>

                  <label>${t('a.raster.publish')}</label>
                  <div><input type="checkbox" id="raster-publish" checked></div>

                  <label>${t('a.raster.filename')}</label>
                  <code id="raster-filename-preview" style="font-size:var(--fs-sm);color:#444;background:#f7f7f7;padding:4px 8px;border-radius:4px;">—</code>
                </div>

                <div style="margin-top:var(--sp-4);display:flex;align-items:center;gap:var(--sp-3);">
                  <button type="button" class="btn btn-primary" id="raster-register-btn">${t('a.upload')}</button>
                  <button type="button" class="btn btn-secondary" id="raster-clear-btn">${t('a.clear')}</button>
                  <span id="raster-status" style="font-size:var(--fs-sm);"></span>
                </div>

              </section>

              <pre id="raster-inspect-output" style="flex:1 1 380px;min-width:340px;max-height:80vh;overflow:auto;background:#f7f7f7;padding:8px;font-size:11px;display:none;margin:0;"></pre>
              </div>

              <!-- Rasters list (moved here from the old Layers tab) -->
              <section class="layers-section" style="margin-top: var(--sp-6, 24px);">
                <h3 class="layers-section-title">${t('a.raster.list')}</h3>
                <div class="sync-bar" style="margin: 10px 0; display: flex; align-items: center; gap: 10px;">
                  <button type="button" class="btn btn-primary" id="check-wms-btn">${t('a.raster.checkWms')}</button>
                  <span id="sync-status" style="font-size: 0.9em; color: #555;"></span>
                </div>

                <div id="layers-table-container">
                  <table class="admin-table" id="layers-table">
                    <thead>
                      <tr>
                        <th style="width:64px;" title="${t('a.orderTip')}">${t('a.order')}</th>
                        <th>${t('a.raster.id')}</th>
                        <th>${t('a.raster.origFile')}</th>
                        <th style="width:120px;">${t('a.raster.group')}</th>
                        <th>${t('a.raster.name')}</th>
                        <th style="width:90px;">${t('legend.alt')}</th>
                        <th style="width:70px;" title="${t('a.raster.opacityTip')}">${t('a.raster.opacity')}</th>
                        <th>${t('a.published')}</th>
                        <th>${t('a.default')}</th>
                        <th>WMS</th>
                        <th class="raster-delete-col" style="width:90px;">${t('a.delete')}</th>
                      </tr>
                    </thead>
                    <tbody id="layers-tbody">
                      <tr><td colspan="8" class="loading">${t('a.loadingLayers')}</td></tr>
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <!-- DST Tab -->
            <div id="dst-tab" class="tab-pane">
              <section style="display:flex;flex-direction:column;gap:var(--sp-4);">
                <div>
                  <h3>${t('a.dst.recipes')}</h3>
                  <button type="button" class="btn btn-sm btn-primary" id="dst-new-btn" style="margin-bottom:var(--sp-3);">${t('a.dst.new')}</button>
                  <table class="admin-table" id="dst-recipes-table" style="width:100%;">
                    <thead><tr><th>${t('a.raster.id')}</th><th>${t('a.name')}</th><th>${t('a.status')}</th><th>${t('a.dst.lastRun')}</th><th>${t('a.actions')}</th></tr></thead>
                    <tbody id="dst-recipes-tbody"><tr><td colspan="5" class="loading">${t('a.loading')}</td></tr></tbody>
                  </table>
                </div>
                <div id="dst-editor-wrap" style="display:none;">
                  <h3>${t('a.dst.editor')} <span id="dst-editor-id" style="font-weight:normal;color:#666;font-size:var(--fs-sm);"></span></h3>
                  <div id="dst-editor" style="display:none;">
                    <div style="display:grid;grid-template-columns:auto 1fr;gap:var(--sp-2) var(--sp-3);align-items:center;">
                      <label>${t('a.project')}</label>
                      <div>
                        <select id="dst-output-project" style="width:320px;"><option value="DST">DST</option></select>
                        <div id="dst-output-project-new" style="display:none;margin-top:6px;">
                          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                            <input type="text" id="dst-new-output-project-id"
                                   placeholder="${t('a.dst.projIdPh')}"
                                   pattern="[A-Z0-9_]+"
                                   title="${t('a.etl.procIdTip')}"
                                   style="width:200px;text-transform:uppercase;">
                            <input type="text" id="dst-new-output-project-name" placeholder="${t('a.dst.projNamePh')}" style="width:240px;">
                            <button type="button" class="btn btn-sm btn-primary" id="dst-add-output-project-btn">${t('a.add')}</button>
                            <span id="dst-new-output-project-status" style="font-size:var(--fs-sm);"></span>
                          </div>
                          <textarea id="dst-new-output-project-description"
                                    placeholder="${t('a.dst.projDescPh')}"
                                    rows="2" style="width:100%;margin-top:4px;"></textarea>
                        </div>
                      </div>
                      <label>${t('a.dst.mappedProperty')}</label>
                      <div>
                        <select id="dst-output-property" style="width:320px;"><option value="SUITABILITY">SUITABILITY</option></select>
                        <div id="dst-output-property-new" style="display:none;margin-top:6px;">
                          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                            <input type="text" id="dst-new-output-property-id"
                                   placeholder="${t('a.etl.procIdPh')}"
                                   pattern="[A-Z0-9_]+"
                                   title="${t('a.etl.procIdTip')}"
                                   style="width:160px;text-transform:uppercase;">
                            <input type="text" id="dst-new-output-property-name"
                                   placeholder="${t('a.raster.displayNamePh')}"
                                   style="width:200px;">
                            <select id="dst-new-output-property-type" style="width:140px;" title="${t('a.propertyType')}">
                              <option value="quantitative">quantitative</option>
                              <option value="categorical">categorical</option>
                            </select>
                            <button type="button" class="btn btn-sm btn-primary" id="dst-add-output-property-btn">${t('a.add')}</button>
                            <span id="dst-new-output-property-status" style="font-size:var(--fs-sm);"></span>
                          </div>
                        </div>
                      </div>
                      <!-- recipe_id and description are populated by the
                           builder (recipe_id = output_layer_id, description =
                           auto-summary). Kept in the DOM but hidden so the
                           existing helpers still read/write them. -->
                      <label style="display:none;">recipe_id</label>
                      <input type="text" id="dst-recipe-id" style="display:none;">
                      <label style="display:none;">description</label>
                      <textarea id="dst-recipe-description" rows="2" style="display:none;"></textarea>
                    </div>
                    <h4 style="margin-top:var(--sp-4);margin-bottom:var(--sp-2);">${t('a.dst.inputLayers')}</h4>
                    <p style="font-size:var(--fs-xs);color:#666;margin:0 0 var(--sp-2) 0;">
                      ${t('a.dst.inputsIntro')}
                    </p>
                    <table class="admin-table" id="dst-rows-table" style="width:auto;font-size:var(--fs-sm);">
                      <thead>
                        <tr>
                          <th>${t('a.dst.layer')}</th>
                          <th style="text-align:right;padding-right:6px;">${t('a.min')}</th>
                          <th style="text-align:right;padding-left:6px;padding-right:56px;">${t('a.max')}</th>
                          <th style="padding-right:6px;">${t('a.dst.below')}</th>
                          <th style="padding-left:6px;padding-right:6px;text-align:center;">${t('a.dst.threshold')}</th>
                          <th style="padding-left:6px;">${t('a.dst.above')}</th>
                          <th style="width:30px;"></th>
                        </tr>
                      </thead>
                      <tbody id="dst-rows-tbody">
                        <tr><td colspan="7" class="empty-state">${t('a.dst.noInputs')}</td></tr>
                      </tbody>
                    </table>
                    <div style="margin-top:var(--sp-2);">
                      <button type="button" class="btn btn-sm btn-secondary" id="dst-add-row-btn">${t('a.dst.addLayer')}</button>
                    </div>
                    <div style="margin-top:var(--sp-3);display:flex;gap:var(--sp-2);align-items:center;">
                      <button type="button" class="btn btn-sm" id="dst-run-btn" style="background:#28a745;color:#fff;">${t('a.dst.run')}</button>
                      <span id="dst-status" style="font-size:var(--fs-sm);"></span>
                    </div>
                  </div>
                </div>
              </section>
            </div>

            <!-- My Account Tab -->
            <div id="account-tab" class="tab-pane">
              <div class="admin-form" style="max-width:500px;">
                <h3>${t('a.acct.title')}</h3>
                <p style="color:#555;font-size:0.85em;margin-bottom:var(--sp-4);">
                  ${t('a.acct.intro')}
                </p>
                <form id="account-form" style="display:grid;grid-template-columns:auto 220px;gap:var(--sp-2) var(--sp-3);align-items:center;">
                  <label for="account-current-password" style="font-size:var(--fs-sm);white-space:nowrap;">${t('a.acct.currentPw')}</label>
                  <input type="password" id="account-current-password" required style="padding:4px 8px;font-size:var(--fs-sm);width:100%;box-sizing:border-box;">
                  <label for="account-new-email" style="font-size:var(--fs-sm);white-space:nowrap;">${t('a.acct.newUser')}</label>
                  <input type="text" id="account-new-email" placeholder="${t('a.acct.keepCurrent')}" style="padding:4px 8px;font-size:var(--fs-sm);width:100%;box-sizing:border-box;">
                  <label for="account-new-password" style="font-size:var(--fs-sm);white-space:nowrap;">${t('a.acct.newPw')}</label>
                  <input type="password" id="account-new-password" placeholder="${t('a.acct.keepCurrent')}" style="padding:4px 8px;font-size:var(--fs-sm);width:100%;box-sizing:border-box;">
                  <div></div>
                  <div style="display:flex;align-items:center;gap:var(--sp-3);">
                    <button type="submit" class="btn btn-primary btn-sm">${t('a.update')}</button>
                    <span id="account-status" style="font-size:0.85em;"></span>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', dashboardHTML);
    this.attachEventListeners();
  }

  /**
   * Attach all event listeners
   */
  attachEventListeners() {
    // Language switcher — same globe/dropdown as the map view. Switching
    // reloads the page; a sessionStorage flag makes main.js reopen the panel.
    const langBtn = document.getElementById('admin-lang-btn');
    const langMenu = document.getElementById('admin-lang-menu');
    if (langBtn && langMenu) {
      for (const [code, label] of LANGUAGES) {
        const item = document.createElement('div');
        item.textContent = label;
        item.style.cssText = 'padding:8px 14px;cursor:pointer;font-size:13px;color:#333;'
          + (code === currentLang() ? 'font-weight:700;background:#f2f7f2;' : '');
        item.addEventListener('mouseenter', () => { item.style.background = '#eef3ee'; });
        item.addEventListener('mouseleave', () => { item.style.background = code === currentLang() ? '#f2f7f2' : ''; });
        item.addEventListener('click', () => {
          try { sessionStorage.setItem('sis_reopen_admin', '1'); } catch (e) { /* private mode */ }
          switchLanguage(code);
        });
        langMenu.appendChild(item);
      }
      langBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        langMenu.style.display = langMenu.style.display === 'none' ? 'block' : 'none';
      });
      document.addEventListener('click', () => { langMenu.style.display = 'none'; });
    }

    // Close dashboard
    document.getElementById('close-dashboard').addEventListener('click', () => {
      this.hide();
    });

    // Logout button - instant logout (no confirmation)
    const logoutBtn = document.getElementById('logout-dashboard');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        this.logout();
      });
    }

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.target.dataset.tab;
        this.switchTab(tab);
      });
    });

    // Settings form
    document.getElementById('setting-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSettingSubmit();
    });

    document.getElementById('cancel-setting').addEventListener('click', () => {
      this.cancelSettingEdit();
    });

    document.getElementById('user-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleUserSubmit();
    });

    document.getElementById('cancel-user').addEventListener('click', () => {
      document.getElementById('user-form').reset();
    });

    document.getElementById('check-wms-btn').addEventListener('click', () => {
      this.checkAllWms();
    });

    document.getElementById('account-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleAccountSubmit();
    });

    const swBtn = document.getElementById('sw-check-btn');
    if (swBtn) swBtn.addEventListener('click', () => this.checkForUpdates());

    // ETL metadata form — prevent default submit, save handled by unified button
    document.getElementById('etl-metadata-form').addEventListener('submit', (e) => {
      e.preventDefault();
    });

    // ETL upload
    document.getElementById('etl-upload-btn').addEventListener('click', () => {
      this.handleEtlUpload();
    });

    // ETL back to list
    document.getElementById('etl-back-btn').addEventListener('click', () => {
      this.closeDetailPanel();
    });

    // ETL unified save (attribution + standardisation)
    document.getElementById('etl-save-btn').addEventListener('click', () => {
      this.handleEtlSave();
    });

    // ETL validate
    document.getElementById('etl-validate-btn').addEventListener('click', () => {
      this.handleEtlValidate();
    });

    // Picking a licence is part of validation — re-validate so the note clears
    // the "licence not set" issue immediately (and Ingest unblocks).
    document.getElementById('etl-license').addEventListener('change', () => {
      const section = document.getElementById('etl-mapping-section');
      if (section && section.dataset.tableName) this.handleEtlValidate();
    });

    // Preview pagination
    document.getElementById('etl-preview-prev').addEventListener('click', () => {
      if (this.etlPreviewPage > 0) { this.etlPreviewPage--; this.renderEtlPreviewPage(); }
    });
    document.getElementById('etl-preview-next').addEventListener('click', () => {
      const total = (this.etlPreviewRows || []).length;
      const max = Math.max(0, Math.ceil(total / (this.etlPreviewPageSize || 100)) - 1);
      if (this.etlPreviewPage < max) { this.etlPreviewPage++; this.renderEtlPreviewPage(); }
    });

    // Save view is now triggered automatically on map moveend
  }

  initViewEditor() {
    const container = document.getElementById('view-editor-map');
    if (!container) return;

    const getSetting = (k, fallback) => {
      const s = this.settings.find(s => s.key === k);
      const v = s ? parseFloat(s.value) : NaN;
      return Number.isFinite(v) ? v : fallback;
    };
    const lat = getSetting('LATITUDE', 0);
    const lon = getSetting('LONGITUDE', 0);
    const zoom = getSetting('ZOOM', 2);
    const baseEntry = BASE_MAP_OPTIONS['osm'];

    if (this.viewEditorMap) {
      this.viewEditorMap.setTarget(null);
      this.viewEditorMap = null;
    }

    this.viewEditorMap = new Map({
      target: container,
      layers: [baseEntry.factory()],
      view: new View({
        center: fromLonLat([lon, lat]),
        zoom
      })
    });

    setTimeout(() => this.viewEditorMap && this.viewEditorMap.updateSize(), 100);

    // Auto-save lat/lon/zoom on map move
    let saveTimeout = null;
    this.viewEditorMap.on('moveend', () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => this.handleSaveView(), 400);
    });
  }

  async handleSaveView() {
    if (!this.viewEditorMap) return;
    const view = this.viewEditorMap.getView();
    const [lon, lat] = toLonLat(view.getCenter());
    const zoom = view.getZoom();

    const upsert = async (key, value) => {
      const exists = this.settings.find(s => s.key === key);
      if (exists) {
        await api.updateSetting(key, String(value));
      } else {
        await api.createSetting(key, String(value));
      }
    };

    try {
      await upsert('LATITUDE', lat.toFixed(6));
      await upsert('LONGITUDE', lon.toFixed(6));
      await upsert('ZOOM', Math.round(zoom));
      await this.loadSettings();
      this.renderSettings();
    } catch (e) {
      console.error('Error saving view:', e.message);
    }
  }

  async handleAccountSubmit() {
    const currentPassword = document.getElementById('account-current-password').value;
    const newEmail = document.getElementById('account-new-email').value.trim();
    const newPassword = document.getElementById('account-new-password').value;
    const statusEl = document.getElementById('account-status');

    if (!currentPassword) {
      statusEl.textContent = t('a.acct.pwRequired');
      statusEl.style.color = '#c33';
      return;
    }
    if (!newEmail && !newPassword) {
      statusEl.textContent = t('a.acct.nothing');
      statusEl.style.color = '#c33';
      return;
    }

    statusEl.textContent = t('a.acct.updating');
    statusEl.style.color = '#555';

    try {
      await api.updateOwnAccount(currentPassword, newEmail || null, newPassword || null);
      statusEl.textContent = t('a.acct.updated');
      statusEl.style.color = '#2a7';
      document.getElementById('account-form').reset();
      if (newEmail) this.currentUserId = newEmail;
    } catch (error) {
      statusEl.textContent = t('a.err.prefix') + error.message;
      statusEl.style.color = '#c33';
    }
  }

  // The API may emit absolute MapServer URLs (e.g. http://localhost/mapserver/…)
  // that point at the server's own host, not the browser's. Strip the origin so
  // the request resolves against whatever origin:port the SPA is served from.
  _relMapserverUrl(u) {
    if (!u) return u;
    try { const x = new URL(u, window.location.origin); return x.pathname + x.search; }
    catch (e) { return u; }
  }

  async checkAllWms() {
    const btn = document.getElementById('check-wms-btn');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = t('a.st.checking');

    this.layers.forEach(layer => {
      const cell = document.getElementById(`wms-status-${layer.layer_id}`);
      if (cell) cell.innerHTML = '<span style="color:#888;">…</span>';
    });

    await Promise.all(this.layers.map(async (layer) => {
      const cell = document.getElementById(`wms-status-${layer.layer_id}`);
      if (!cell) return;
      if (!layer.get_legend_url) {
        cell.innerHTML = `<span style="color:#888;" title="${t('a.noUrl')}">—</span>`;
        return;
      }
      try {
        const res = await fetch(this._relMapserverUrl(layer.get_legend_url), { method: 'GET', cache: 'no-store' });
        const ct = res.headers.get('content-type') || '';
        if (res.ok && ct.startsWith('image/')) {
          cell.innerHTML = '<span style="color:#2a7;font-weight:bold;" title="OK">✓</span>';
        } else {
          cell.innerHTML = `<span style="color:#c33;font-weight:bold;" title="HTTP ${res.status} · ${ct}">✗</span>`;
        }
      } catch (e) {
        cell.innerHTML = `<span style="color:#c33;font-weight:bold;" title="${this.escapeHtml(e.message)}">✗</span>`;
      }
    }));

    btn.disabled = false;
    btn.textContent = originalText;
  }

  /**
   * Switch between tabs
   */
  switchTab(tab) {
    if (this.currentTab === 'layers' && tab !== 'layers') {
      this.flushPendingSoilProfileEdits();
    }
    this.currentTab = tab;

    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
      if (btn.dataset.tab === tab) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Update tab panes
    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.remove('active');
    });
    document.getElementById(`${tab}-tab`).classList.add('active');

    if (tab === 'dashboard') {
      this.loadDashboard();
    }

    // Soil profiles tab now hosts the ETL "Upload profiles" section too.
    // Load ETL codelists lazily on first open, and refresh profile counts
    // every time (they can be stale after an ingest/prune).
    if (tab === 'layers') {
      if (!this.etlCodelistsLoaded) {
        this.loadEtlCodelists();
      }
      this.loadSoilProfileLayers().then(() => this.renderSoilProfileLayers());
    }

    if (tab === 'projects') {
      this.loadProjects().then(() => this.renderProjects());
    }

    if (tab === 'add-raster') {
      if (!this.rasterInited) {
        this.initAddRasterTab();
        this.rasterInited = true;
      }
      // Always refresh the raster list on entry — it can change from DST runs,
      // uploads, or a project delete/reassign in the Projects tab.
      this.loadLayers().then(() => this.renderLayers());
    }
    if (tab === 'dst' && !this.dstInited) {
      this.initDstTab();
      this.dstInited = true;
    }

    if (tab === 'administration' && this.isAdmin) {
      // Refresh on every entry — the lists are otherwise only loaded at
      // login and go stale (e.g. a user renaming their own account still
      // showed under the old name).
      this.loadUsers().then(() => this.renderUsers());
      this.loadSettings().then(() => this.renderSettings());
      if (this.admDivInited) {
        this.loadAdminDivisions().then(() => this.renderAdminDivisions());
      }
    }
  }

  // ==================== Projects management ====================
  async loadProjects() {
    try {
      this.projects = await api.getManagedProjects();
    } catch (e) {
      console.error('loadProjects:', e);
      this.projects = [];
    }
  }

  renderProjects() {
    const tbody = document.getElementById('projects-tbody');
    if (!tbody) return;
    const rows = this.projects || [];
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${t('a.proj.none')}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(p => {
      const pid = this.escapeHtml(p.project_id);
      const name = this.escapeHtml(p.name || p.project_id);
      const desc = this.escapeHtml(p.description || '');
      return `
      <tr>
        <td><strong>${name}</strong></td>
        <td>${pid}</td>
        <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${desc}">${desc}</td>
        <td>${Number(p.profile_count || 0).toLocaleString()}</td>
        <td>${Number(p.raster_count || 0).toLocaleString()}</td>
        <td><button class="btn btn-secondary btn-sm proj-edit-btn" data-project-id="${pid}">${t('a.edit')}</button></td>
        <td><button class="btn btn-sm proj-del-btn" style="background:#dc3545;color:#fff;" data-project-id="${pid}">${t('a.delete')}</button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('.proj-edit-btn').forEach(b => b.addEventListener('click', (e) => {
      const p = (this.projects || []).find(x => String(x.project_id) === e.currentTarget.dataset.projectId);
      if (p) this.openProjectModal(p);
    }));
    tbody.querySelectorAll('.proj-del-btn').forEach(b => b.addEventListener('click', (e) => {
      const p = (this.projects || []).find(x => String(x.project_id) === e.currentTarget.dataset.projectId);
      if (p) this.openDeleteProjectModal(p);
    }));
  }

  _openModal(title, bodyHtml, width) {
    const existing = document.getElementById('project-modal-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'project-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:8px;max-width:${width || 560}px;width:92%;max-height:88vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.3);">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #eee;">
          <h3 style="margin:0;font-size:17px;">${this.escapeHtml(title)}</h3>
          <button type="button" class="pm-close" style="border:none;background:none;font-size:22px;cursor:pointer;color:#888;">&times;</button>
        </div>
        <div style="padding:18px;" class="pm-body">${bodyHtml}</div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.pm-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    return { overlay, body: overlay.querySelector('.pm-body'), close };
  }

  _roleOptions(selected) {
    const roles = ['author', 'custodian', 'distributor', 'originator', 'owner', 'pointOfContact',
                   'principalInvestigator', 'processor', 'publisher', 'resourceProvider', 'user'];
    return roles.map(r => `<option value="${r}"${r === selected ? ' selected' : ''}>${r}</option>`).join('');
  }

  _refreshProjectAuthorDropdowns() {
    const orgOpts = `<option value="">${t('a.select')}</option>`
      + (this._projOrgs || []).map(o => `<option value="${this.escapeHtml(o.organisation_id)}">${this.escapeHtml(o.organisation_id + (o.country ? ' (' + o.country + ')' : ''))}</option>`).join('')
      + `<option value="__new__">${t('a.pm.addNew')}</option>`;
    const indOpts = `<option value="">${t('a.select')}</option>`
      + (this._projInds || []).map(i => `<option value="${this.escapeHtml(i.individual_id)}">${this.escapeHtml(i.individual_id + (i.email ? ' — ' + i.email : ''))}</option>`).join('')
      + `<option value="__new__">${t('a.pm.addNew')}</option>`;
    document.querySelectorAll('.proj-org-sel').forEach(sel => {
      const prev = sel.dataset.value || sel.value; sel.innerHTML = orgOpts;
      if (prev && prev !== '__new__') sel.value = prev;
      sel.onchange = async () => {
        if (sel.value !== '__new__') return;
        const id = (prompt(t('a.pm.newOrgPrompt')) || '').trim();
        if (!id) { sel.value = ''; return; }
        try { await api.createOrganisation({ organisation_id: id }); this._projOrgs.push({ organisation_id: id }); this._refreshProjectAuthorDropdowns(); sel.value = id; }
        catch (e) { alert(t('a.err.prefix') + e.message); sel.value = ''; }
      };
    });
    document.querySelectorAll('.proj-ind-sel').forEach(sel => {
      const prev = sel.dataset.value || sel.value; sel.innerHTML = indOpts;
      if (prev && prev !== '__new__') sel.value = prev;
      sel.onchange = async () => {
        if (sel.value !== '__new__') return;
        const id = (prompt(t('a.pm.newIndPrompt')) || '').trim();
        if (!id) { sel.value = ''; return; }
        try { await api.createIndividual({ individual_id: id }); this._projInds.push({ individual_id: id }); this._refreshProjectAuthorDropdowns(); sel.value = id; }
        catch (e) { alert(t('a.err.prefix') + e.message); sel.value = ''; }
      };
    });
  }

  // Shared by the modal's Authors header and each author row so the columns
  // stay aligned.
  get _projAuthorGridCols() { return '1.4fr 1.4fr 100px 130px 26px'; }

  addProjectAuthorRow(author) {
    const container = document.getElementById('project-author-rows');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'etl-author-row';
    // Grid, not flex: a select's intrinsic min-width is its widest option
    // (author names carry e-mail addresses), so flex items refuse to shrink
    // and the row wraps. min-width:0 lets the grid clip them instead.
    row.style.cssText = `display:grid;grid-template-columns:${this._projAuthorGridCols};column-gap:6px;margin-bottom:6px;align-items:center;flex-wrap:nowrap;padding-right:0;`;
    row.innerHTML = `
      <select class="proj-org-sel" data-value="${this.escapeHtml((author && author.organisation_id) || '')}" style="min-width:0;width:100%;"><option>${t('a.loading')}</option></select>
      <select class="proj-ind-sel" data-value="${this.escapeHtml((author && author.individual_id) || '')}" style="min-width:0;width:100%;"><option>${t('a.loading')}</option></select>
      <input type="text" class="proj-pos-input" placeholder="${t('a.pm.position')}" value="${this.escapeHtml((author && author.position) || '')}" style="min-width:0;width:100%;box-sizing:border-box;">
      <select class="proj-role-sel" style="min-width:0;width:100%;">${this._roleOptions((author && author.role) || 'author')}</select>
      <button type="button" class="btn btn-danger btn-sm" title="${t('a.remove')}" onclick="this.closest('.etl-author-row').remove()" style="width:26px;">&times;</button>`;
    container.appendChild(row);
    this._refreshProjectAuthorDropdowns();
  }

  // Unified create/edit modal. `project` null => create (editable, validated
  // Project ID); otherwise edit (id shown read-only). Both offer the same
  // organisation/authors editor.
  async openProjectModal(project) {
    const isNew = !project;
    const pid = isNew ? '' : project.project_id;
    const cc = isNew ? '' : (project.country_id || '');
    const idRow = isNew
      ? `<input class="pm-id" placeholder="${t('a.pm.idPh')}" title="${t('a.pm.idRuleTip')}" style="width:100%;box-sizing:border-box;margin-bottom:12px;" oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9]/g,'')">`
      : `<input class="pm-id" value="${this.escapeHtml(pid)}" disabled style="width:100%;box-sizing:border-box;margin-bottom:12px;background:#f2f2f2;color:#666;">`;
    const { body } = this._openModal(isNew ? t('a.pm.newProject') : t('a.pm.editProject') + (project.name || pid), `
      <label style="display:block;font-weight:600;margin-bottom:4px;">${t('a.pm.projectId')}</label>
      ${idRow}
      <label style="display:block;font-weight:600;margin-bottom:4px;">${t('a.name')}</label>
      <input class="pm-name" style="width:100%;box-sizing:border-box;margin-bottom:12px;" value="${this.escapeHtml(isNew ? '' : (project.name || ''))}">
      <label style="display:block;font-weight:600;margin-bottom:4px;">${t('a.description')}</label>
      <textarea class="pm-description" rows="3" style="width:100%;box-sizing:border-box;margin-bottom:14px;">${this.escapeHtml(isNew ? '' : (project.description || ''))}</textarea>
      <label style="display:block;font-weight:600;margin-bottom:4px;">${t('a.pm.authors')}</label>
      <div style="display:grid;grid-template-columns:${this._projAuthorGridCols};column-gap:6px;font-size:12px;color:#666;margin-bottom:4px;">
        <div>${t('a.pm.organisation')}</div><div>${t('a.pm.author')}</div><div>${t('a.pm.position')}</div><div>${t('a.pm.role')}</div><div></div>
      </div>
      <div id="project-author-rows"></div>
      <button type="button" class="btn btn-secondary btn-sm pm-add-author" style="margin-top:6px;">${t('a.pm.addAuthor')}</button>
      <div class="pm-status" style="margin-top:10px;font-size:12px;"></div>
      <div style="margin-top:14px;text-align:right;">
        <button type="button" class="btn btn-secondary btn-sm pm-cancel">${t('a.cancel')}</button>
        <button type="button" class="btn btn-primary btn-sm pm-save">${isNew ? t('a.pm.create') : t('a.save')}</button>
      </div>`, 760);
    body.querySelector('.pm-add-author').addEventListener('click', () => this.addProjectAuthorRow());
    body.querySelector('.pm-cancel').addEventListener('click', () => document.getElementById('project-modal-overlay').remove());
    body.querySelector('.pm-save').addEventListener('click', () => this.saveProject(isNew, pid, cc));
    try {
      const [orgs, inds] = await Promise.all([api.getOrganisations(), api.getIndividuals()]);
      this._projOrgs = orgs || []; this._projInds = inds || [];
      let list = [];
      if (!isNew) {
        const authors = await api.getProjectAuthors(pid, cc);
        list = Array.isArray(authors) ? authors : (authors && authors.authors) || [];
      }
      if (list.length === 0) this.addProjectAuthorRow();
      else list.forEach(a => this.addProjectAuthorRow(a));
    } catch (e) {
      const s = body.querySelector('.pm-status'); if (s) { s.textContent = t('a.pm.loadAuthorsFailed') + e.message; s.style.color = '#dc3545'; }
      this.addProjectAuthorRow();
    }
  }

  async saveProject(isNew, pid, cc) {
    const overlay = document.getElementById('project-modal-overlay');
    if (!overlay) return;
    const status = overlay.querySelector('.pm-status');
    let projectId = pid;
    if (isNew) {
      projectId = (overlay.querySelector('.pm-id').value || '').trim().toUpperCase();
      if (!/^[A-Z0-9]+$/.test(projectId)) {
        status.textContent = t('a.pm.idRule');
        status.style.color = '#dc3545'; return;
      }
    }
    const name = overlay.querySelector('.pm-name').value.trim();
    const description = overlay.querySelector('.pm-description').value.trim();
    if (!name) { status.textContent = t('a.pm.nameRequired'); status.style.color = '#dc3545'; return; }
    const authors = [];
    overlay.querySelectorAll('#project-author-rows .etl-author-row').forEach(r => {
      const org = r.querySelector('.proj-org-sel').value;
      const ind = r.querySelector('.proj-ind-sel').value;
      if (!org || org === '__new__' || !ind || ind === '__new__') return;
      authors.push({
        organisation_id: org, individual_id: ind,
        position: r.querySelector('.proj-pos-input').value.trim(),
        tag: 'pointOfContact', role: r.querySelector('.proj-role-sel').value || 'author'
      });
    });
    status.textContent = isNew ? t('a.st.creating') : t('a.st.saving2'); status.style.color = '#666';
    try {
      if (isNew) await api.createProject({ project_id: projectId, name, description: description || null });
      else await api.updateProject(projectId, { name, description: description || null });
      // On edit always save (to persist removals); on create only if any given.
      if (!isNew || authors.length) {
        await api.saveEtlMetadata({ project_id: projectId, country_id: cc || undefined, authors });
      }
      overlay.remove();
      await this.loadProjects(); this.renderProjects();
    } catch (e) { status.textContent = t('a.err.prefix') + e.message; status.style.color = '#dc3545'; }
  }

  async openDeleteProjectModal(project) {
    const pid = project.project_id;
    let dep;
    try { dep = await api.getProjectDependents(pid); }
    catch (e) { alert(t('a.pm.loadDepsFailed') + e.message); return; }
    const cc = dep.country_id || project.country_id || '';
    const others = (this.projects || []).filter(p => String(p.project_id) !== String(pid));
    const targetSelect = (kind) => `<select class="pm-${kind}-target" style="margin-left:8px;">`
      + others.map(p => `<option value="${this.escapeHtml(p.project_id)}">${this.escapeHtml(p.name || p.project_id)} (${this.escapeHtml(p.project_id)})</option>`).join('')
      + `</select>`;
    const typeBlock = (kind, label, count) => {
      if (!count) return `<p style="color:#888;margin:6px 0;">${t('a.pm.noDeps', {label})}</p>`;
      const hasTargets = others.length > 0;
      return `
      <div style="border:1px solid #eee;border-radius:6px;padding:10px;margin:8px 0;">
        <strong>${count.toLocaleString()} ${label}</strong>
        <div style="margin-top:6px;">
          <label style="display:block;margin:3px 0;"><input type="radio" name="pm-${kind}-action" value="delete" checked> ${t('a.pm.deleteThem')}</label>
          <label style="display:block;margin:3px 0;${hasTargets ? '' : 'color:#aaa;'}">
            <input type="radio" name="pm-${kind}-action" value="reassign" ${hasTargets ? '' : 'disabled'}> ${t('a.pm.reassignTo')} ${hasTargets ? targetSelect(kind) : t('a.pm.noOther')}
          </label>
        </div>
      </div>`;
    };
    const { body } = this._openModal(t('a.pm.deleteTitle') + (project.name || pid), `
      <p>${t('a.pm.deleteIntro')} <strong>${this.escapeHtml(project.name || pid)}</strong> (<code>${this.escapeHtml(pid)}</code>). ${t('a.pm.deleteIntro2')}</p>
      ${typeBlock('profiles', t('a.pm.profilesLabel'), dep.profiles.count)}
      ${typeBlock('rasters', t('a.pm.rastersLabel'), dep.rasters.count)}
      <div class="pm-status" style="margin-top:8px;font-size:12px;color:#dc3545;"></div>
      <div style="margin-top:14px;text-align:right;">
        <button type="button" class="btn btn-secondary btn-sm pm-cancel">${t('a.cancel')}</button>
        <button type="button" class="btn btn-sm pm-confirm" style="background:#dc3545;color:#fff;">${t('a.pm.deleteBtn')}</button>
      </div>`, 560);
    body.querySelector('.pm-cancel').addEventListener('click', () => document.getElementById('project-modal-overlay').remove());
    body.querySelector('.pm-confirm').addEventListener('click', () => this.confirmDeleteProject(pid, dep));
  }

  async confirmDeleteProject(projectId, dep) {
    const overlay = document.getElementById('project-modal-overlay');
    if (!overlay) return;
    const status = overlay.querySelector('.pm-status');
    const actions = {};
    const build = (kind) => {
      const sel = overlay.querySelector(`input[name="pm-${kind}-action"]:checked`);
      if (!sel) return null;
      if (sel.value === 'reassign') {
        const t = overlay.querySelector(`.pm-${kind}-target`);
        return { action: 'reassign', target_project_id: t ? t.value : null };
      }
      return { action: 'delete' };
    };
    if (dep.profiles.count) actions.profiles = build('profiles');
    if (dep.rasters.count) actions.rasters = build('rasters');
    status.style.color = '#666'; status.textContent = t('a.st.working');
    try {
      const res = await api.deleteProject(projectId, actions);
      overlay.remove();
      await this.loadProjects(); this.renderProjects();
      const warns = (res && res.warnings) || [];
      if (!res.project_deleted || warns.length) {
        alert((res.message || t('a.done')) + (warns.length ? '\n\n- ' + warns.join('\n- ') : ''));
      }
    } catch (e) { status.style.color = '#dc3545'; status.textContent = t('a.err.prefix') + e.message; }
  }

  // ==================== Add Raster ====================

  async initAddRasterTab() {
    // Load codelists in parallel.
    const [countries, projects, properties] = await Promise.all([
      api.listRasterCountries().catch(e => { console.warn('countries:', e.message); return []; }),
      api.listRasterProjects().catch(e => { console.warn('projects:', e.message); return []; }),
      api.listRasterMappedSoilProperties().catch(e => { console.warn('properties:', e.message); return []; }),
    ]);

    // First entry in the list is the configured default (COUNTRY_CODE on
    // api.setting — server already sorted it that way). Preselect it.
    this._rasterCountries = countries;
    const countrySel = document.getElementById('raster-country');
    countrySel.innerHTML = `<option value="">${t('a.select')}</option>` +
      countries.map(c => `<option value="${c.country_id}">${this.escapeHtml(c.en)} (${c.country_id})</option>`).join('');
    if (countries.length > 0) countrySel.value = countries[0].country_id;

    this._rasterProjects = projects;
    this._renderRasterProjectOptions();

    // Cache the property list for name lookups (used when building title/abstract).
    this._rasterPropertyNums = properties;
    const propSel = document.getElementById('raster-property-num');
    this._renderRasterPropertyOptions();

    // Recompute filename preview on every input/change of any field.
    const refresh = () => this._updateRasterFilenamePreview();

    // When property changes, fetch its valid units (clears unit) and refresh limits.
    propSel.addEventListener('change', async () => {
      const isNew = propSel.value === '__new__';
      document.getElementById('raster-property-new').style.display = isNew ? '' : 'none';
      if (isNew) {
        // Suggest the next free MAP#### id so the user doesn't have to
        // think one up; they can still type their own.
        const idInput = document.getElementById('raster-new-property-id');
        if (!idInput.value) idInput.value = this._nextRasterMapPropertyId();
        return;  // no units/limits to load yet
      }
      await this._loadRasterUnitsForCurrentProperty();
      this._refreshRasterLimits();
    });
    document.getElementById('raster-add-property-btn')
      .addEventListener('click', () => this.rasterAddMappedProperty());
    // When unit changes, refresh observation_num limits.
    document.getElementById('raster-unit').addEventListener('change', () => this._refreshRasterLimits());

    // Auto-inspect on file pick so the metadata is shown immediately and
    // the no-NoData / stats-in-range rules can fire. Also check up-front
    // that the file isn't already registered — saves the user from filling
    // the whole form only to hit the unique constraint on Upload.
    document.getElementById('raster-file-input').addEventListener('change', async () => {
      this._rasterInspectMeta = null;
      const f = document.getElementById('raster-file-input').files[0];
      const status = document.getElementById('raster-status');
      if (!f) return;
      try {
        const r = await api.rasterFileExists(f.name);
        if (r.exists) {
          status.innerHTML =
            `<span style="color:#c0392b;font-weight:bold;">This file has already been uploaded (layer: ${this.escapeHtml(r.layer_id)}).</span>`;
          document.getElementById('raster-file-input').value = '';
          return;
        }
      } catch (e) { /* network blip — fall through to inspect */ }
      this.rasterInspect();
    });

    ['raster-country','raster-project','raster-property-num','raster-unit','raster-publication-date',
     'raster-time-period-begin','raster-time-period-end',
     'raster-depth-upper','raster-depth-lower','raster-stats','raster-license']
      .forEach(id => {
        const el = document.getElementById(id);
        el.addEventListener('input', refresh);
        el.addEventListener('change', refresh);
      });

    // Date fields: accept forgiving input, but normalise ONLY on blur —
    // turn `/` into `-` and zero-pad single-digit month/day (`2025/10/5` →
    // `2025-10-05`). Normalising on every keystroke re-padded a single-digit
    // day to two digits mid-typing; with maxlength=10 that left no room for
    // the second digit, so typing `2000-01-11` got stuck at `2000-01-01`.
    const normaliseDate = (el) => {
      let v = el.value;
      if (v.includes('/')) v = v.replace(/\//g, '-');
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v.trim());
      if (m) v = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      if (v !== el.value) el.value = v;
    };
    ['raster-publication-date','raster-time-period-begin','raster-time-period-end']
      .forEach(id => {
        const el = document.getElementById(id);
        el.addEventListener('input', () => { refresh(); });
        el.addEventListener('blur',  () => { normaliseDate(el); refresh(); });
      });

    document.getElementById('raster-register-btn').addEventListener('click', () => this.rasterRegister());
    document.getElementById('raster-clear-btn').addEventListener('click', () => this.rasterClear());
  }

  rasterClear() {
    const ids = ['raster-file-input','raster-publication-date',
                 'raster-time-period-begin','raster-time-period-end',
                 'raster-depth-upper','raster-depth-lower'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

    // Selects: reset to the first option (-- Select --) except Country, which
    // keeps the configured default (first entry).
    document.getElementById('raster-project').value = '';
    document.getElementById('raster-property-num').value = '';
    document.getElementById('raster-stats').value = '';
    document.getElementById('raster-license').value = '';
    const countrySel = document.getElementById('raster-country');
    if (countrySel.options.length > 1) countrySel.selectedIndex = 1;
    // Unit dropdown depends on property — reset its placeholder.
    document.getElementById('raster-unit').innerHTML =
      `<option value="">${t('a.pickPropertyFirst')}</option>`;

    document.getElementById('raster-publish').checked = true;
    this._rasterInspectMeta = null;
    this._rasterLimits = null;
    document.getElementById('raster-status').textContent = '';
    const out = document.getElementById('raster-inspect-output');
    out.style.display = 'none'; out.textContent = '';
    this._updateRasterFilenamePreview();
  }

  _renderRasterProjectOptions(selectId) {
    const sel = document.getElementById('raster-project');
    const current = selectId || sel.value;
    sel.innerHTML = `<option value="">${t('a.select')}</option>`
      + (this._rasterProjects || []).map(p =>
          `<option value="${p.project_id}" data-country="${p.country_id}">${this.escapeHtml(p.project_id)}</option>`
        ).join('');
    if (current) sel.value = current;
  }

  _renderRasterPropertyOptions(selectId) {
    const sel = document.getElementById('raster-property-num');
    const current = selectId || sel.value;
    sel.innerHTML = `<option value="">${t('a.select')}</option>`
      + (this._rasterPropertyNums || []).map(p =>
          `<option value="${p.mapped_property_id}">${this.escapeHtml(p.name)} (${p.mapped_property_id})</option>`
        ).join('')
      + '<option value="__new__">+ Add new mapped soil property…</option>';
    if (current) sel.value = current;
  }

  // Suggest the next free MAP#### id from the cached catalogue. Scans
  // existing mapped_property_id values matching MAP<digits>, picks max+1
  // (zero-padded to 4 digits), MAP0001 if nothing matches yet.
  _nextRasterMapPropertyId() {
    const re = /^MAP(\d+)$/;
    let max = 0;
    for (const p of (this._rasterPropertyNums || [])) {
      const m = re.exec(p.mapped_property_id || '');
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return 'MAP' + String(max + 1).padStart(4, '0');
  }

  // DST "output project" dropdown — same catalogue as the Upload GeoTIFF
  // form's Project picker. New projects are created against the configured
  // COUNTRY_CODE country (first entry in this._rasterCountries).
  _dstRenderOutputProjectOptions(selectId) {
    const sel = document.getElementById('dst-output-project');
    if (!sel) return;
    const current = selectId || sel.value || 'DST';
    const projs = this._rasterProjects || [];
    sel.innerHTML = projs.map(p =>
        `<option value="${p.project_id}" data-country="${p.country_id}">${this.escapeHtml(p.project_id)}</option>`
      ).join('')
      + '<option value="__new__">+ Add new project…</option>';
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
  }

  async dstAddOutputProject() {
    const status = document.getElementById('dst-new-output-project-status');
    const country = (this._rasterCountries && this._rasterCountries[0])
                      ? this._rasterCountries[0].country_id : null;
    const pid = document.getElementById('dst-new-output-project-id').value.trim().toUpperCase();
    const pname = document.getElementById('dst-new-output-project-name').value.trim();
    const descr = document.getElementById('dst-new-output-project-description').value.trim();
    if (!country) { status.textContent = t('a.countryCodeMissing'); return; }
    if (!pid)     { status.textContent = t('a.projIdRequired');  return; }
    if (!/^[A-Z0-9_]+$/.test(pid)) {
      status.textContent = t('a.projIdCaps'); return;
    }
    status.textContent = t('a.st.adding');
    try {
      await api.createRasterProject({
        country_id: country, project_id: pid,
        project_name: pname || pid, description: descr || null,
      });
      this._rasterProjects = await api.listRasterProjects();
      this._dstRenderOutputProjectOptions(pid);
      document.getElementById('dst-output-project').value = pid;
      document.getElementById('dst-output-project-new').style.display = 'none';
      document.getElementById('dst-new-output-project-id').value = '';
      document.getElementById('dst-new-output-project-name').value = '';
      document.getElementById('dst-new-output-project-description').value = '';
      status.textContent = '';
      // Keep the Upload GeoTIFF dropdown in sync too if it's already rendered.
      if (document.getElementById('raster-project')) {
        this._renderRasterProjectOptions();
      }
    } catch (e) { status.textContent = t('a.err.addFailed') + e.message; }
  }

  // DST "output property" dropdown — same catalogue as the Upload GeoTIFF
  // form's "Mapped soil property" picker.
  _dstRenderOutputPropertyOptions(selectId) {
    const sel = document.getElementById('dst-output-property');
    if (!sel) return;
    const current = selectId || sel.value || 'SUITABILITY';
    const props = this._rasterPropertyNums || [];
    sel.innerHTML = props.map(p =>
        `<option value="${p.mapped_property_id}">${this.escapeHtml(p.name)} (${p.mapped_property_id})</option>`
      ).join('')
      + '<option value="__new__">+ Add new mapped soil property…</option>';
    // Preselect current if present; otherwise leave the first option selected
    // (no "SUITABILITY" fallback option — that lived in the static HTML only).
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
  }

  async dstAddOutputProperty() {
    const status = document.getElementById('dst-new-output-property-status');
    const pid = document.getElementById('dst-new-output-property-id').value.trim().toUpperCase();
    const pname = document.getElementById('dst-new-output-property-name').value.trim();
    if (!pid)   { status.textContent = t('a.idRequired'); return; }
    if (!/^[A-Z0-9_]+$/.test(pid)) {
      status.textContent = t('a.idCaps'); return;
    }
    if (!pname) { status.textContent = t('a.nameRequired'); return; }
    const property_type =
      document.getElementById('dst-new-output-property-type').value || 'quantitative';
    status.textContent = t('a.st.adding');
    try {
      // DST outputs don't have an inspected raster yet — min/max stay NULL.
      // Override the catalogue's default soil ramp with a distinct green (low)
      // → red (high) ramp for DST-minted properties, so DST results read as a
      // suitability/score scale rather than the usual soil-property browns.
      await api.createRasterMappedSoilProperty({
        mapped_property_id: pid, name: pname, property_type,
        start_color: '#1a9850',  // green (low)
        end_color:   '#d7191c',  // red (high)
      });
      this._rasterPropertyNums = await api.listRasterMappedSoilProperties();
      this._dstRenderOutputPropertyOptions(pid);
      document.getElementById('dst-output-property-new').style.display = 'none';
      document.getElementById('dst-new-output-property-id').value = '';
      document.getElementById('dst-new-output-property-name').value = '';
      // Mirror the new mapped_property's display name into the recipe Name.
      status.textContent = '';
      // Keep the Upload GeoTIFF dropdown in sync too if it's already been
      // rendered (it shares the cache).
      if (document.getElementById('raster-property-num')) {
        this._renderRasterPropertyOptions();
      }
    } catch (e) { status.textContent = t('a.err.addFailed') + e.message; }
  }

  async rasterAddMappedProperty() {
    const status = document.getElementById('raster-new-property-status');
    const pid = document.getElementById('raster-new-property-id').value.trim().toUpperCase();
    const pname = document.getElementById('raster-new-property-name').value.trim();
    if (!pid)   { status.textContent = t('a.idRequired'); return; }
    if (!/^[A-Z0-9_]+$/.test(pid)) {
      status.textContent = t('a.idCaps'); return;
    }
    if (!pname) { status.textContent = t('a.nameRequired'); return; }
    // Pull stats min/max from the auto-inspect result (band 0). When the
    // user adds a property before picking a file we have nothing — those
    // stay NULL on the catalogue row.
    const band0 = (this._rasterInspectMeta && this._rasterInspectMeta.bands && this._rasterInspectMeta.bands[0]) || null;
    const min = band0 && band0.stats_minimum != null ? band0.stats_minimum : null;
    const max = band0 && band0.stats_maximum != null ? band0.stats_maximum : null;
    const property_type = document.getElementById('raster-new-property-type').value || 'quantitative';
    status.textContent = t('a.st.adding');
    try {
      await api.createRasterMappedSoilProperty({
        mapped_property_id: pid, name: pname, min, max, property_type,
      });
      this._rasterPropertyNums = await api.listRasterMappedSoilProperties();
      this._renderRasterPropertyOptions(pid);
      document.getElementById('raster-property-new').style.display = 'none';
      document.getElementById('raster-new-property-id').value = '';
      document.getElementById('raster-new-property-name').value = '';
      status.textContent = '';
      // Mirror the existing change handler: load units & limits for the
      // freshly added property (it'll have no units yet — that's fine).
      await this._loadRasterUnitsForCurrentProperty();
      this._refreshRasterLimits();
      this._updateRasterFilenamePreview();
    } catch (e) { status.textContent = t('a.err.addFailed') + e.message; }
  }

  async _loadRasterUnitsForCurrentProperty() {
    const propId = document.getElementById('raster-property-num').value;
    const unitSel = document.getElementById('raster-unit');
    this._rasterLimits = null;          // invalidate cached limits
    if (!propId) {
      unitSel.innerHTML = `<option value="">${t('a.pickPropertyFirst')}</option>`;
      return;
    }
    unitSel.innerHTML = `<option value="">${t('a.loading')}</option>`;
    try {
      const units = await api.listRasterUnitsForProperty(propId);
      if (!units.length) {
        unitSel.innerHTML = `<option value="">${t('a.noUnits')}</option>`;
        return;
      }
      unitSel.innerHTML = `<option value="">${t('a.select')}</option>` +
        units.map(u => `<option value="${u.unit_of_measure_id}">${this.escapeHtml(u.unit_of_measure_id)}</option>`).join('');
    } catch (e) {
      unitSel.innerHTML = `<option value="">(error: ${this.escapeHtml(e.message)})</option>`;
    }
  }

  async _refreshRasterLimits() {
    const propId = document.getElementById('raster-property-num').value;
    const unitId = document.getElementById('raster-unit').value;
    if (!propId || !unitId) { this._rasterLimits = null; }
    else {
      try {
        this._rasterLimits = await api.getRasterObservationLimits(propId, unitId);
      } catch (e) {
        console.warn('observation_limits:', e.message);
        this._rasterLimits = null;
      }
    }
    this._updateRasterFilenamePreview();
    this._renderRasterInspectOutput();
  }

  // Parse YYYY-M-D (any 1-2 digit month/day) → {iso: 'YYYY-MM-DD', yyyy} or null.
  // Forgives missing zero-pad so the missing-fields check passes before
  // the input has blurred.
  _parseRasterDate(raw) {
    const s = (raw || '').trim();
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (!m) return null;
    const [, yyyy, mmRaw, ddRaw] = m;
    const mm = mmRaw.padStart(2, '0');
    const dd = ddRaw.padStart(2, '0');
    const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
    if (isNaN(d.getTime())
        || d.getUTCFullYear() !== Number(yyyy)
        || (d.getUTCMonth() + 1) !== Number(mm)
        || d.getUTCDate() !== Number(dd)) return null;
    return { iso: `${yyyy}-${mm}-${dd}`, yyyy };
  }

  // Returns the layer_id (no extension) when every field is filled, or
  // a { missing: [...] } object listing only the empty fields.
  _rasterFormState() {
    const country = document.getElementById('raster-country').value.trim();
    const projSel = document.getElementById('raster-project');
    const project = (projSel.value && projSel.value !== '__new__') ? projSel.value : '';
    const prop    = document.getElementById('raster-property-num').value.trim();
    const unit    = document.getElementById('raster-unit').value.trim();
    const dateRaw = document.getElementById('raster-publication-date').value;
    const date    = this._parseRasterDate(dateRaw);
    const begRaw  = document.getElementById('raster-time-period-begin').value;
    const begin   = this._parseRasterDate(begRaw);
    const endRaw  = document.getElementById('raster-time-period-end').value;
    const end     = this._parseRasterDate(endRaw);
    const upper   = document.getElementById('raster-depth-upper').value.trim();
    const lower   = document.getElementById('raster-depth-lower').value.trim();
    const stats   = document.getElementById('raster-stats').value.trim();
    const license = document.getElementById('raster-license').value.trim();
    const today   = new Date().toISOString().slice(0, 10);

    const missing = [];
    const rules = [];
    if (!country) missing.push('country');
    if (!project) missing.push('project');
    if (!prop)    missing.push('property');
    if (!unit)    missing.push('unit');
    if (!date)    missing.push('created on (YYYY-MM-DD)');
    if (!begin)   missing.push('period start (YYYY-MM-DD)');
    if (!end)     missing.push('period end (YYYY-MM-DD)');
    if (begin && end && begin.iso >= end.iso) {
      rules.push('period start must be earlier than period end');
    }
    if (date && end && date.iso <= end.iso) {
      rules.push('created on must be later than period end');
    }
    if (date && date.iso > today) {
      rules.push('created on cannot be in the future');
    }
    if (!upper && upper !== '0') missing.push('upper depth');
    if (!lower && lower !== '0') missing.push('lower depth');
    if ((upper !== '' || upper === '0') && (lower !== '' || lower === '0')
        && Number(upper) >= Number(lower)) {
      rules.push('upper depth must be less than lower depth');
    }
    if (!stats)   missing.push('stats');
    if (!license) missing.push('licence');

    // upper depth ≥ 0 — combined with `upper < lower` (above), this also
    // forces lower > 0, so no separate lower-depth rule is needed.
    if (upper !== '' && Number(upper) < 0) rules.push('upper depth must be ≥ 0');

    // Rules that depend on the Inspect result.
    const meta = this._rasterInspectMeta;
    const band = meta && meta.bands && meta.bands[0];
    if (meta && (band == null || band.no_data_value == null)) {
      rules.push('raster has no NoData value defined');
    }
    if (meta && band && this._rasterLimits
        && this._rasterLimits.value_min != null
        && this._rasterLimits.value_max != null) {
      const span = this._rasterLimits.value_max - this._rasterLimits.value_min;
      const tol = 0.1 * span;
      const lo = this._rasterLimits.value_min - tol;
      const hi = this._rasterLimits.value_max + tol;
      if (band.stats_minimum != null && band.stats_minimum < lo) {
        rules.push(`stats_minimum ${band.stats_minimum} < allowed ${lo.toFixed(4)} (${this._rasterLimits.value_min}±10%)`);
      }
      if (band.stats_maximum != null && band.stats_maximum > hi) {
        rules.push(`stats_maximum ${band.stats_maximum} > allowed ${hi.toFixed(4)} (${this._rasterLimits.value_max}±10%)`);
      }
    }
    return {
      country, project, prop, unit, upper, lower, stats,
      date_iso: date ? date.iso : '',
      yyyy: date ? date.yyyy : '',
      time_period_begin: begin ? begin.iso : '',
      time_period_end: end ? end.iso : '',
      missing,
      rules,
    };
  }

  // Plain-text formatter (used by error toasts etc. that already style themselves).
  _formatRasterIssues(s) {
    const parts = [];
    if (s.missing.length) parts.push(`Missing: ${s.missing.join(', ')}.`);
    if (s.rules.length)   parts.push(`Rule: ${s.rules.join(', ')}.`);
    return parts.join(' ');
  }

  // HTML formatter — broken rules / missing fields rendered bold red.
  _formatRasterIssuesHtml(s) {
    const e = this.escapeHtml.bind(this);
    const parts = [];
    if (s.missing.length) {
      parts.push(`<span style="color:#c0392b;font-weight:bold;">Missing: ${e(s.missing.join(', '))}.</span>`);
    }
    if (s.rules.length) {
      parts.push(`<span style="color:#c0392b;font-weight:bold;">Rule: ${e(s.rules.join(', '))}.</span>`);
    }
    return parts.join(' ');
  }

  _updateRasterFilenamePreview() {
    const s = this._rasterFormState();
    if (s.missing.length === 0 && s.rules.length === 0) {
      const layerId = [s.country, s.project, s.prop, s.yyyy, s.upper, s.lower, s.stats].join('-');
      document.getElementById('raster-filename-preview').textContent = `${layerId}.tif`;
      return layerId;
    }
    document.getElementById('raster-filename-preview').innerHTML = this._formatRasterIssuesHtml(s);
    return null;
  }

  async rasterInspect() {
    const f = document.getElementById('raster-file-input').files[0];
    const status = document.getElementById('raster-status');
    const out = document.getElementById('raster-inspect-output');
    if (!f) { status.textContent = t('a.chooseFile'); return; }
    status.textContent = t('a.st.inspecting');
    try {
      const meta = await api.inspectRaster(f);
      this._rasterInspectMeta = meta;
      out.style.display = 'block';
      this._renderRasterInspectOutput();
      status.textContent = t('a.st.inspected');
      this._updateRasterFilenamePreview();
    } catch (e) {
      this._rasterInspectMeta = null;
      status.textContent = t('a.err.inspectFailed') + e.message;
    }
  }

  // Render the inspect JSON to the <pre>, wrapping the lines that violate
  // a rule in a bold-red span (no_data_value=null, stats_min/max out of
  // allowed range).
  _renderRasterInspectOutput() {
    const out = document.getElementById('raster-inspect-output');
    const meta = this._rasterInspectMeta;
    if (!meta) { out.style.display = 'none'; out.innerHTML = ''; return; }

    const band = meta.bands && meta.bands[0];
    const noDataBad = !!band && band.no_data_value == null;

    let minBad = false, maxBad = false;
    const lim = this._rasterLimits;
    if (band && lim && lim.value_min != null && lim.value_max != null) {
      const tol = 0.1 * (lim.value_max - lim.value_min);
      const lo = lim.value_min - tol, hi = lim.value_max + tol;
      if (band.stats_minimum != null && band.stats_minimum < lo) minBad = true;
      if (band.stats_maximum != null && band.stats_maximum > hi) maxBad = true;
    }

    const e = this.escapeHtml.bind(this);
    const lines = JSON.stringify(meta, null, 2).split('\n');
    const flag = (line) =>
      `<span style="color:#c0392b;font-weight:bold;">${e(line)}</span>`;

    out.style.display = 'block';
    out.innerHTML = lines.map(line => {
      const trimmed = line.trimStart();
      if (noDataBad && trimmed.startsWith('"no_data_value":')) return flag(line);
      if (minBad    && trimmed.startsWith('"stats_minimum":')) return flag(line);
      if (maxBad    && trimmed.startsWith('"stats_maximum":')) return flag(line);
      return e(line);
    }).join('\n');
  }

  async rasterRegister() {
    const f = document.getElementById('raster-file-input').files[0];
    const status = document.getElementById('raster-status');
    if (!f) { status.textContent = t('a.chooseFile'); return; }

    // Auto-inspect so the no-NoData / stats-in-range rules can fire even
    // if the user didn't click Inspect.
    if (!this._rasterInspectMeta) {
      status.textContent = t('a.st.inspecting2');
      await this.rasterInspect();
      if (!this._rasterInspectMeta) return;   // inspect failed → status already set
    }
    if (!this._rasterLimits) await this._refreshRasterLimits();

    const s = this._rasterFormState();
    if (s.missing.length > 0 || s.rules.length > 0) {
      // The Generated filename row already lists the issues — don't duplicate
      // them here. A short pointer is enough.
      status.innerHTML = `<span style="color:#c0392b;font-weight:bold;">${t('a.fixIssues')}</span>`;
      return;
    }
    const layerId = [s.country, s.project, s.prop, s.yyyy, s.upper, s.lower, s.stats].join('-');
    document.getElementById('raster-filename-preview').textContent = `${layerId}.tif`;

    status.textContent = t('a.st.registering');
    try {
      const projSel = document.getElementById('raster-project');
      // Look up labels for the title / abstract templates.
      const propRow = (this._rasterPropertyNums || []).find(p => p.mapped_property_id === s.prop);
      const propName = propRow ? propRow.name : s.prop;
      const projRow = (this._rasterProjects || []).find(p => p.project_id === s.project);

      // title : "<property_name> (<YYYY>)"  — also stored on layer.costum_name.
      // Project goes to mapset.costum_group via the registrar.
      const title = `${propName} (${s.yyyy})`;
      // abstract: "<title> in <unit>.\n\n<project.description>"
      const descr = projRow && projRow.description ? projRow.description : '';
      const abstract = `${title} in ${s.unit}.` + (descr ? `\n\n${descr}` : '');

      const fields = {
        title,
        abstract,
        project_name: projSel.value !== '__new__' ? projSel.value : '',
        property_num_id: document.getElementById('raster-property-num').value,
        unit_of_measure_id: s.unit,
        file_orig_name: f.name,
        publication_date: s.date_iso,
        time_period_begin: s.time_period_begin,
        time_period_end: s.time_period_end,
        license: document.getElementById('raster-license').value,
        publish: document.getElementById('raster-publish').checked ? 'true' : 'false',
      };
      // Rename via FormData filename arg — avoids constructing a new File()
      // for large blobs (which can cause Firefox "NetworkError" on upload).
      const res = await api.registerRaster(f, fields, `${layerId}.tif`);
      status.textContent = t('a.raster.registered', {name: res.layer_id}) +
        (res.warnings && res.warnings.length ? t('a.raster.warnings', {n: res.warnings.length}) : '');
      document.getElementById('raster-inspect-output').style.display = 'block';
      document.getElementById('raster-inspect-output').textContent = JSON.stringify(res, null, 2);
      // Refresh the rasters list table now that a new layer exists.
      if (typeof this.loadLayers === 'function') {
        await this.loadLayers();
        if (typeof this.renderLayers === 'function') this.renderLayers();
      }
    } catch (e) {
      status.textContent = t('a.err.registerFailed') + e.message;
    }
  }

  // ==================== DST ====================

  async initDstTab() {
    // "+ New Recipe" doubles as "Close" while a NEW (unsaved) editor is open.
    // If a different (existing) recipe editor is open, persist+close it
    // first, then start a fresh one.
    document.getElementById('dst-new-btn').addEventListener('click', async () => {
      const wasNew = this._dstOpenRecipeId === '__new__';
      if (this._dstOpenRecipeId) await this.dstCloseEditor();  // save + hide whatever's open
      if (!wasNew) this.dstNewRecipe();
    });
    document.getElementById('dst-add-row-btn').addEventListener('click', () => this.dstAddRow());
    // Editor Run — persists the editor (create new / update / rename) then
    // runs. This is the only Run affordance for an unsaved new recipe.
    document.getElementById('dst-run-btn').addEventListener('click', () => this.dstRun());

    // Output project + property dropdowns — same catalogues + same "+ Add new"
    // flows as the Upload GeoTIFF form so the user picks from soil_data.project
    // / soil_data.mapped_property.
    try {
      [this._rasterPropertyNums, this._rasterProjects, this._rasterCountries] = await Promise.all([
        api.listRasterMappedSoilProperties(),
        api.listRasterProjects(),
        api.listRasterCountries(),
      ]);
    } catch (e) {
      this._rasterPropertyNums = this._rasterPropertyNums || [];
      this._rasterProjects = this._rasterProjects || [];
      this._rasterCountries = this._rasterCountries || [];
      console.warn('dst catalogues:', e.message);
    }
    this._dstRenderOutputProjectOptions();
    this._dstRenderOutputPropertyOptions();
    const outProjSel = document.getElementById('dst-output-project');
    outProjSel.addEventListener('change', () => {
      document.getElementById('dst-output-project-new').style.display =
        outProjSel.value === '__new__' ? '' : 'none';
    });
    document.getElementById('dst-add-output-project-btn')
      .addEventListener('click', () => this.dstAddOutputProject());
    const outPropSel = document.getElementById('dst-output-property');
    outPropSel.addEventListener('change', () => {
      const isNew = outPropSel.value === '__new__';
      document.getElementById('dst-output-property-new').style.display = isNew ? '' : 'none';
      if (isNew) {
        const idInput = document.getElementById('dst-new-output-property-id');
        if (!idInput.value) idInput.value = this._nextRasterMapPropertyId();
        return;
      }
      // Mirror the picked mapped_property's display name into the recipe
      // Name field — the user can still edit it after.
      this._dstRefreshRecipeId();
    });
    // Project change also refreshes the recipe_id prefix.
    document.getElementById('dst-output-project').addEventListener('change',
      () => this._dstRefreshRecipeId());
    document.getElementById('dst-add-output-property-btn')
      .addEventListener('click', () => this.dstAddOutputProperty());
    // Preload available input rasters so the row builder's dropdowns can be
    // filled instantly when the user adds the first row.
    try {
      this._dstInputs = await api.listDstInputs();
    } catch (e) {
      this._dstInputs = [];
      console.warn('dst inputs:', e.message);
    }
    await this.dstReloadRecipes();
  }

  async dstReloadRecipes() {
    const tb = document.getElementById('dst-recipes-tbody');
    try {
      const recipes = await api.listDstRecipes();
      if (!recipes.length) {
        tb.innerHTML = `<tr><td colspan="5" class="empty-state">${t('a.dst.noRecipes')}</td></tr>`;
        return;
      }
      // Stable order by Raster ID — the API sorts by updated_at, which would
      // reshuffle the list every time a recipe is opened/saved.
      recipes.sort((a, b) =>
        String(a.recipe_id).localeCompare(String(b.recipe_id)));
      const fmtDate = (s) => s ? String(s).replace('T', ' ').slice(0, 16) : '';
      tb.innerHTML = recipes.map(r => {
        const lr = r.latest_run;
        const status = lr ? this.escapeHtml(lr.status || '') : '—';
        const started = lr ? this.escapeHtml(fmtDate(lr.started_at)) : '—';
        const rid = this.escapeHtml(r.recipe_id);
        // The Open button doubles as Close while this recipe's editor is open.
        const isOpen = this._dstOpenRecipeId === r.recipe_id;
        const openLabel = isOpen ? t('a.close') : t('a.etl.open');
        return `
        <tr>
          <td>${rid}</td>
          <td>${this.escapeHtml(r.name || '')}</td>
          <td>${status}</td>
          <td>${started}</td>
          <td style="white-space:nowrap;">
            <button type="button" class="btn btn-sm btn-primary dst-row-open" data-recipe="${rid}">${openLabel}</button>
            ${this.isAdmin ? `<button type="button" class="btn btn-sm dst-row-del"  data-recipe="${rid}" style="background:#dc3545;color:#fff;margin-left:4px;">${t('a.delete')}</button>` : ''}
          </td>
        </tr>`;
      }).join('');
      tb.querySelectorAll('.dst-row-open').forEach(b =>
        b.addEventListener('click', async () => {
          const id = b.dataset.recipe;
          if (this._dstOpenRecipeId === id) {
            await this.dstCloseEditor();            // saves + hides + reloads
          } else {
            // Persist whatever editor is currently open before switching.
            if (this._dstOpenRecipeId) {
              try { await this._dstPersistEditor(); } catch (e) { /* incomplete → skip */ }
            }
            await this.dstLoadRecipe(id);           // sets _dstOpenRecipeId
            await this.dstReloadRecipes();          // re-render so it shows Close
          }
        }));
      tb.querySelectorAll('.dst-row-del').forEach(b =>
        b.addEventListener('click', () => this.dstDeleteRecipeById(b.dataset.recipe)));
    } catch (e) {
      tb.innerHTML = `<tr><td colspan="5">${this.escapeHtml(e.message)}</td></tr>`;
    }
  }


  dstNewRecipe() {
    document.getElementById('dst-editor-wrap').style.display = '';
    document.getElementById('dst-editor').style.display = 'block';
    document.getElementById('dst-editor-id').textContent = t('a.dst.newTag');
    document.getElementById('dst-recipe-id').value = '';
    document.getElementById('dst-recipe-id').disabled = false;
    this._dstLoadedRecipeId = null;
    this._dstOpenRecipeId = '__new__';
    this._dstSyncNewButton();
    this._dstSetDescription('', /*resetAuto=*/true);
    this._dstLastAutoDesc = '';
    this._dstRenderOutputProjectOptions('DST');
    document.getElementById('dst-output-project-new').style.display = 'none';
    this._dstRenderOutputPropertyOptions('SUITABILITY');
    document.getElementById('dst-output-property-new').style.display = 'none';
    // Prime recipe_id with the <CC>-<PROJ>-<PROP>- prefix.
    document.getElementById('dst-recipe-id').value = '';
    this._dstRefreshRecipeId();
    // Wipe rows back to the empty state.
    document.getElementById('dst-rows-tbody').innerHTML =
      `<tr><td colspan="7" class="empty-state">${t('a.dst.noInputs')}</td></tr>`;
    document.getElementById('dst-status').textContent = '';
  }

  // Recipe ID = output layer_id. The prefix is rebuilt from the
  // COUNTRY_CODE country + selected Project + selected Mapped property;
  // the user appends the tail. Empty input → just the prefix.
  _dstBuildRecipeIdPrefix() {
    const country = (this._rasterCountries && this._rasterCountries[0])
      ? this._rasterCountries[0].country_id : 'BT';
    const proj = document.getElementById('dst-output-project').value || 'DST';
    const prop = document.getElementById('dst-output-property').value || 'SUITABILITY';
    return `${country}-${proj}-${prop}-`;
  }

  // recipe_id IS the output layer_id and follows the standard SIS
  // convention: <CC>-<PROJ>-<PROP>-<YEAR>-<upper>-<lower>-MEAN.
  //   * Year   = current year
  //   * Depth  = MIN(upper) / MAX(lower) across the picked input layers'
  //              dimension_depth (e.g. inputs 0-30 + 45-80 → 0-80)
  //   * Stats  = always MEAN for DST outputs.
  _dstRefreshRecipeId() {
    const idEl = document.getElementById('dst-recipe-id');
    if (!idEl) return;
    const country = (this._rasterCountries && this._rasterCountries[0])
      ? this._rasterCountries[0].country_id : 'BT';
    const proj = document.getElementById('dst-output-project').value || 'DST';
    const prop = document.getElementById('dst-output-property').value || 'SUITABILITY';
    const year = new Date().getFullYear();

    const inputs = this._dstInputs || [];
    let uppers = [], lowers = [];
    document.querySelectorAll('tr.dst-row .dst-row-layer').forEach(sel => {
      const layerId = sel.value;
      if (!layerId) return;
      const ipt = inputs.find(i => i.layer_id === layerId);
      const depth = ipt && ipt.dimension_depth;
      const m = /^(\d+)-(\d+)$/.exec(depth || '');
      if (m) { uppers.push(+m[1]); lowers.push(+m[2]); }
    });
    const upper = uppers.length ? Math.min(...uppers) : 0;
    const lower = lowers.length ? Math.max(...lowers) : 0;

    const prev = idEl.value;
    idEl.value = `${country}-${proj}-${prop}-${year}-${upper}-${lower}-MEAN`;
    // The output layer is excluded from the row dropdowns; if it changed,
    // refresh them. Guard against recursion (rebuild doesn't call this).
    if (prev !== idEl.value) this._dstRebuildRowLayerOptions();
  }

  // Programmatically set the description and remember the auto-generated
  // string so we can detect whether the user has customised it on the
  // next refresh.
  _dstSetDescription(text, resetAuto) {
    const el = document.getElementById('dst-recipe-description');
    el.value = text;
    this._dstLastAutoDesc = text;
    if (resetAuto) this._dstLastAutoDesc = text;  // keep symmetry
  }

  // Build a plain-text summary of the current recipe shape, e.g.
  //   sum of:
  //   - BT-GSNM-PHX-2024-0-30-MEAN: reclass to 1 when value ≥ 6.5, else 0
  //   - BT-GSNM-NTOT-2024-0-30-MEAN: reclass to 1 when value ≥ 0.2, else 0
  _dstAutoDescription() {
    const tbody = document.getElementById('dst-rows-tbody');
    const rows = Array.from(tbody.querySelectorAll('tr.dst-row'));
    if (!rows.length) return '';
    const lines = [`sum of the following:`];
    rows.forEach(tr => {
      const layerSel = tr.querySelector('.dst-row-layer');
      const layer = layerSel.value || '(no layer)';
      const threshold = tr.querySelector('.dst-row-threshold-val').value || tr.querySelector('.dst-row-threshold').value;
      const below = tr.querySelector('.dst-row-below').value;
      const above = tr.querySelector('.dst-row-above').value;
      const thrStr = threshold === '' || threshold == null ? '<threshold>' : threshold;
      const belowStr = below === '' ? '0' : below;
      const aboveStr = above === '' ? '1' : above;
      lines.push(
        `- ${layer}: reclass to ${aboveStr} when value ≥ ${thrStr}, else ${belowStr}`
      );
    });
    return lines.join('\n');
  }

  _dstRefreshAutoDescription() {
    const el = document.getElementById('dst-recipe-description');
    // Only auto-fill when the field is empty or still equals the last
    // generated string — i.e. the user hasn't typed anything custom.
    if (el.value && el.value !== this._dstLastAutoDesc) return;
    this._dstSetDescription(this._dstAutoDescription(), false);
  }

  async dstLoadRecipe(id) {
    try {
      const r = await api.getDstRecipe(id);
      document.getElementById('dst-editor-wrap').style.display = '';
      document.getElementById('dst-editor').style.display = 'block';
      document.getElementById('dst-editor-id').textContent = id;
      document.getElementById('dst-recipe-id').value = r.recipe_id;
      // recipe_id is now auto-computed from the dropdowns + depth — keep it
      // editable so changing Mapped property / Project actually refreshes
      // it. We remember the loaded id separately to detect renames on Save.
      document.getElementById('dst-recipe-id').disabled = false;
      this._dstLoadedRecipeId = r.recipe_id;
      this._dstOpenRecipeId = r.recipe_id;
      this._dstSyncNewButton();
      // Prime _dstLastAutoDesc with the saved description so the next
      // refresh sees the textarea value == _dstLastAutoDesc and re-runs
      // the auto-generator. (Setting it to '' here would leave any saved
      // description frozen as "user-customised".)
      const recipe = r.recipe || {};
      this._dstSetDescription(r.description || '', false);
      this._dstLastAutoDesc = r.description || '';
      const md = recipe.metadata || {};
      this._dstRenderOutputProjectOptions(md.spatial_metadata_project_id || 'DST');
      document.getElementById('dst-output-project-new').style.display = 'none';
      this._dstRenderOutputPropertyOptions(md.spatial_metadata_property_id || 'SUITABILITY');
      document.getElementById('dst-output-property-new').style.display = 'none';
      this._dstPopulateRows(recipe.steps || []);
      document.getElementById('dst-status').textContent = '';
      } catch (e) {
      document.getElementById('dst-status').textContent = e.message;
    }
  }

  // Build a single <tr> for the row builder. The threshold splits the
  // layer: pixels >= threshold get `above`, pixels < threshold get `below`.
  // This maps to the engine's op:">=", true_score=above, false_score=below.
  // Build the <option> list for a row's layer dropdown, hiding layers
  // already chosen in OTHER rows and the output layer being produced. The
  // row's own current selection (`ownId`) is always kept so it stays valid.
  _dstLayerOptionsHtml(ownId) {
    const inputs = this._dstInputs || [];
    const outputId = (document.getElementById('dst-recipe-id').value || '').trim();
    const usedElsewhere = new Set(
      Array.from(document.querySelectorAll('tr.dst-row .dst-row-layer'))
        .map(s => s.value)
        .filter(v => v && v !== ownId)
    );
    return ['<option value="">-- pick a layer --</option>'].concat(
      inputs
        .filter(i => i.layer_id === ownId ||
                     (!usedElsewhere.has(i.layer_id) && i.layer_id !== outputId))
        .map(i => {
          const sel = i.layer_id === ownId ? ' selected' : '';
          const label = (i.label && i.label !== i.layer_id)
            ? `${i.layer_id} — ${i.label}`
            : i.layer_id;
          return `<option value="${this.escapeHtml(i.layer_id)}" data-min="${i.stats_minimum ?? ''}" data-max="${i.stats_maximum ?? ''}"${sel}>${this.escapeHtml(label)}</option>`;
        })
    ).join('');
  }

  // Re-render every row's layer dropdown so newly-used layers disappear
  // from the others (and freed ones reappear), preserving each selection.
  _dstRebuildRowLayerOptions() {
    document.querySelectorAll('tr.dst-row .dst-row-layer').forEach(sel => {
      const own = sel.value;
      sel.innerHTML = this._dstLayerOptionsHtml(own);
      if (own) sel.value = own;
    });
  }

  // Apply a layer's Min/Max to a row's threshold slider: set bounds, a fine
  // step, clamp the current value into range (defaulting to the midpoint),
  // and refresh the readout. Called on render and whenever the layer changes.
  _dstApplyThresholdRange(tr, mn, mx, preferredVal) {
    const slider = tr.querySelector('.dst-row-threshold');
    const readout = tr.querySelector('.dst-row-threshold-val');
    const hasRange = (mn != null && mn !== '' && mx != null && mx !== '' && Number(mx) > Number(mn));
    if (!hasRange) {
      slider.min = 0; slider.max = 0; slider.step = 'any';
      slider.value = ''; slider.disabled = true;
      if (readout) { readout.value = ''; readout.disabled = true; readout.removeAttribute('min'); readout.removeAttribute('max'); }
      return;
    }
    const lo = Number(mn), hi = Number(mx);
    slider.disabled = false;
    slider.min = lo; slider.max = hi;
    slider.step = (hi - lo) / 1000 || 'any';
    let v = (preferredVal != null && preferredVal !== '') ? Number(preferredVal)
          : (lo + (hi - lo) / 2);
    if (v < lo) v = lo; if (v > hi) v = hi;
    slider.value = v;
    if (readout) { readout.disabled = false; readout.min = lo; readout.max = hi; readout.value = slider.value; }
  }

  _dstRenderRow(step) {
    const inputs = this._dstInputs || [];
    const layerId = step.layer_id || '';
    const match = inputs.find(i => i.layer_id === layerId);
    const opts = this._dstLayerOptionsHtml(layerId);
    const fmt = (v) => (v == null || v === '') ? '—' : Number(v).toFixed(3);
    const tr = document.createElement('tr');
    tr.className = 'dst-row';
    tr.innerHTML = `
      <td><select class="dst-row-layer" style="min-width:240px;">${opts}</select></td>
      <td class="dst-row-min" style="text-align:right;color:#555;padding-right:6px;">${fmt(match?.stats_minimum)}</td>
      <td class="dst-row-max" style="text-align:right;color:#555;padding-left:6px;padding-right:56px;">${fmt(match?.stats_maximum)}</td>
      <td style="padding-right:6px;"><input type="number" class="dst-row-below no-spinner" step="any" value="${step.false_score ?? 0}" style="width:35px;"></td>
      <td style="padding-left:6px;padding-right:6px;text-align:center;white-space:nowrap;">
        <input type="number" class="dst-row-threshold-val no-spinner" step="any" title="${t('a.dst.thresholdTip')}"
               style="width:74px;color:#444;font-size:var(--fs-sm);font-weight:600;text-align:center;">
        <input type="range" class="dst-row-threshold" style="width:120px;vertical-align:middle;display:block;margin:5px auto 0;">
      </td>
      <td style="padding-left:6px;"><input type="number" class="dst-row-above no-spinner" step="any" value="${step.true_score ?? 1}" style="width:35px;"></td>
      <td><button type="button" class="btn btn-sm dst-row-remove" style="background:#dc3545;color:#fff;" title="${t('a.remove')}">×</button></td>
    `;
    // Initialise the slider bounds from the row's current layer.
    this._dstApplyThresholdRange(tr, match?.stats_minimum, match?.stats_maximum, step.threshold);
    // When the layer changes, refresh the min/max display + slider bounds.
    tr.querySelector('.dst-row-layer').addEventListener('change', (e) => {
      const opt = e.currentTarget.selectedOptions[0];
      const mn = opt?.dataset.min;
      const mx = opt?.dataset.max;
      tr.querySelector('.dst-row-min').textContent = mn ? Number(mn).toFixed(3) : '—';
      tr.querySelector('.dst-row-max').textContent = mx ? Number(mx).toFixed(3) : '—';
      // Re-range the threshold slider to the new layer (default to midpoint).
      this._dstApplyThresholdRange(tr, mn, mx, null);
      this._dstRefreshAutoDescription();
      // Depth aggregate may have changed → rebuild recipe_id/output layer_id.
      this._dstRefreshRecipeId();
      // This layer is now used here → drop it from the other rows' lists.
      this._dstRebuildRowLayerOptions();
    });
    // Slider drag → mirror into the precise number box + refresh description.
    tr.querySelector('.dst-row-threshold').addEventListener('input', (e) => {
      const ro = tr.querySelector('.dst-row-threshold-val');
      if (ro) ro.value = e.currentTarget.value;
      this._dstRefreshAutoDescription();
    });
    // Typing a precise value → clamp the slider to it (the box keeps the exact
    // figure even outside the slider's coarse step granularity).
    tr.querySelector('.dst-row-threshold-val').addEventListener('input', (e) => {
      const slider = tr.querySelector('.dst-row-threshold');
      const raw = e.currentTarget.value;
      if (raw !== '' && !slider.disabled) {
        let n = Number(raw);
        if (Number.isFinite(n)) {
          const lo = Number(slider.min), hi = Number(slider.max);
          if (n < lo) n = lo; if (n > hi) n = hi;
          slider.value = n;
        }
      }
      this._dstRefreshAutoDescription();
    });
    // Below / above edits also refresh the auto-description.
    ['.dst-row-below', '.dst-row-above'].forEach(sel => {
      tr.querySelector(sel).addEventListener('input', () => this._dstRefreshAutoDescription());
    });
    tr.querySelector('.dst-row-remove').addEventListener('click', () => {
      tr.remove();
      const tbody = document.getElementById('dst-rows-tbody');
      if (!tbody.querySelector('tr.dst-row')) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${t('a.dst.noInputs')}</td></tr>`;
      }
      this._dstRefreshAutoDescription();
      this._dstRefreshRecipeId();
      // Freed layer should reappear in the remaining rows' lists.
      this._dstRebuildRowLayerOptions();
    });
    return tr;
  }

  dstAddRow(step = {}) {
    const tbody = document.getElementById('dst-rows-tbody');
    // Drop the empty-state placeholder if present.
    if (tbody.querySelector('.empty-state')) tbody.innerHTML = '';
    tbody.appendChild(this._dstRenderRow(step));
    this._dstRefreshAutoDescription();
  }

  _dstPopulateRows(steps) {
    const tbody = document.getElementById('dst-rows-tbody');
    tbody.innerHTML = '';
    if (!steps.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${t('a.dst.noInputs')}</td></tr>`;
      return;
    }
    steps.forEach(s => tbody.appendChild(this._dstRenderRow(s)));
  }

  _dstReadEditor() {
    const tbody = document.getElementById('dst-rows-tbody');
    const rows = Array.from(tbody.querySelectorAll('tr.dst-row'));
    const steps = rows.map((tr, idx) => {
      const layer_id = tr.querySelector('.dst-row-layer').value;
      const threshold = tr.querySelector('.dst-row-threshold-val').value || tr.querySelector('.dst-row-threshold').value;
      const below = tr.querySelector('.dst-row-below').value;
      const above = tr.querySelector('.dst-row-above').value;
      if (!layer_id) throw new Error(`Row ${idx + 1}: pick a layer`);
      if (threshold === '' || threshold == null) throw new Error(`Row ${idx + 1}: threshold required`);
      return {
        step_id: idx + 1,
        layer_id,
        op: '>=',
        threshold: Number(threshold),
        true_score: above === '' ? 1 : Number(above),
        false_score: below === '' ? 0 : Number(below),
        weight: 1,
      };
    });
    if (!steps.length) throw new Error('Add at least one input layer');
    const recipe = {
      steps,
      aggregation: 'sum',
      no_data_handling: 'propagate',
      metadata: {
        publish_to_catalogue: true,
        spatial_metadata_project_id:
          document.getElementById('dst-output-project').value.trim() || 'DST',
        spatial_metadata_property_id:
          document.getElementById('dst-output-property').value.trim() || 'SUITABILITY',
      },
    };
    // api.dst_recipe.name is NOT NULL; derive it from the picked mapped
    // property's display name. Falls back to the recipe_id so the save
    // doesn't fail when nothing's picked yet.
    const propId = document.getElementById('dst-output-property').value;
    const propRow = (this._rasterPropertyNums || []).find(p => p.mapped_property_id === propId);
    // recipe_id is auto-built by _dstRefreshRecipeId in the standard SIS
    // layer-id format; just trim any accidental trailing dashes.
    const recipeId = document.getElementById('dst-recipe-id').value.trim().replace(/-+$/, '');
    return {
      recipe_id: recipeId,
      name: (propRow && propRow.name) || recipeId,
      description: document.getElementById('dst-recipe-description').value || null,
      recipe,
    };
  }

  // Persist the editor state to api.dst_recipe and return the recipe_id
  // we ended up writing under. Handles three cases:
  //   1. brand-new recipe        → POST
  //   2. recipe_id unchanged     → PUT (overwrites existing row)
  //   3. recipe_id renamed       → DELETE old (with its produced raster +
  //                                metadata + map file) + POST new
  // The last case is what triggers when the user changes Project /
  // Mapped property / depth on an existing recipe — the layer_id encodes
  // those fields so the old layer can no longer be the right target.
  async _dstPersistEditor() {
    const payload = this._dstReadEditor();
    if (!payload.recipe_id) throw new Error('recipe_id required');
    if (!payload.name) throw new Error('name required');
    const newId = payload.recipe_id;
    const oldId = this._dstLoadedRecipeId;
    let layerCleanup = null;
    if (oldId && oldId !== newId) {
      // Tear down the old recipe row + its produced raster/.map/.xml.
      // _delete_layer_full on the backend handles the on-disk + soil_data
      // + pyCSW cleanup. Best-effort: surface any warning to the status
      // line but keep going.
      const res = await api.deleteDstRecipe(oldId);
      layerCleanup = res && res.layer_cleanup;
    }
    if (oldId && oldId === newId) {
      await api.updateDstRecipe(newId, payload);
    } else {
      await api.createDstRecipe(payload);
    }
    this._dstLoadedRecipeId = newId;
    // The editor now reflects the saved recipe (new id after a create or
    // rename) — keep the open-toggle state in sync.
    if (this._dstOpenRecipeId !== null) {
      this._dstOpenRecipeId = newId;
      this._dstSyncNewButton();
    }
    document.getElementById('dst-editor-id').textContent = newId;
    return { recipe_id: newId, renamed_from: (oldId && oldId !== newId) ? oldId : null, layerCleanup };
  }

  async dstSaveRecipe() {
    const status = document.getElementById('dst-status');
    try {
      const res = await this._dstPersistEditor();
      status.textContent = res.renamed_from
        ? t('a.dst.renamedFrom', {name: res.renamed_from})
        : t('a.dst.saved');
      await this.dstReloadRecipes();
      // Rename → an old layer was deleted; refresh the admin Rasters table
      // so it doesn't show the now-gone entry.
      if (res.renamed_from && typeof this.loadLayers === 'function') {
        await this.loadLayers();
      }
    } catch (e) { status.textContent = e.message; }
  }


  async dstRun() {
    const status = document.getElementById('dst-status');
    // Persist editor state first (handles the rename → delete old +
    // create new case), then run against the freshly-saved recipe.
    status.textContent = t('a.st.saving');
    let persisted;
    try {
      persisted = await this._dstPersistEditor();
    } catch (e) {
      status.textContent = t('a.err.saveFailed') + e.message;
      return;
    }
    const id = persisted.recipe_id;
    // Reflect the just-saved recipe in the list immediately (a new recipe's
    // row appears now, showing "Close" since its editor stays open).
    await this.dstReloadRecipes();
    if (persisted.renamed_from && typeof this.loadLayers === 'function') {
      // Refresh the admin Rasters table so the deleted old entry disappears.
      await this.loadLayers();
    }
    status.textContent = t('a.st.queuing');
    try {
      await api.runDstRecipe(id);
      status.textContent = t('a.st.queued');
      this._dstPollRun(id);
    } catch (e) { status.textContent = t('a.err.runFailed') + e.message; }
  }

  // Run state now lives on api.dst_recipe directly; poll the recipe
  // endpoint until its latest_run.status hits a terminal value.
  async _dstPollRun(recipeId) {
    const status = document.getElementById('dst-status');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const r = await api.getDstRecipe(recipeId);
        const lr = r.latest_run || {};
        status.textContent = `${recipeId}: ${lr.status || '?'}`;
        if (lr.status === 'succeeded' || lr.status === 'failed' || lr.status === 'cancelled') {
          await this.dstReloadRecipes();
          if (lr.status === 'succeeded' && typeof this.loadLayers === 'function') {
            await this.loadLayers();
            // loadLayers refreshes the data only — redraw the Rasters table so
            // the freshly-registered DST output shows without a page reload.
            if (typeof this.renderLayers === 'function') this.renderLayers();
          }
          return;
        }
      } catch (e) { /* keep polling */ }
    }
    status.textContent = t('a.dst.stillRunning', {name: recipeId});
  }

  // Relabel the "+ New Recipe" button to "Close" while a NEW (unsaved)
  // editor is open; the per-row Open/Close toggle is handled in the table.
  _dstSyncNewButton() {
    const b = document.getElementById('dst-new-btn');
    if (b) b.textContent = (this._dstOpenRecipeId === '__new__') ? 'Close' : '+ New Recipe';
  }

  // Just hide the editor panel — no save. Used internally (e.g. after a
  // delete, where saving would re-create the deleted recipe).
  _dstHideEditor() {
    this._dstOpenRecipeId = null;
    this._dstSyncNewButton();
    document.getElementById('dst-editor-wrap').style.display = 'none';
    document.getElementById('dst-editor').style.display = 'none';
    document.getElementById('dst-editor-id').textContent = '';
    document.getElementById('dst-status').textContent = '';
  }

  // Close (via the row's toggle or the "+ New Recipe"→Close button):
  // persist the editor first (there's no Save button — the recipe is always
  // saved on Close and on Run), hide, then refresh the list so the toggle
  // labels reset. If there's nothing valid to save we just close.
  async dstCloseEditor() {
    try {
      await this._dstPersistEditor();
    } catch (e) {
      console.warn('DST close: nothing saved —', e.message);
    }
    this._dstHideEditor();              // clears _dstOpenRecipeId
    await this.dstReloadRecipes();      // re-render so rows show "Open"
  }

  // Recipes-row actions. Run uses the saved recipe straight from the DB —
  // no editor-side state involved, so the user can run any recipe without
  // opening it first.
  async dstRunRecipeById(recipeId) {
    const status = document.getElementById('dst-status');
    // If the editor is currently showing this recipe, persist any pending
    // edits first — otherwise the row Run would dispatch the last-saved
    // values, not what the user just typed. Use the tracked open-id rather
    // than the (possibly already-rewritten) recipe_id field so this still
    // works after a Project/Mapped-property change.
    if (this._dstOpenRecipeId && this._dstOpenRecipeId === recipeId) {
      status.textContent = t('a.st.saving');
      try {
        const persisted = await this._dstPersistEditor();
        recipeId = persisted.recipe_id;   // may have changed (rename)
        await this.dstReloadRecipes();
      } catch (e) {
        status.textContent = t('a.err.saveFailed') + e.message;
        return;
      }
    }
    status.textContent = t('a.dst.queuingRun', {name: recipeId});
    try {
      await api.runDstRecipe(recipeId);
      this._dstPollRun(recipeId);
    } catch (e) {
      status.textContent = t('a.err.runFailed') + e.message;
    }
  }

  async dstDeleteRecipeById(recipeId) {
    if (!confirm(t('a.dst.deleteConfirm', {name: recipeId}))) return;
    try {
      await api.deleteDstRecipe(recipeId);
      // If the editor was showing this recipe, close it too.
      const editorId = document.getElementById('dst-recipe-id').value.trim();
      if (editorId === recipeId) this._dstHideEditor();
      await this.dstReloadRecipes();
      // The produced raster + its mapset/layer/pyCSW XML are now gone too —
      // reload the admin Rasters table so it doesn't show a ghost entry.
      // The public map viewer is a separate SPA; the user must refresh that
      // page (or the /api/layer feed will reflect the deletion on its next
      // poll).
      if (typeof this.loadLayers === 'function') {
        await this.loadLayers();
      }
    } catch (e) {
      document.getElementById('dst-status').textContent = e.message;
    }
  }

  // ==================== Software & updates ====================

  async loadSoftwareVersion() {
    const el = document.getElementById('sw-current');
    if (!el) return;
    try {
      const v = await api.getSoftwareVersion();
      el.textContent = v.sha || t('a.unknown');
    } catch (e) {
      el.textContent = t('a.unknown');
    }
  }

  async checkForUpdates() {
    const btn = document.getElementById('sw-check-btn');
    const status = document.getElementById('sw-status');
    const result = document.getElementById('sw-result');
    if (!btn || !status || !result) return;
    btn.disabled = true;
    status.textContent = t('a.st.checkingGithub');
    status.style.color = '#555';
    result.style.display = 'none';
    try {
      const r = await api.checkForUpdates();
      const cur = document.getElementById('sw-current');
      if (cur && r.current) cur.textContent = r.current;

      if (r.error) {
        status.textContent = r.error;
        status.style.color = '#b8860b';
      } else if (r.available) {
        const n = r.new_commits || 0;
        status.textContent = t('a.sw.updateAvailable', {n});
        status.style.color = '#c0392b';
        const list = (r.commits || []).map(c => {
          const d = c.date ? ` <span style="color:#888;">(${this.escapeHtml(c.date.slice(0, 10))})</span>` : '';
          return `<li><code>${this.escapeHtml(c.sha)}</code> ${this.escapeHtml(c.message)}${d}</li>`;
        }).join('');
        result.innerHTML = `
          <div style="border:1px solid #e0c36b;background:#fff8e1;border-radius:6px;padding:var(--sp-3);">
            <p style="margin:0 0 var(--sp-2);">${t('a.sw.newerAvailable')}
              (<code>${this.escapeHtml(r.current)}</code> → <code>${this.escapeHtml(r.latest || '')}</code>).
              ${t('a.sw.applyRun')}</p>
            <pre style="margin:0 0 var(--sp-3);background:#f3f3f3;padding:8px;border-radius:4px;">cd &lt;install dir&gt; &amp;&amp; ./update.sh</pre>
            <details>
              <summary style="cursor:pointer;">${t('a.sw.whatsNew', {n: (r.commits || []).length})}</summary>
              <ul style="margin:var(--sp-2) 0 0;padding-left:1.2em;font-size:var(--fs-sm);">${list}</ul>
            </details>
            <p style="margin:var(--sp-3) 0 0;color:#777;font-size:var(--fs-xs);">
              ${t('a.sw.checkOnly')}</p>
          </div>`;
        result.style.display = 'block';
      } else {
        status.textContent = t('a.sw.upToDate', {v: r.current || ''});
        status.style.color = '#2a7';
      }
    } catch (e) {
      status.textContent = t('a.err.checkFailed') + (e && e.message ? e.message : e);
      status.style.color = '#c0392b';
    } finally {
      btn.disabled = false;
    }
  }

  // ==================== Settings Management ====================

  async loadSettings() {
    try {
      this.settings = await api.getAllSettings();
    } catch (error) {
      console.error('Error loading settings:', error);
      alert(t('a.err.loadFailed') + error.message);
    }
  }

  renderSettings() {
    const tbody = document.getElementById('settings-tbody');
    const mapKeys = ['LATITUDE', 'LONGITUDE', 'ZOOM'];
    const keyOrder = ['APP_TITLE', 'LANGUAGE', 'ORG_LOGO_URL', 'BASE_MAP_DEFAULT', 'LAYER_PANEL_COLLAPSED', 'LATITUDE', 'LONGITUDE', 'ZOOM'];
    // Infrastructure settings — kept in DB but hidden from the UI to avoid accidental edits
    const hiddenKeys = new Set(['DOWNLOAD_BASE_URL', 'GLOSIS_FEDERATION_ENABLED']);

    const visible = this.settings.filter(s => !hiddenKeys.has(s.key));

    if (visible.length === 0) {
      tbody.innerHTML = `<tr><td colspan="2" class="empty-state">${t('a.emptySettings')}</td></tr>`;
      return;
    }

    // Sort: known keys first in keyOrder, then remaining alphabetically
    const sorted = [...visible].sort((a, b) => {
      const ia = keyOrder.indexOf(a.key);
      const ib = keyOrder.indexOf(b.key);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.key.localeCompare(b.key);
    });

    tbody.innerHTML = sorted.map(setting => {
      const key = this.escapeHtml(setting.key);
      const isMapKey = mapKeys.includes(setting.key);
      const isBaseMap = setting.key === 'BASE_MAP_DEFAULT';
      let valueCell;
      if (setting.key === 'LANGUAGE') {
        // Default UI language for this instance — offer only the languages
        // the application actually ships (visitors can still override via
        // the map's language selector).
        const opts = LANGUAGES.map(([code, label]) =>
          `<option value="${code}"${setting.value === code ? ' selected' : ''}>${label} (${code})</option>`
        ).join('');
        valueCell = `<select class="inline-edit" data-key="${key}" style="padding:2px 6px;font-size:var(--fs-sm);">${opts}</select>`;
      } else if (setting.key === 'LAYER_PANEL_COLLAPSED') {
        // Whether the map view's layer panel starts collapsed — Yes/No.
        const truthy = setting.value === 'true';
        valueCell = `<select class="inline-edit" data-key="${key}" style="padding:2px 6px;font-size:var(--fs-sm);">
          <option value="true"${truthy ? ' selected' : ''}>${t('a.yes')}</option>
          <option value="false"${truthy ? '' : ' selected'}>${t('a.no')}</option>
        </select>`;
      } else if (isBaseMap) {
        const opts = Object.entries(BASE_MAP_OPTIONS).map(([k, v]) =>
          `<option value="${k}"${setting.value === k ? ' selected' : ''}>${v.label}</option>`
        ).join('');
        valueCell = `<select class="inline-edit" data-key="${key}" style="padding:2px 6px;font-size:var(--fs-sm);">${opts}</select>`;
      } else {
        valueCell = `<input class="inline-edit" data-key="${key}" value="${this.escapeHtml(setting.value)}" style="padding:2px 6px;font-size:var(--fs-sm);width:100%;box-sizing:border-box;"${isMapKey ? ` readonly title="${t('a.settings.mapControlled')}"` : ''}>`;
      }
      return `
        <tr>
          <td><strong>${key}</strong></td>
          <td>${valueCell}</td>
        </tr>`;
    }).join('');

    // Attach inline save on blur / change
    tbody.querySelectorAll('.inline-edit').forEach(el => {
      const event = el.tagName === 'SELECT' ? 'change' : 'blur';
      el.addEventListener(event, async () => {
        const key = el.dataset.key;
        const value = el.value.trim();
        if (!value) return;
        const setting = this.settings.find(s => s.key === key);
        if (setting && setting.value === value) return;
        try {
          await api.updateSetting(key, value);
          await this.loadSettings();
          if (['BASE_MAP_DEFAULT', 'LATITUDE', 'LONGITUDE', 'ZOOM'].includes(key)) {
            this.initViewEditor();
          }
        } catch (err) {
          alert(t('a.err.saveFailed') + err.message);
        }
      });
      // Save on Enter for text inputs
      if (el.tagName === 'INPUT') {
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        });
      }
    });
  }

  editSetting(key) {
    // Focus the inline input for this key
    const input = document.querySelector(`.inline-edit[data-key="${key}"]`);
    if (input) input.focus();
  }

  cancelSettingEdit() {
    this.editingItem = null;
    document.getElementById('setting-form').reset();
    document.getElementById('setting-key').disabled = false;
    const textInput = document.getElementById('setting-value');
    const selectInput = document.getElementById('setting-value-select');
    textInput.style.display = '';
    textInput.setAttribute('required', 'required');
    selectInput.style.display = 'none';
    document.getElementById('setting-btn-text').textContent = t('a.add');
    document.getElementById('cancel-setting').style.display = 'none';
  }

  async handleSettingSubmit() {
    const key = document.getElementById('setting-key').value.trim();
    const selectInput = document.getElementById('setting-value-select');
    const value = (key === 'BASE_MAP_DEFAULT' && selectInput.style.display !== 'none')
      ? selectInput.value
      : document.getElementById('setting-value').value.trim();

    if (!key || !value) {
      alert(t('a.fillRequired'));
      return;
    }

    try {
      if (this.editingItem && this.editingItem.type === 'setting') {
        // Update existing
        await api.updateSetting(key, value);
        alert(t('a.settings.updated'));
      } else {
        // Create new
        await api.createSetting(key, value);
        alert(t('a.settings.created'));
      }

      this.cancelSettingEdit();
      await this.loadSettings();
      this.renderSettings();
      if (['BASE_MAP_DEFAULT', 'LATITUDE', 'LONGITUDE', 'ZOOM'].includes(key)) {
        this.initViewEditor();
      }
    } catch (error) {
      alert(t('a.err.saveFailed') + error.message);
    }
  }

  async deleteSetting(key) {
    if (!confirm(t('a.settings.deleteConfirm', {name: key}))) {
      return;
    }

    try {
      await api.deleteSetting(key);
      alert(t('a.settings.deleted'));
      await this.loadSettings();
      this.renderSettings();
    } catch (error) {
      alert(t('a.err.deleteFailed') + error.message);
    }
  }

  // ==================== User Management ====================

  async loadUsers() {
    try {
      this.users = await api.getUsers();
    } catch (error) {
      console.error('Error loading users:', error);
    }
  }

  renderUsers() {
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;

    if (this.users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${t('a.emptyUsers')}</td></tr>`;
      return;
    }

    const fmt = (d) => d ? new Date(d).toLocaleString() : '-';

    const adminCount = this.users.filter(u => u.is_admin).length;

    tbody.innerHTML = this.users.map(u => {
      const isOnlyAdmin = u.is_admin && adminCount <= 1;
      const isSelf = u.user_id === this.currentUserId;
      const isDefaultAdmin = u.user_id === 'admin';
      // Guardrails (also enforced server-side): you never manage your own
      // row, nobody manages the default admin account, and the last admin
      // cannot be removed.
      const locked = isSelf || isDefaultAdmin || isOnlyAdmin;
      const lockTitle = isSelf ? t('a.users.ownAccount')
        : isDefaultAdmin ? t('a.users.defaultAdmin')
        : t('a.users.onlyAdmin');
      const deleteBtn = locked
        ? ''
        : `<button class="btn btn-danger btn-sm" onclick="adminDashboard.deleteUser('${this.escapeJsAttr(u.user_id)}')">${t('a.delete')}</button>`;
      let activeLabel;
      if (locked) {
        activeLabel = `<span class="badge badge-${u.is_active ? 'success' : 'danger'}" title="${lockTitle}">${u.is_active ? t('a.yes') : t('a.no')}</span>`;
      } else if (u.is_active) {
        activeLabel = `<span class="badge badge-success toggle-active" style="cursor:pointer;" title="${t('a.users.clickDeactivate')}">${t('a.yes')}</span>`;
      } else {
        activeLabel = `<span class="badge badge-danger toggle-active" style="cursor:pointer;" title="${t('a.users.clickActivate')}">${t('a.no')}</span>`;
      }
      let adminLabel;
      if (locked) {
        adminLabel = u.is_admin
          ? `<span class="badge badge-success" title="${lockTitle}">${t('a.admin')}</span>` : '-';
      } else if (u.is_admin) {
        adminLabel = `<span class="badge badge-success toggle-admin" style="cursor:pointer;" title="${t('a.users.clickRevoke')}">${t('a.admin')}</span>`;
      } else {
        adminLabel = `<span class="badge toggle-admin" style="cursor:pointer;background:#e0e0e0;color:#555;" title="${t('a.users.clickGrant')}">${t('a.user')}</span>`;
      }
      return `
        <tr>
          <td><strong>${this.escapeHtml(u.user_id)}</strong></td>
          <td data-user-id="${this.escapeHtml(u.user_id)}" data-admin="${u.is_admin}">${adminLabel}</td>
          <td data-user-id="${this.escapeHtml(u.user_id)}" data-active="${u.is_active}">${activeLabel}</td>
          <td>${fmt(u.created_at)}</td>
          <td>${fmt(u.last_login)}</td>
          <td class="actions">${deleteBtn}</td>
        </tr>`;
    }).join('');

    // Admin-rights toggle
    tbody.querySelectorAll('.toggle-admin').forEach(el => {
      el.addEventListener('click', async () => {
        const td = el.closest('td');
        const userId = td.dataset.userId;
        const currentlyAdmin = td.dataset.admin === 'true';
        const verb = currentlyAdmin ? t('a.users.revokeConfirm') : t('a.users.grantConfirm');
        if (!confirm(`${verb} "${userId}"?`)) return;
        try {
          await api.toggleUserAdmin(userId, !currentlyAdmin);
          await this.loadUsers();
          this.renderUsers();
        } catch (e) {
          alert(t('a.err.prefix') + e.message);
        }
      });
    });

    // Attach click handlers for active toggle
    tbody.querySelectorAll('.toggle-active').forEach(el => {
      el.addEventListener('click', async () => {
        const td = el.closest('td');
        const userId = td.dataset.userId;
        const currentlyActive = td.dataset.active === 'true';
        try {
          await api.toggleUserActive(userId, !currentlyActive);
          await this.loadUsers();
          this.renderUsers();
        } catch (err) {
          alert(t('a.err.updateFailed') + err.message);
        }
      });
    });
  }

  async handleUserSubmit() {
    const email = document.getElementById('user-email').value.trim();
    const password = document.getElementById('user-password').value;
    const isAdmin = document.getElementById('user-is-admin').checked;

    if (!email || !password) {
      alert(t('a.emailPwRequired'));
      return;
    }

    try {
      await api.createUser(email, password, isAdmin);
      document.getElementById('user-form').reset();
      await this.loadUsers();
      this.renderUsers();
    } catch (error) {
      alert(t('a.err.addFailed') + error.message);
    }
  }

  async deleteUser(userId) {
    if (!confirm(t('a.users.deleteConfirm', {name: userId}))) return;
    try {
      await api.deleteUser(userId);
      await this.loadUsers();
      this.renderUsers();
    } catch (error) {
      alert(t('a.err.deleteFailed') + error.message);
    }
  }

  // ==================== Layers Management ====================

  async loadLayers() {
    try {
      this.layers = await api.getAllLayers();
    } catch (error) {
      console.error('Error loading layers:', error);
      alert(t('a.err.loadFailed') + error.message);
    }
  }

  renderLayers() {
    const tbody = document.getElementById('layers-tbody');

    if (this.layers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-state">${t('a.raster.none')}</td></tr>`;
      return;
    }

    const baseSetting = (this.settings || []).find(s => s.key === 'DOWNLOAD_BASE_URL');
    const downloadBase = baseSetting ? baseSetting.value : '/downloads/';

    const editStyle = 'padding:2px 6px;font-size:var(--fs-sm);width:100%;box-sizing:border-box;background:transparent;border:1px solid transparent;';
    tbody.innerHTML = this.layers.map((layer, rowIdx) => {
      const id = this.escapeHtml(layer.layer_id);
      const idJs = this.escapeJsAttr(layer.layer_id);
      const defaultCell = layer.is_default
        ? `<span class="badge badge-success" style="cursor:pointer;" title="${t('a.raster.defaultOnTip')}" onclick="adminDashboard.clearDefaultLayer()">${t('a.yes')}</span>`
        : (layer.publish
            ? `<span class="badge badge-danger" style="cursor:pointer;" title="${t('a.raster.defaultOffTip')}" onclick="adminDashboard.setDefaultLayer('${idJs}')">${t('a.no')}</span>`
            : '-');
      const deleteCell = this.isAdmin
        ? `<td class="raster-delete-col"><button class="btn btn-sm" style="background:#dc3545;color:#fff;" title="${t('a.raster.deleteTip')}" onclick="adminDashboard.deleteRasterLayer('${idJs}')">${t('a.delete')}</button></td>`
        : `<td class="raster-delete-col"></td>`;
      return `
      <tr${layer.is_default ? ' style="background:#fff8d6;"' : ''}>
        <td style="white-space:nowrap;">
          <button type="button" class="ord-btn layer-move" data-layer-id="${id}" data-dir="-1"
                  title="${t('a.moveUp')}" ${rowIdx === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14l6-6 6 6"/></svg></button>
          <button type="button" class="ord-btn layer-move" data-layer-id="${id}" data-dir="1"
                  title="${t('a.moveDown')}" ${rowIdx === this.layers.length - 1 ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 10l6 6 6-6"/></svg></button>
        </td>
        <td><strong>${id}</strong></td>
        <td title="${this.escapeHtml(layer.file_orig_name || '')}" style="font-size:var(--fs-sm);color:#555;">${this.escapeHtml(layer.file_orig_name || '-')}</td>
        <td style="width:120px;"><input class="layer-edit" data-layer-id="${id}" data-field="project_name" value="${this.escapeHtml(layer.project_name || '')}" placeholder="-" style="${editStyle}" title="${t('a.raster.editGroupTip')}"></td>
        <td><input class="layer-edit" data-layer-id="${id}" data-field="property_name" value="${this.escapeHtml(layer.property_name || '')}" placeholder="-" style="${editStyle}" title="${t('a.raster.editNameTip')}"></td>
        <td>${this._legendSwatchHtml(layer, id)}</td>
        <td><div style="display:flex;align-items:center;gap:6px;">
          <input type="range" class="layer-opacity" data-layer-id="${id}" min="0" max="1" step="0.05"
                 value="${layer.default_opacity == null ? 1 : layer.default_opacity}"
                 style="width:70px;" title="${t('a.raster.opacityTip')}">
          <span class="layer-opacity-val" style="font-size:var(--fs-xs);color:#555;min-width:26px;">${layer.default_opacity == null ? '1' : layer.default_opacity}</span>
        </div></td>
        <td>${layer.publish
          ? `<span class="badge badge-success" style="cursor:pointer;" title="${t('a.admdiv.pubTip')}" onclick="adminDashboard.toggleLayerPublish('${idJs}', false)">${t('a.yes')}</span>`
          : `<span class="badge badge-danger" style="cursor:pointer;" title="${t('a.admdiv.unpubTip')}" onclick="adminDashboard.toggleLayerPublish('${idJs}', true)">${t('a.no')}</span>`}</td>
        <td>${defaultCell}</td>
        <td id="wms-status-${id}">-</td>
        ${deleteCell}
      </tr>
    `;
    }).join('');

    tbody.querySelectorAll('.layer-move').forEach(btn => {
      btn.addEventListener('click', () => this.moveRasterLayer(btn.dataset.layerId, Number(btn.dataset.dir)));
    });

    // Default-opacity sliders: live value label, save on release.
    tbody.querySelectorAll('.layer-opacity').forEach(el => {
      const label = el.parentElement.querySelector('.layer-opacity-val');
      el.addEventListener('input', () => { if (label) label.textContent = el.value; });
      el.addEventListener('change', async () => {
        const layerId = el.dataset.layerId;
        const layer = this.layers.find(l => l.layer_id === layerId);
        if (!layer) return;
        const v = parseFloat(el.value);
        try {
          await api.updateLayerCustom(layerId, { default_opacity: v });
          layer.default_opacity = v;
        } catch (e) {
          alert(t('a.err.saveFailed') + e.message);
          el.value = layer.default_opacity == null ? 1 : layer.default_opacity;
          if (label) label.textContent = el.value;
        }
      });
    });

    tbody.querySelectorAll('.legend-swatch').forEach(el => {
      el.addEventListener('click', (e) => {
        const layer = this.layers.find(l => l.layer_id === e.currentTarget.dataset.layerId);
        if (layer) this.openLegendColoursModal(layer);
      });
    });

    tbody.querySelectorAll('.layer-edit').forEach(el => {
      el.addEventListener('focus', () => { el.style.border = '1px solid #ccc'; el.style.background = '#fff'; });
      el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
      el.addEventListener('blur', async () => {
        el.style.border = '1px solid transparent';
        el.style.background = 'transparent';
        const layerId = el.dataset.layerId;
        const field = el.dataset.field;
        const newValue = el.value.trim() || null;
        const layer = this.layers.find(l => l.layer_id === layerId);
        if (!layer) return;
        // String-normalise: default_opacity arrives as a number from the API.
        const oldValue = layer[field] == null || layer[field] === '' ? null : String(layer[field]);
        if (oldValue === newValue) return;
        try {
          await api.updateLayerCustom(layerId, { [field]: newValue });
          layer[field] = newValue;
        } catch (e) {
          alert(t('a.err.saveFailed') + e.message);
          el.value = layer[field] || '';
        }
      });
    });
  }

  // HSV short-arc interpolation — the exact maths of soil_data._ramp_color,
  // so swatches and previews match what MapServer renders.
  _rampColor(startHex, endHex, n, i) {
    const toRgb = (h) => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16) / 255);
    const toHsv = ([r, g, b]) => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      let h = 0;
      if (d !== 0) {
        if (mx === r) h = 60 * (((g - b) / d) % 6);
        else if (mx === g) h = 60 * (((b - r) / d) + 2);
        else h = 60 * (((r - g) / d) + 4);
      }
      if (h < 0) h += 360;
      return [h, mx === 0 ? 0 : d / mx, mx];
    };
    const [sh, ss, sv] = toHsv(toRgb(startHex));
    const [eh, es, ev] = toHsv(toRgb(endHex));
    const t_ = n <= 1 ? 0 : (i - 1) / (n - 1);
    let dh = eh - sh;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    let h = sh + t_ * dh;
    if (h < 0) h += 360;
    if (h >= 360) h -= 360;
    const sVal = ss + (es - ss) * t_, v = sv + (ev - sv) * t_;
    const c = v * sVal, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    let rp, gp, bp;
    if (h < 60) [rp, gp, bp] = [c, x, 0];
    else if (h < 120) [rp, gp, bp] = [x, c, 0];
    else if (h < 180) [rp, gp, bp] = [0, c, x];
    else if (h < 240) [rp, gp, bp] = [0, x, c];
    else if (h < 300) [rp, gp, bp] = [x, 0, c];
    else [rp, gp, bp] = [c, 0, x];
    return '#' + [rp, gp, bp].map(u =>
      Math.max(0, Math.min(255, Math.round((u + m) * 255))).toString(16).padStart(2, '0')).join('');
  }

  _rampCss(startHex, endHex, n) {
    const stops = [];
    for (let i = 1; i <= n; i++) stops.push(this._rampColor(startHex, endHex, n, i));
    return stops.join(', ');
  }

  _legendSwatchHtml(layer, id) {
    const cat = layer.property_type === 'categorical' || layer.custom_classes;
    if (cat && layer.legend_classes && layer.legend_classes.length) {
      const n = layer.legend_classes.length;
      const stops = layer.legend_classes.map((c, i) =>
        `${c.color} ${(i / n * 100).toFixed(1)}%, ${c.color} ${((i + 1) / n * 100).toFixed(1)}%`).join(', ');
      return `<button type="button" class="legend-swatch" data-layer-id="${id}" title="${t('a.lg.editTip')}"
                      style="background:linear-gradient(to right, ${stops});"></button>`;
    }
    if (!cat && layer.mapped_property_id && layer.start_color && layer.end_color) {
      return `<button type="button" class="legend-swatch" data-layer-id="${id}" title="${t('a.lg.editTip')}"
                      style="background:linear-gradient(to right, ${this._rampCss(layer.start_color, layer.end_color, layer.num_intervals || 10)});"></button>`;
    }
    return '-';
  }

  openLegendColoursModal(layer) {
    if (layer.property_type === 'categorical') {
      this.openClassColoursModal(layer);
    } else {
      this.openQuantLegendModal(layer);
    }
  }

  // Quantitative layers: one modal, two tabs — the property-wide colour ramp
  // and per-mapset custom class breaks. Save acts on the active tab.
  openQuantLegendModal(layer) {
    const propId = layer.mapped_property_id;
    const classes = (layer.legend_classes || []).slice();
    const attr = (x) => this.escapeHtml(x).replace(/"/g, '&quot;');
    const tabStyle = (on) =>
      `padding:7px 14px;border:none;background:none;cursor:pointer;font-weight:600;` +
      `font-size:var(--fs-sm);border-bottom:2px solid ${on ? 'var(--color-primary)' : 'transparent'};` +
      `color:${on ? 'var(--color-primary)' : '#666'};`;

    const classRows = classes.map((c, i) => `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <input type="color" class="lg-c-cls" data-i="${i}" value="${attr(c.color)}">
        <input type="number" class="lg-c-val" data-i="${i}" step="any" value="${attr(String(c.value))}"
               title="${t('a.lg.valuePh')}" style="width:90px;padding:3px 6px;font-size:var(--fs-sm);">
        <input type="text" class="lg-c-lbl" data-i="${i}" value="${attr(c.label)}" maxlength="120"
               placeholder="${t('a.lg.labelPh')}" style="flex:1;min-width:0;padding:3px 6px;font-size:var(--fs-sm);">
        <button type="button" class="btn btn-danger btn-sm lg-c-del" title="${t('a.lg.removeTip')}"
                style="width:26px;padding:0;">&times;</button>
      </div>`).join('');

    const { body } = this._openModal(t('a.lg.title') + layer.layer_id, `
      <div style="display:flex;gap:2px;border-bottom:1px solid #ddd;margin-bottom:14px;">
        <button type="button" class="lg-tab" data-pane="ramp" style="${tabStyle(!layer.custom_classes)}">${t('a.lg.tabRamp')}</button>
        <button type="button" class="lg-tab" data-pane="custom" style="${tabStyle(!!layer.custom_classes)}">${t('a.lg.tabCustom')}</button>
      </div>

      <div class="lg-pane" data-pane="ramp" ${layer.custom_classes ? 'hidden' : ''}>
        <div style="display:flex;gap:18px;align-items:center;margin-bottom:12px;">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:var(--fs-sm);">${t('a.lg.start')}
            <input type="color" class="lg-start" value="${attr(layer.start_color || '#f4e7d3')}"></label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:var(--fs-sm);">${t('a.lg.end')}
            <input type="color" class="lg-end" value="${attr(layer.end_color || '#5c4033')}"></label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:var(--fs-sm);">${t('a.lg.intervals')}
            <input type="number" class="lg-n" min="2" max="20" step="1" value="${layer.num_intervals || 10}" style="width:70px;"></label>
        </div>
        <div class="lg-preview" style="height:26px;border-radius:4px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.15);margin-bottom:10px;"></div>
        <p style="font-size:var(--fs-xs);color:#777;margin:0 0 12px;">${t('a.lg.scope')}</p>
      </div>

      <div class="lg-pane" data-pane="custom" ${layer.custom_classes ? '' : 'hidden'}>
        <div class="lg-rows" style="max-height:46vh;overflow:auto;margin-bottom:6px;">${classRows}</div>
        <button type="button" class="btn btn-secondary btn-sm lg-add" style="margin-bottom:10px;">${t('a.lg.addClass')}</button>
        <p style="font-size:var(--fs-xs);color:#777;margin:0 0 12px;">${t('a.lg.scopeCustom')}</p>
      </div>

      <div class="pm-status" style="font-size:12px;"></div>
      <div style="margin-top:10px;text-align:right;">
        <button type="button" class="btn btn-secondary btn-sm pm-cancel">${t('a.cancel')}</button>
        <button type="button" class="btn btn-primary btn-sm lg-save">${t('a.save')}</button>
      </div>`, 540);

    // Tabs.
    let active = layer.custom_classes ? 'custom' : 'ramp';
    const tabs = body.querySelectorAll('.lg-tab');
    const panes = body.querySelectorAll('.lg-pane');
    tabs.forEach(tab => tab.addEventListener('click', () => {
      active = tab.dataset.pane;
      tabs.forEach(b => b.style.cssText = tabStyle(b.dataset.pane === active));
      panes.forEach(pn => { pn.hidden = pn.dataset.pane !== active; });
    }));

    // Ramp pane: live preview.
    const startEl = body.querySelector('.lg-start');
    const endEl = body.querySelector('.lg-end');
    const nEl = body.querySelector('.lg-n');
    const preview = body.querySelector('.lg-preview');
    const paint = () => {
      const n = Math.max(2, Math.min(20, parseInt(nEl.value, 10) || 10));
      preview.style.background = `linear-gradient(to right, ${this._rampCss(startEl.value, endEl.value, n)})`;
    };
    [startEl, endEl, nEl].forEach(el => el.addEventListener('input', paint));
    paint();

    // Custom pane: add / remove rows.
    body.querySelector('.lg-add').addEventListener('click', () => {
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';
      div.innerHTML = `
        <input type="color" class="lg-c-cls" value="#999999">
        <input type="number" class="lg-c-val" step="any" placeholder="${t('a.lg.valuePh')}"
               style="width:90px;padding:3px 6px;font-size:var(--fs-sm);">
        <input type="text" class="lg-c-lbl" maxlength="120" placeholder="${t('a.lg.labelPh')}"
               style="flex:1;min-width:0;padding:3px 6px;font-size:var(--fs-sm);">
        <button type="button" class="btn btn-danger btn-sm lg-c-del" title="${t('a.lg.removeTip')}"
                style="width:26px;padding:0;">&times;</button>`;
      body.querySelector('.lg-rows').appendChild(div);
      div.querySelector('.lg-c-val').focus();
    });
    body.querySelector('.lg-pane[data-pane="custom"]').addEventListener('click', (e) => {
      if (e.target.classList && e.target.classList.contains('lg-c-del')) {
        e.target.parentElement.remove();
      }
    });

    body.querySelector('.pm-cancel').addEventListener('click', () => document.getElementById('project-modal-overlay').remove());
    body.querySelector('.lg-save').addEventListener('click', async () => {
      const status = body.querySelector('.pm-status');
      status.style.color = '#666'; status.textContent = t('a.st.saving2');
      try {
        if (active === 'ramp') {
          // Returning to the ramp discards any saved custom breaks.
          if (layer.custom_classes) {
            if (!confirm(t('a.lg.resetConfirm'))) { status.textContent = ''; return; }
            await api.updateClassColours(layer.mapset_id, { reset_auto: true });
          }
          await api.updatePropertyColours(propId, {
            start_color: startEl.value, end_color: endEl.value,
            num_intervals: Math.max(2, Math.min(20, parseInt(nEl.value, 10) || 10)),
          });
        } else {
          const full = [];
          let bad = false;
          const uniq = new Set();
          body.querySelectorAll('.lg-pane[data-pane="custom"] .lg-rows > div').forEach(div => {
            const raw = div.querySelector('.lg-c-val').value.trim();
            const lbl = div.querySelector('.lg-c-lbl').value.trim();
            if (raw === '' && !lbl) return;       // untouched blank row
            const v = Number(raw);
            if (raw === '' || !isFinite(v) || uniq.has(v)) { bad = true; return; }
            uniq.add(v);
            full.push({ value: v, color: div.querySelector('.lg-c-cls').value, label: lbl || String(v) });
          });
          if (bad) { status.style.color = '#dc3545'; status.textContent = t('a.lg.valueRequired'); return; }
          if (full.length < 2) { status.style.color = '#dc3545'; status.textContent = t('a.lg.keepTwo'); return; }
          await api.updateClassColours(layer.mapset_id, { classes: full, replace_all: true, custom: true });
        }
        document.getElementById('project-modal-overlay').remove();
        await this.loadLayers(); this.renderLayers();
      } catch (e) {
        status.style.color = '#dc3545'; status.textContent = t('a.err.saveFailed') + e.message;
      }
    });
  }

  // Categorical layers: edit/add/remove the value classes directly.
  openClassColoursModal(layer) {
    const classes = (layer.legend_classes || []).slice();
    if (!classes.length) return;
    const attr = (x) => this.escapeHtml(x).replace(/"/g, '&quot;');
    const rows = classes.map((c, i) => `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <input type="color" class="lg-cls" data-i="${i}" value="${attr(c.color)}">
        <input type="number" class="lg-val" data-i="${i}" step="any" value="${attr(String(c.value))}"
               title="${t('a.lg.valuePh')}" style="width:90px;padding:3px 6px;font-size:var(--fs-sm);">
        <input type="text" class="lg-lbl" data-i="${i}" value="${attr(c.label)}" maxlength="120"
               placeholder="${t('a.lg.labelPh')}" style="flex:1;min-width:0;padding:3px 6px;font-size:var(--fs-sm);">
        <button type="button" class="btn btn-danger btn-sm lg-del" data-i="${i}" title="${t('a.lg.removeTip')}"
                style="width:26px;padding:0;">&times;</button>
      </div>`).join('');
    const { body } = this._openModal(t('a.lg.title') + layer.layer_id, `
      <div class="lg-rows" style="max-height:52vh;overflow:auto;margin-bottom:6px;">${rows}</div>
      <button type="button" class="btn btn-secondary btn-sm lg-add" style="margin-bottom:10px;">${t('a.lg.addClass')}</button>
      <p style="font-size:var(--fs-xs);color:#777;margin:0 0 12px;">${t('a.lg.scopeCat')}</p>
      <div class="pm-status" style="font-size:12px;"></div>
      <div style="margin-top:10px;text-align:right;">
        <button type="button" class="btn btn-secondary btn-sm pm-cancel">${t('a.cancel')}</button>
        <button type="button" class="btn btn-primary btn-sm lg-save">${t('a.save')}</button>
      </div>`, 480);
    body.querySelector('.pm-cancel').addEventListener('click', () => document.getElementById('project-modal-overlay').remove());

    body.querySelector('.lg-add').addEventListener('click', () => {
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';
      div.innerHTML = `
        <input type="color" class="lg-new-cls" value="#999999">
        <input type="number" class="lg-new-val" step="any" placeholder="${t('a.lg.valuePh')}"
               style="width:90px;padding:3px 6px;font-size:var(--fs-sm);">
        <input type="text" class="lg-new-lbl" maxlength="120" placeholder="${t('a.lg.labelPh')}"
               style="flex:1;min-width:0;padding:3px 6px;font-size:var(--fs-sm);">
        <button type="button" class="btn btn-danger btn-sm" title="${t('a.lg.removeTip')}"
                style="width:26px;padding:0;" onclick="this.parentElement.remove()">&times;</button>`;
      body.querySelector('.lg-rows').appendChild(div);
      div.querySelector('.lg-new-val').focus();
    });

    const removedValues = new Set();
    body.querySelectorAll('.lg-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = classes[Number(btn.dataset.i)];
        if (!c) return;
        removedValues.add(c.value);
        btn.closest('div').remove();
      });
    });

    body.querySelector('.lg-save').addEventListener('click', async () => {
      const status = body.querySelector('.pm-status');
      status.style.color = '#666'; status.textContent = t('a.st.saving2');
      const payload = { classes: [], remove: Array.from(removedValues) };
      const finalValues = new Set();
      let invalid = false;

      body.querySelectorAll('.lg-cls').forEach(inp => {
        const i = Number(inp.dataset.i);
        const c = classes[i];
        if (!c || removedValues.has(c.value)) return;
        const valEl = body.querySelector(`.lg-val[data-i="${i}"]`);
        const lblEl = body.querySelector(`.lg-lbl[data-i="${i}"]`);
        const raw = valEl ? valEl.value.trim() : String(c.value);
        const nv = Number(raw);
        if (raw === '' || !isFinite(nv) || finalValues.has(nv)) { invalid = true; return; }
        finalValues.add(nv);
        const label = lblEl ? lblEl.value.trim() : '';
        const entry = { value: c.value, color: inp.value };
        if (nv !== Number(c.value)) entry.new_value = nv;
        if (label && label !== c.label) entry.label = label;
        if (entry.new_value !== undefined || entry.label !== undefined || inp.value !== c.color) {
          payload.classes.push(entry);
        }
      });

      body.querySelectorAll('.lg-rows > div').forEach(div => {
        const valEl = div.querySelector('.lg-new-val');
        if (!valEl) return;
        const raw = valEl.value.trim();
        const lbl = div.querySelector('.lg-new-lbl').value.trim();
        if (raw === '' && !lbl) return;
        const v = Number(raw);
        if (raw === '' || !isFinite(v) || finalValues.has(v)) { invalid = true; return; }
        finalValues.add(v);
        payload.classes.push({ value: v, color: div.querySelector('.lg-new-cls').value,
                               label: lbl || String(v) });
      });

      if (invalid) {
        status.style.color = '#dc3545'; status.textContent = t('a.lg.valueRequired');
        return;
      }
      if (!finalValues.size) {
        status.style.color = '#dc3545'; status.textContent = t('a.lg.keepOne');
        return;
      }
      if (!payload.classes.length && !payload.remove.length) {
        document.getElementById('project-modal-overlay').remove(); return;
      }
      try {
        await api.updateClassColours(layer.mapset_id, payload);
        document.getElementById('project-modal-overlay').remove();
        await this.loadLayers(); this.renderLayers();
      } catch (e) {
        status.style.color = '#dc3545'; status.textContent = t('a.err.saveFailed') + e.message;
      }
    });
  }

  // Reorder by swapping with the neighbour, then persist a clean 0..n-1
  // sequence for every row whose stored position changed.
  async moveRasterLayer(layerId, dir) {
    const arr = this.layers.slice();
    const i = arr.findIndex(l => l.layer_id === layerId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    try {
      for (let k = 0; k < arr.length; k++) {
        if (arr[k].display_order !== k) {
          await api.updateLayerCustom(arr[k].layer_id, { display_order: k });
        }
      }
      await this.loadLayers(); this.renderLayers();
    } catch (e) {
      alert(t('a.err.updateFailed') + e.message);
    }
  }

  async moveSoilProfileLayer(projectId, dir) {
    const arr = (this.soilProfileLayers || []).slice();
    const i = arr.findIndex(r => r.project_id === projectId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    try {
      for (let k = 0; k < arr.length; k++) {
        if (arr[k].display_order !== k) {
          await api.setSoilProfileOrder(arr[k].project_id, k);
        }
      }
      await this.loadSoilProfileLayers(); this.renderSoilProfileLayers();
    } catch (e) {
      alert(t('a.err.updateFailed') + e.message);
    }
  }

  async setDefaultLayer(layerId) {
    try {
      await api.setDefaultLayer(layerId);
      await this.loadLayers();
      this.renderLayers();
    } catch (error) {
      alert(t('a.err.updateFailed') + error.message);
    }
  }

  async clearDefaultLayer() {
    try {
      await api.clearDefaultLayer();
      await this.loadLayers();
      this.renderLayers();
    } catch (error) {
      alert(t('a.err.updateFailed') + error.message);
    }
  }

  async toggleLayerPublish(layerId, publish) {
    try {
      await api.toggleLayerPublish(layerId, publish);
      await this.loadLayers();
      this.renderLayers();
    } catch (error) {
      alert(t('a.err.updateFailed') + error.message);
    }
  }

  async deleteRasterLayer(layerId) {
    if (!this.isAdmin) return;
    const ok = confirm(
      `Delete raster "${layerId}"?\n\nThis removes:\n` +
      `• the GeoTIFF and MapServer .map file on disk\n` +
      `• the pyCSW catalogue record\n` +
      `• the soil_data.layer and soil_data.mapset rows\n\nThis cannot be undone.`
    );
    if (!ok) return;
    try {
      const res = await api.deleteLayer(layerId);
      if (res && res.warnings && res.warnings.length) {
        console.warn('deleteLayer warnings:', res.warnings);
      }
      await this.loadLayers();
      this.renderLayers();
    } catch (e) {
      alert(t('a.err.deleteFailed') + e.message);
    }
  }

  // ==================== Soil Profile Layers ====================

  async loadSoilProfileLayers() {
    try {
      this.soilProfileLayers = await api.getSoilProfileLayers();
    } catch (error) {
      console.error('Error loading soil profile layers:', error);
      this.soilProfileLayers = [];
    }
  }

  renderSoilProfileLayers() {
    const tbody = document.getElementById('soil-profile-layers-tbody');
    if (!tbody) return;

    const rows = this.soilProfileLayers || [];
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="12" class="empty-state">${t('a.sp.none')}</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((r, rowIdx) => {
      const pid = this.escapeHtml(r.project_id);
      const name = this.escapeHtml(r.project_name || r.project_id);
      const limitVal = r.profile_limit == null ? '' : String(r.profile_limit);
      const blurVal = r.spatial_blur_m == null ? '' : String(r.spatial_blur_m);
      // Same look as the Users → Active toggle. Framed positively so Yes = green
      // (permissive), No = red (restriction). "Share attributes" is the inverse of
      // the underlying locations_only flag; data-value is still the locations_only
      // value written on click, so the backend/DB semantics are unchanged.
      const shareAttrBadge = r.locations_only
        ? `<span class="badge badge-danger sp-loc-only-toggle" data-project-id="${pid}" data-value="0" style="cursor:pointer;" title="${t('a.sp.locOnlyTip')}">${t('a.no')}</span>`
        : `<span class="badge badge-success sp-loc-only-toggle" data-project-id="${pid}" data-value="1" style="cursor:pointer;" title="${t('a.sp.fullAttrsTip')}">${t('a.yes')}</span>`;
      // "Show download button" is the inverse of the underlying hide_download flag;
      // data-value is still the hide_download value written on click.
      const showDlBadge = r.hide_download
        ? `<span class="badge badge-danger sp-hide-dl-toggle" data-project-id="${pid}" data-value="0" style="cursor:pointer;" title="${t('a.sp.dlHiddenTip')}">${t('a.no')}</span>`
        : `<span class="badge badge-success sp-hide-dl-toggle" data-project-id="${pid}" data-value="1" style="cursor:pointer;" title="${t('a.sp.dlShownTip')}">${t('a.yes')}</span>`;
      // Active-by-default: published either way; No = starts unticked.
      const activeBadge = (r.active_default === false)
        ? `<span class="badge badge-danger sp-active-toggle" data-project-id="${pid}" data-value="1" style="cursor:pointer;" title="${t('a.sp.activeOffTip')}">${t('a.no')}</span>`
        : `<span class="badge badge-success sp-active-toggle" data-project-id="${pid}" data-value="0" style="cursor:pointer;" title="${t('a.sp.activeOnTip')}">${t('a.yes')}</span>`;
      const totalProfiles = Number(r.total_profile_count || 0);
      const pubProfiles = Number(r.published_profile_count || 0);
      const totalObs = Number(r.total_observation_count || 0);
      const pubObs = Number(r.published_observation_count || 0);
      return `
      <tr>
        <td style="white-space:nowrap;">
          <button type="button" class="ord-btn sp-move" data-project-id="${pid}" data-dir="-1"
                  title="${t('a.moveUp')}" ${rowIdx === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14l6-6 6 6"/></svg></button>
          <button type="button" class="ord-btn sp-move" data-project-id="${pid}" data-dir="1"
                  title="${t('a.moveDown')}" ${rowIdx === rows.length - 1 ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 10l6 6 6-6"/></svg></button>
        </td>
        <td><strong>${name}</strong></td>
        <td title="${t('a.sp.pubTotalTip')}">
          <span class="sp-count-pub">${pubProfiles.toLocaleString()}</span>
          <span class="sp-count-sep">/</span>
          <span class="sp-count-total">${totalProfiles.toLocaleString()}</span>
        </td>
        <td title="${t('a.sp.pubTotalTip')}">
          <span class="sp-count-pub">${pubObs.toLocaleString()}</span>
          <span class="sp-count-sep">/</span>
          <span class="sp-count-total">${totalObs.toLocaleString()}</span>
        </td>
        <td>
          <button type="button" class="sp-symbology-btn" data-project-id="${pid}" title="${t('a.sp.symbologyTip')}"
                  style="background:none;border:1px solid #ccc;border-radius:4px;padding:3px 8px;cursor:pointer;line-height:0;">
            ${this._markerSvg(r.marker_shape || 'profile', r.marker_color || '#63452C', r.marker_opacity == null ? 0.8 : r.marker_opacity)}
          </button>
        </td>
        <td>
          <input type="number" min="1" step="1" class="sp-limit-input"
                 data-project-id="${pid}" value="${this.escapeHtml(limitVal)}"
                 placeholder="${t('a.sp.noLimitPh')}" inputmode="numeric">
          <span class="sp-limit-status" data-project-id="${pid}"></span>
        </td>
        <td>
          <input type="number" min="0" step="1" class="sp-blur-input"
                 data-project-id="${pid}" value="${this.escapeHtml(blurVal)}"
                 placeholder="${t('a.sp.precisePh')}" inputmode="numeric">
          <span class="sp-blur-status" data-project-id="${pid}"></span>
        </td>
        <td>${shareAttrBadge}</td>
        <td>${showDlBadge}</td>
        <td>${r.is_published
          ? `<span class="badge badge-success sp-publish-btn" data-project-id="${pid}" data-publish="0" style="cursor:pointer;" title="${t('a.admdiv.pubTip')}">${t('a.yes')}</span>`
          : `<span class="badge badge-danger sp-publish-btn" data-project-id="${pid}" data-publish="1" style="cursor:pointer;" title="${t('a.admdiv.unpubTip')}">${t('a.no')}</span>`}</td>
        <td>${activeBadge}</td>
        <td>
          <button class="btn btn-sm sp-delete-btn" style="background:#dc3545;color:#fff;"
                  data-project-id="${pid}" data-project-name="${name}"
                  title="${t('a.sp.pruneTip')}">
            ${t('a.sp.prune')}
          </button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.sp-publish-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const projectId = e.currentTarget.dataset.projectId;
        const publish = e.currentTarget.dataset.publish === '1';
        await this.flushPendingSoilProfileEdits();
        this.toggleSoilProfilePublish(projectId, publish);
      });
    });

    tbody.querySelectorAll('.sp-loc-only-toggle').forEach(el => {
      el.addEventListener('click', async (e) => {
        const projectId = e.currentTarget.dataset.projectId;
        const value = e.currentTarget.dataset.value === '1';
        await this.flushPendingSoilProfileEdits();
        this.toggleSoilProfileLocationsOnly(projectId, value);
      });
    });

    tbody.querySelectorAll('.sp-hide-dl-toggle').forEach(el => {
      el.addEventListener('click', async (e) => {
        const projectId = e.currentTarget.dataset.projectId;
        const value = e.currentTarget.dataset.value === '1';
        await this.flushPendingSoilProfileEdits();
        this.toggleSoilProfileHideDownload(projectId, value);
      });
    });

    tbody.querySelectorAll('.sp-move').forEach(btn => {
      btn.addEventListener('click', () => this.moveSoilProfileLayer(btn.dataset.projectId, Number(btn.dataset.dir)));
    });

    tbody.querySelectorAll('.sp-active-toggle').forEach(el => {
      el.addEventListener('click', async (e) => {
        const projectId = e.currentTarget.dataset.projectId;
        const value = e.currentTarget.dataset.value === '1';
        try {
          await api.setSoilProfileActive(projectId, value);
          await this.loadSoilProfileLayers();
          this.renderSoilProfileLayers();
        } catch (err) {
          alert(t('a.err.updateFailed') + err.message);
        }
      });
    });

    tbody.querySelectorAll('.sp-symbology-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const row = (this.soilProfileLayers || []).find(r => r.project_id === e.currentTarget.dataset.projectId);
        if (row) this.openSymbologyModal(row);
      });
    });

    tbody.querySelectorAll('.sp-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const projectId = e.currentTarget.dataset.projectId;
        const projectName = e.currentTarget.dataset.projectName || projectId;
        await this.deleteProjectProfiles(projectId, projectName);
      });
    });

    this.pendingSoilProfileLimits = this.pendingSoilProfileLimits || {};
    this.pendingSoilProfileBlurs = this.pendingSoilProfileBlurs || {};
    tbody.querySelectorAll('.sp-limit-input').forEach(input => {
      input.addEventListener('input', (e) => {
        const projectId = e.currentTarget.dataset.projectId;
        const raw = (e.currentTarget.value || '').trim();
        const current = this.soilProfileLayers.find(r => r.project_id === projectId);
        const original = current && current.profile_limit != null ? String(current.profile_limit) : '';
        if (raw === original) {
          delete this.pendingSoilProfileLimits[projectId];
        } else {
          this.pendingSoilProfileLimits[projectId] = raw;
        }
      });
    });
    tbody.querySelectorAll('.sp-blur-input').forEach(input => {
      input.addEventListener('input', (e) => {
        const projectId = e.currentTarget.dataset.projectId;
        const raw = (e.currentTarget.value || '').trim();
        const current = this.soilProfileLayers.find(r => r.project_id === projectId);
        const original = current && current.spatial_blur_m != null ? String(current.spatial_blur_m) : '';
        if (raw === original) {
          delete this.pendingSoilProfileBlurs[projectId];
        } else {
          this.pendingSoilProfileBlurs[projectId] = raw;
        }
      });
    });
  }

  // Small inline-SVG preview of a marker (shared by the table swatch and
  // the editor preview).
  _shadeColor(hex, f) {
    const n = (i) => parseInt(hex.slice(i, i + 2), 16);
    const mix = (c) => Math.max(0, Math.min(255, Math.round(f < 0 ? c * (1 + f) : c + (255 - c) * f)));
    return '#' + [n(1), n(3), n(5)].map(c => mix(c).toString(16).padStart(2, '0')).join('');
  }

  _markerSvg(shape, color, opacity, px = 18) {
    const c = this.escapeHtml(color);
    const o = opacity == null ? 0.8 : opacity;
    if (shape === 'profile') {
      // Vertical gradient — darker topsoil to lighter subsoil.
      const gid = 'pg' + c.replace('#', '') + String(px);
      return `<svg width="${px}" height="${px}" viewBox="0 0 18 18" aria-hidden="true">`
        + `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`
        + `<stop offset="0" stop-color="${this._shadeColor(c, -0.35)}"/>`
        + `<stop offset="1" stop-color="${this._shadeColor(c, 0.35)}"/></linearGradient></defs>`
        + `<rect x="6" y="1.5" width="6" height="15" fill="url(#${gid})" fill-opacity="${o}" stroke="#666" stroke-width="1"/></svg>`;
    }
    const shapes = {
      circle:   `<circle cx="9" cy="9" r="7"/>`,
      square:   `<rect x="2.5" y="2.5" width="13" height="13"/>`,
      triangle: `<polygon points="9,2 16,15.5 2,15.5"/>`,
      diamond:  `<polygon points="9,1.5 16.5,9 9,16.5 1.5,9"/>`,
      star:     `<polygon points="9,1.5 11.2,6.5 16.5,7 12.6,10.7 13.8,16 9,13.2 4.2,16 5.4,10.7 1.5,7 6.8,6.5"/>`,
      profile:  `<rect x="6" y="1.5" width="6" height="15"/>`,
    };
    return `<svg width="${px}" height="${px}" viewBox="0 0 18 18" aria-hidden="true">`
      + `<g fill="${c}" fill-opacity="${o}" stroke="#666" stroke-width="1">${shapes[shape] || shapes.circle}</g></svg>`;
  }

  openSymbologyModal(row) {
    const pid = row.project_id;
    const cur = {
      shape: row.marker_shape || 'profile',
      size: row.marker_size == null ? 8 : Number(row.marker_size),
      color: row.marker_color || '#63452C',
      opacity: row.marker_opacity == null ? 0.8 : Number(row.marker_opacity),
    };
    const shapeOpts = ['circle', 'square', 'triangle', 'diamond', 'star', 'profile'].map(sh =>
      `<option value="${sh}"${cur.shape === sh ? ' selected' : ''}>${t('a.shape.' + sh)}</option>`).join('');
    const { body } = this._openModal(t('a.sp.symbology') + ' — ' + (row.project_name || pid), `
      <div style="display:flex;gap:20px;align-items:flex-end;margin-bottom:12px;">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:var(--fs-sm);flex:1;">${t('a.sp.shape')}
          <select class="sym-shape">${shapeOpts}</select></label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:var(--fs-sm);flex:1;">${t('a.sp.colour')}
          <input type="color" class="sym-color" value="${this.escapeHtml(cur.color)}"></label>
      </div>
      <div style="display:flex;gap:20px;align-items:flex-end;margin-bottom:14px;">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:var(--fs-sm);flex:1;">${t('a.sp.size')}
          <span style="display:flex;align-items:center;gap:6px;">
            <input type="range" class="sym-size" min="4" max="20" step="1" value="${cur.size}" style="flex:1;">
            <span class="sym-size-val" style="font-size:var(--fs-xs);min-width:20px;">${cur.size}</span></span></label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:var(--fs-sm);flex:1;">${t('a.raster.opacity')}
          <span style="display:flex;align-items:center;gap:6px;">
            <input type="range" class="sym-opacity" min="0" max="1" step="0.05" value="${cur.opacity}" style="flex:1;">
            <span class="sym-opacity-val" style="font-size:var(--fs-xs);min-width:26px;">${cur.opacity}</span></span></label>
      </div>
      <div class="sym-preview" style="display:flex;align-items:center;justify-content:center;height:64px;background:#eef3ee;border-radius:6px;margin-bottom:12px;"></div>
      <div class="pm-status" style="font-size:12px;"></div>
      <div style="margin-top:10px;text-align:right;">
        <button type="button" class="btn btn-secondary btn-sm pm-cancel">${t('a.cancel')}</button>
        <button type="button" class="btn btn-primary btn-sm sym-save">${t('a.save')}</button>
      </div>`, 520);
    const shapeEl = body.querySelector('.sym-shape');
    const colorEl = body.querySelector('.sym-color');
    const sizeEl = body.querySelector('.sym-size');
    const opacEl = body.querySelector('.sym-opacity');
    const preview = body.querySelector('.sym-preview');
    const paint = () => {
      body.querySelector('.sym-size-val').textContent = sizeEl.value;
      body.querySelector('.sym-opacity-val').textContent = opacEl.value;
      preview.innerHTML = this._markerSvg(shapeEl.value, colorEl.value, parseFloat(opacEl.value),
                                          Math.round(Number(sizeEl.value) * 3));
    };
    [shapeEl, colorEl, sizeEl, opacEl].forEach(el => el.addEventListener('input', paint));
    paint();
    body.querySelector('.pm-cancel').addEventListener('click', () => document.getElementById('project-modal-overlay').remove());
    body.querySelector('.sym-save').addEventListener('click', async () => {
      const status = body.querySelector('.pm-status');
      status.style.color = '#666'; status.textContent = t('a.st.saving2');
      try {
        await api.setSoilProfileSymbology(pid, {
          marker_shape: shapeEl.value,
          marker_size: parseFloat(sizeEl.value),
          marker_color: colorEl.value,
          marker_opacity: parseFloat(opacEl.value),
        });
        document.getElementById('project-modal-overlay').remove();
        await this.loadSoilProfileLayers(); this.renderSoilProfileLayers();
      } catch (e) {
        status.style.color = '#dc3545'; status.textContent = t('a.err.saveFailed') + e.message;
      }
    });
  }

  setSoilProfileBlurStatus(projectId, text, isError = false) {
    const el = document.querySelector(`.sp-blur-status[data-project-id="${CSS.escape(projectId)}"]`);
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#a80000' : '#2e7d32';
    if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
  }

  setSoilProfileLimitStatus(projectId, text, isError = false) {
    const el = document.querySelector(`.sp-limit-status[data-project-id="${CSS.escape(projectId)}"]`);
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#a80000' : '#2e7d32';
    if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
  }

  async toggleSoilProfilePublish(projectId, publish) {
    try {
      await api.setSoilProfilePublish(projectId, publish);
      await this.loadSoilProfileLayers();
      this.renderSoilProfileLayers();
    } catch (error) {
      alert(t('a.err.updateFailed') + error.message);
    }
  }

  async toggleSoilProfileLocationsOnly(projectId, locationsOnly) {
    try {
      await api.setSoilProfileLocationsOnly(projectId, locationsOnly);
      await this.loadSoilProfileLayers();
      this.renderSoilProfileLayers();
    } catch (error) {
      alert(t('a.err.updateFailed') + error.message);
    }
  }

  async toggleSoilProfileHideDownload(projectId, hideDownload) {
    try {
      await api.setSoilProfileHideDownload(projectId, hideDownload);
      await this.loadSoilProfileLayers();
      this.renderSoilProfileLayers();
    } catch (error) {
      alert(t('a.err.updateFailed') + error.message);
    }
  }

  async flushPendingSoilProfileLimits() {
    const pending = this.pendingSoilProfileLimits || {};
    const entries = Object.entries(pending);
    if (entries.length === 0) return false;
    this.pendingSoilProfileLimits = {};
    let anySaved = false;
    let anyError = false;
    for (const [projectId, raw] of entries) {
      const limit = raw === '' ? null : parseInt(raw, 10);
      if (limit !== null && (Number.isNaN(limit) || limit <= 0)) {
        this.setSoilProfileLimitStatus(projectId, t('a.sp.invalidLimit'), true);
        anyError = true;
        continue;
      }
      try {
        await api.setSoilProfileLimit(projectId, limit);
        const row = (this.soilProfileLayers || []).find(r => r.project_id === projectId);
        if (row) row.profile_limit = limit;
        anySaved = true;
      } catch (error) {
        this.setSoilProfileLimitStatus(projectId, error.message || t('a.err.saveFailed'), true);
        anyError = true;
      }
    }
    return { anySaved, anyError };
  }

  async flushPendingSoilProfileBlurs() {
    const pending = this.pendingSoilProfileBlurs || {};
    const entries = Object.entries(pending);
    if (entries.length === 0) return { anySaved: false, anyError: false };
    this.pendingSoilProfileBlurs = {};
    let anySaved = false;
    let anyError = false;
    for (const [projectId, raw] of entries) {
      const blur = raw === '' ? null : parseInt(raw, 10);
      if (blur !== null && (Number.isNaN(blur) || blur < 0)) {
        this.setSoilProfileBlurStatus(projectId, t('a.sp.invalidBlur'), true);
        anyError = true;
        continue;
      }
      try {
        await api.setSoilProfileBlur(projectId, blur);
        const row = (this.soilProfileLayers || []).find(r => r.project_id === projectId);
        if (row) row.spatial_blur_m = blur;
        anySaved = true;
      } catch (error) {
        this.setSoilProfileBlurStatus(projectId, error.message || t('a.err.saveFailed'), true);
        anyError = true;
      }
    }
    return { anySaved, anyError };
  }

  async flushPendingSoilProfileEdits() {
    const [a, b] = await Promise.all([
      this.flushPendingSoilProfileLimits(),
      this.flushPendingSoilProfileBlurs(),
    ]);
    if (a.anySaved || b.anySaved) {
      await this.loadSoilProfileLayers();
      this.renderSoilProfileLayers();
    }
    return a.anySaved || b.anySaved || a.anyError || b.anyError;
  }

  // ==================== Dashboard (stats) ====================

  async loadDashboard() {
    const empty = document.getElementById('dashboard-empty');
    const content = document.getElementById('dashboard-content');
    if (!empty || !content) return;

    if (this.dashboardLoaded) return; // one-shot; user can reload page to refresh
    try {
      empty.textContent = t('a.dash.loading');
      const stats = await api.getDashboardStats();
      this.renderDashboardCards(stats.totals || {});
      this.renderDashboardCharts(stats);
      empty.style.display = 'none';
      content.style.display = '';
      this.dashboardLoaded = true;
    } catch (e) {
      console.error('Dashboard load failed:', e);
      empty.textContent = t('a.dash.loadFailed') + (e.message || e);
    }
  }

  renderDashboardCards(t) {
    const grid = document.getElementById('stat-card-grid');
    if (!grid) return;
    const fmt = (n) => Number(n || 0).toLocaleString();
    const cards = [
      { label: 'Projects', value: fmt(t.project_count), accent: 'c' },
      { label: 'Sites', value: fmt(t.site_count), accent: 'e' },
      { label: 'Profiles', value: fmt(t.profile_count), accent: 'a' },
      { label: 'Properties', value: fmt(t.property_count), accent: 'd' },
      { label: 'Measurements', value: fmt(t.observation_count), accent: 'b' },
      { label: 'Rasters', value: fmt(t.raster_count), accent: 'c' },
    ];
    grid.innerHTML = cards.map(c => `
      <div class="stat-card stat-card-${c.accent}">
        <div class="stat-card-value">${this.escapeHtml(c.value)}</div>
        <div class="stat-card-label">${this.escapeHtml(c.label)}</div>
      </div>
    `).join('');
  }

  renderDashboardCharts(stats) {
    if (this._dashboardCharts) {
      Object.values(this._dashboardCharts).forEach(c => c && c.destroy && c.destroy());
    }
    this._dashboardCharts = {};

    const palette = [
      '#2e7d32', '#1976d2', '#ef6c00', '#8e24aa',
      '#c62828', '#00838f', '#6d4c41', '#455a64',
      '#558b2f', '#ad1457'
    ];
    const paletteFor = (n) => Array.from({ length: n }, (_, i) => palette[i % palette.length]);

    const baseOpts = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 700, easing: 'easeOutQuart' },
      plugins: { legend: { display: false } },
    };

    // Profiles per project (horizontal bar)
    const pp = stats.profiles_per_project || [];
    this._dashboardCharts.profilesPerProject = new Chart(
      document.getElementById('chart-profiles-per-project'),
      {
        type: 'bar',
        data: {
          labels: pp.map(r => r.project_name),
          datasets: [{
            data: pp.map(r => r.profile_count),
            backgroundColor: paletteFor(pp.length),
            borderRadius: 4,
          }],
        },
        options: { ...baseOpts, indexAxis: 'y', scales: { x: { beginAtZero: true } } },
      }
    );

    // Rasters per project (horizontal bar)
    const rp = stats.rasters_per_project || [];
    this._dashboardCharts.rastersPerProject = new Chart(
      document.getElementById('chart-rasters-per-project'),
      {
        type: 'bar',
        data: {
          labels: rp.map(r => r.project_name),
          datasets: [{
            data: rp.map(r => r.raster_count),
            backgroundColor: paletteFor(rp.length),
            borderRadius: 4,
          }],
        },
        options: { ...baseOpts, indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } },
      }
    );

    // Top properties (horizontal bar)
    const tp = stats.top_properties || [];
    this._dashboardCharts.topProperties = new Chart(
      document.getElementById('chart-top-properties'),
      {
        type: 'bar',
        data: {
          labels: tp.map(r => r.property),
          datasets: [{
            data: tp.map(r => r.observation_count),
            backgroundColor: paletteFor(tp.length),
            borderRadius: 4,
          }],
        },
        options: { ...baseOpts, indexAxis: 'y', scales: { x: { beginAtZero: true } } },
      }
    );

    // Profiles per year (line, filled)
    const py = stats.profiles_per_year || [];
    this._dashboardCharts.profilesPerYear = new Chart(
      document.getElementById('chart-profiles-per-year'),
      {
        type: 'line',
        data: {
          labels: py.map(r => String(r.year)),
          datasets: [{
            data: py.map(r => r.profile_count),
            borderColor: '#2e7d32',
            backgroundColor: 'rgba(46,125,50,0.15)',
            fill: true,
            tension: 0.35,
            pointRadius: 3,
            pointHoverRadius: 5,
            borderWidth: 2,
          }],
        },
        options: { ...baseOpts, scales: { y: { beginAtZero: true } } },
      }
    );

    // Depth distribution (vertical bar)
    const dd = stats.depth_distribution || [];
    this._dashboardCharts.depthDistribution = new Chart(
      document.getElementById('chart-depth-distribution'),
      {
        type: 'bar',
        data: {
          labels: dd.map(r => r.depth_range + ' cm'),
          datasets: [{
            data: dd.map(r => r.element_count),
            backgroundColor: paletteFor(dd.length),
            borderRadius: 4,
          }],
        },
        options: { ...baseOpts, scales: { y: { beginAtZero: true } } },
      }
    );

    // Value summary — floating bars for Q1-Q3, with whiskers from min/max
    const vs = stats.value_summary || [];
    this._dashboardCharts.valueSummary = new Chart(
      document.getElementById('chart-value-summary'),
      {
        type: 'bar',
        data: {
          labels: vs.map(r => r.property),
          datasets: [
            {
              label: 'min–max',
              data: vs.map(r => [r.vmin, r.vmax]),
              backgroundColor: 'rgba(25,118,210,0.12)',
              borderColor: 'rgba(25,118,210,0.4)',
              borderWidth: 1,
              borderRadius: 2,
            },
            {
              label: 'Q1–Q3',
              data: vs.map(r => [r.q1, r.q3]),
              backgroundColor: paletteFor(vs.length),
              borderRadius: 4,
            },
          ],
        },
        options: {
          ...baseOpts,
          indexAxis: 'y',
          plugins: {
            legend: { display: true, position: 'bottom', labels: { boxWidth: 12 } },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const r = vs[ctx.dataIndex] || {};
                  return [
                    `n: ${Number(r.n).toLocaleString()}`,
                    `min: ${r.vmin}`,
                    `Q1: ${r.q1}`,
                    `median: ${r.median}`,
                    `Q3: ${r.q3}`,
                    `max: ${r.vmax}`,
                  ];
                },
              },
            },
          },
          scales: { x: { beginAtZero: false } },
        },
      }
    );
  }

  // ==================== ETL ====================

  // Single combined destination dropdown: friendly label → (table, column)
  // required: true → must be mapped (validated in backend)
  get ETL_DEST_OPTIONS() {
    return [
      { label: 'Profile code',                          table: 'plot',       column: 'plot_code',           required: true  },
      { label: 'Longitude',                             table: 'plot',       column: 'geom (longitude)',    required: true  },
      { label: 'Latitude',                              table: 'plot',       column: 'geom (latitude)',     required: true  },
      { label: 'Profile type (TrialPit or Borehole)',   table: 'plot',       column: 'type',                required: false },
      { label: 'Altitude',                              table: 'plot',       column: 'altitude',            required: false },
      { label: 'Sampling date',                         table: 'plot',       column: 'sampling_date',       required: true  },
      { label: 'Positional accuracy',                   table: 'plot',       column: 'positional_accuracy', required: false },
      { label: 'Upper depth',                           table: 'element',    column: 'upper_depth',         required: true  },
      { label: 'Lower depth',                           table: 'element',    column: 'lower_depth',         required: true  },
      { label: 'Layer type (Horizon or Layer)',         table: 'element',    column: 'type',                required: false },
      { label: 'Horizon',                               table: 'element',    column: 'horizon',             required: false },
      { label: 'Soil property',                         table: 'result_num', column: 'value',               required: true  },
    ];
  }

  etlDestValue(table, column) {
    return table && column ? `${table}|${column}` : '';
  }

  // Walk all .etl-prop dropdowns and append the new property option,
  // preserving each row's current selection. The row whose change handler
  // triggered the add is passed in `triggerSel` so we don't clobber its
  // own selection (the caller sets it explicitly afterwards).
  _refreshEtlPropertyDropdowns(newPropId, triggerSel) {
    const props = this.etlCodelists.properties || [];
    document.querySelectorAll('.etl-prop').forEach(sel => {
      const keep = sel === triggerSel ? '' : sel.value;
      sel.innerHTML = '<option value="">—</option>' + props.map(p =>
        `<option value="${p.property_num_id}" data-uri="${this.escapeHtml(p.uri || '')}">${this.escapeHtml(p.property_name)}</option>`
      ).join('') + '<option value="__new__">+ Add Property…</option>';
      if (keep) sel.value = keep;
    });
  }

  // Suggest the next free PROCEDURE#### id from the cached procedure catalogue.
  _nextEtlProcedureId() {
    const re = /^PROCEDURE(\d+)$/;
    let max = 0;
    for (const p of (this.etlCodelists.procedures || [])) {
      const m = re.exec(p.procedure_num_id || '');
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return 'PROCEDURE' + String(max + 1).padStart(4, '0');
  }

  // Inline-row variant of the "Add Procedure" flow. Same shape as
  // etlPromptAddProperty — three inputs (ID, name, definition) plus Add /
  // Cancel. Passes the current property_num_id so the backend can also
  // insert the observation_num link that makes the new procedure visible
  // in this property's procedure dropdown.
  async etlPromptAddProcedure(propertyNumId) {
    const tbody = document.getElementById('etl-mapping-tbody');
    if (!tbody) return null;
    const existing = tbody.querySelector('tr.etl-proc-add-row');
    if (existing) {
      existing.querySelector('.etl-new-proc-id').focus();
      return null;
    }

    const tr = document.createElement('tr');
    tr.className = 'etl-proc-add-row';
    tr.innerHTML = `
      <td colspan="6" style="background:#fafafa;border-top:2px solid var(--color-primary);padding:8px;">
        <strong style="font-size:var(--fs-sm);">${t('a.etl.newProcedure')}</strong>
        <div style="display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;margin-top:6px;">
          <input type="text" class="etl-new-proc-id"
                 placeholder="${t('a.etl.procIdPh')}"
                 pattern="[A-Z0-9_]+"
                 title="${t('a.etl.procIdTip')}"
                 style="width:170px;text-transform:uppercase;">
          <input type="text" class="etl-new-proc-name"
                 placeholder="${t('a.raster.displayNamePh')}" style="width:220px;">
          <textarea class="etl-new-proc-def" rows="2"
                    placeholder="${t('a.etl.defPh')}"
                    style="flex:1;min-width:260px;font-family:inherit;font-size:var(--fs-sm);"></textarea>
          <button type="button" class="btn btn-sm btn-primary etl-new-proc-add">${t('a.add')}</button>
          <button type="button" class="btn btn-sm btn-secondary etl-new-proc-cancel">${t('a.cancel')}</button>
          <span class="etl-new-proc-status" style="font-size:var(--fs-sm);align-self:center;"></span>
        </div>
      </td>`;
    tbody.appendChild(tr);
    const idIn   = tr.querySelector('.etl-new-proc-id');
    const nameIn = tr.querySelector('.etl-new-proc-name');
    const defIn  = tr.querySelector('.etl-new-proc-def');
    const status = tr.querySelector('.etl-new-proc-status');
    idIn.value = this._nextEtlProcedureId();
    idIn.focus();
    idIn.select();

    return await new Promise((resolve) => {
      tr.querySelector('.etl-new-proc-cancel').addEventListener('click', () => {
        tr.remove();
        resolve(null);
      });
      tr.querySelector('.etl-new-proc-add').addEventListener('click', async () => {
        const pid = (idIn.value || '').trim().toUpperCase();
        const pname = (nameIn.value || '').trim();
        const def = (defIn.value || '').trim() || null;
        if (!pid)   { status.textContent = t('a.idRequired'); return; }
        if (!/^[A-Z0-9_]+$/.test(pid)) {
          status.textContent = t('a.idCaps'); return;
        }
        if (!pname) { status.textContent = t('a.nameRequired'); return; }
        status.textContent = t('a.st.adding');
        try {
          const created = await api.createProcedure({
            procedure_num_id: pid, procedure_name: pname, definition: def,
            property_num_id: propertyNumId,
          });
          // Keep the cached procedure list in sync.
          this.etlCodelists.procedures = (this.etlCodelists.procedures || []).concat([{
            procedure_num_id: created.procedure_num_id || pid,
            procedure_name:   created.procedure_name   || pname,
            uri:              created.uri || '',
          }]);
          tr.remove();
          resolve({
            procedure_num_id: created.procedure_num_id || pid,
            procedure_name:   created.procedure_name   || pname,
            uri:              created.uri || '',
          });
        } catch (e) {
          status.textContent = t('a.err.addFailed') + (e && e.message ? e.message : e);
        }
      });
    });
  }

  // Suggest the next free PROPERTY#### id from the cached property catalogue.
  // Scans existing property_num_id values matching PROPERTY<digits>, picks
  // max+1 zero-padded to 4 digits, PROPERTY0001 if nothing matches yet.
  _nextEtlPropertyId() {
    const re = /^PROPERTY(\d+)$/;
    let max = 0;
    for (const p of (this.etlCodelists.properties || [])) {
      const m = re.exec(p.property_num_id || '');
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return 'PROPERTY' + String(max + 1).padStart(4, '0');
  }

  // Inline-row variant of the "Add Property" flow. Inserts a temp row at
  // the bottom of the standardisation table with three inputs (ID, name,
  // definition) and Add / Cancel buttons. Returns a promise that resolves
  // to the new property (on Add success) or null (on Cancel / failure).
  async etlPromptAddProperty() {
    const tbody = document.getElementById('etl-mapping-tbody');
    if (!tbody) return null;
    // Only one temp row at a time.
    const existing = tbody.querySelector('tr.etl-prop-add-row');
    if (existing) {
      existing.querySelector('.etl-new-prop-id').focus();
      return null;
    }

    const tr = document.createElement('tr');
    tr.className = 'etl-prop-add-row';
    tr.innerHTML = `
      <td colspan="6" style="background:#fafafa;border-top:2px solid var(--color-primary);padding:8px;">
        <strong style="font-size:var(--fs-sm);">${t('a.etl.newProperty')}</strong>
        <div style="display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;margin-top:6px;">
          <input type="text" class="etl-new-prop-id"
                 placeholder="${t('a.etl.procIdPh')}"
                 pattern="[A-Z0-9_]+"
                 title="${t('a.etl.procIdTip')}"
                 style="width:170px;text-transform:uppercase;">
          <input type="text" class="etl-new-prop-name"
                 placeholder="${t('a.raster.displayNamePh')}" style="width:220px;">
          <textarea class="etl-new-prop-def" rows="2"
                    placeholder="${t('a.etl.defPh')}"
                    style="flex:1;min-width:260px;font-family:inherit;font-size:var(--fs-sm);"></textarea>
          <button type="button" class="btn btn-sm btn-primary etl-new-prop-add">${t('a.add')}</button>
          <button type="button" class="btn btn-sm btn-secondary etl-new-prop-cancel">${t('a.cancel')}</button>
          <span class="etl-new-prop-status" style="font-size:var(--fs-sm);align-self:center;"></span>
        </div>
      </td>`;
    tbody.appendChild(tr);
    const idIn   = tr.querySelector('.etl-new-prop-id');
    const nameIn = tr.querySelector('.etl-new-prop-name');
    const defIn  = tr.querySelector('.etl-new-prop-def');
    const status = tr.querySelector('.etl-new-prop-status');
    // Suggest the next free PROPERTY#### id from the cached catalogue.
    idIn.value = this._nextEtlPropertyId();
    idIn.focus();
    idIn.select();

    return await new Promise((resolve) => {
      tr.querySelector('.etl-new-prop-cancel').addEventListener('click', () => {
        tr.remove();
        resolve(null);
      });
      tr.querySelector('.etl-new-prop-add').addEventListener('click', async () => {
        const pid = (idIn.value || '').trim().toUpperCase();
        const pname = (nameIn.value || '').trim();
        const def = (defIn.value || '').trim() || null;
        if (!pid)   { status.textContent = t('a.idRequired'); return; }
        if (!/^[A-Z0-9_]+$/.test(pid)) {
          status.textContent = t('a.idCaps'); return;
        }
        if (!pname) { status.textContent = t('a.nameRequired'); return; }
        status.textContent = t('a.st.adding');
        try {
          const created = await api.createProperty({
            property_num_id: pid, property_name: pname, definition: def,
          });
          tr.remove();
          resolve({
            property_num_id: created.property_num_id || pid,
            property_name:   created.property_name   || pname,
            uri:             created.uri || '',
          });
        } catch (e) {
          status.textContent = t('a.err.addFailed') + (e && e.message ? e.message : e);
        }
      });
    });
  }

  async loadEtlCodelists() {
    try {
      const [projects, organisations, individuals, properties, procedures, units] = await Promise.all([
        api.getProjects(),
        api.getOrganisations(),
        api.getIndividuals(),
        api.getProperties(),
        api.getProcedures(),
        api.getUnits()
      ]);
      this.etlCodelists = { projects, organisations, individuals, properties, procedures, units };
      this.etlCodelistsLoaded = true;
      this.populateEtlDropdowns();
      this.loadEtlDatasets();
    } catch (e) {
      console.error('Error loading ETL codelists:', e);
    }
  }

  populateEtlDropdowns() {
    const cl = this.etlCodelists;

    // Project dropdown (single)
    const projEl = document.getElementById('etl-project');
    if (projEl) {
      projEl.innerHTML = `<option value="">${t('a.select')}</option>` +
        (cl.projects || []).map(i => `<option value="${this.escapeHtml(i.project_id)}">${this.escapeHtml(i.project_id + ' — ' + (i.name || ''))}</option>`).join('');
      projEl.onchange = () => {
        this.loadProjectDetails(projEl.value);
      };
    }
  }

  loadProjectDetails(projectId) {
    const abstractEl = document.getElementById('etl-abstract');
    const licenseEl = document.getElementById('etl-license');
    if (!projectId || projectId === '__new__') {
      abstractEl.value = '';
      licenseEl.value = '';
      return;
    }
    const proj = (this.etlCodelists.projects || []).find(p => p.project_id === projectId);
    abstractEl.value = proj?.abstract || '';
    licenseEl.value = proj?.license || '';
  }

  async handleEtlSave() {
    const statusEl = document.getElementById('etl-save-status');
    statusEl.textContent = t('a.st.saving2');
    statusEl.style.color = '#555';

    try {
      // Metadata: project selection is required (authors are managed in the
      // Projects tab, not here).
      const projectId = document.getElementById('etl-project').value;
      if (!projectId) {
        statusEl.textContent = t('a.selectProject');
        statusEl.style.color = '#c33';
        return;
      }

      // Save the dataset abstract and license (the abstract is reused as the
      // project description, which raster/profile registration copies into the
      // mapset abstract for the ISO metadata).
      const abstract = document.getElementById('etl-abstract').value.trim();
      const license = document.getElementById('etl-license').value;
      await api.updateProject(projectId, { abstract: abstract || null, license: license || null });

      // Update local cache
      const proj = (this.etlCodelists.projects || []).find(p => p.project_id === projectId);
      if (proj) { proj.abstract = abstract || null; proj.license = license || null; }

      // Save standardisation (column mapping)
      const section = document.getElementById('etl-mapping-section');
      const tableName = section.dataset.tableName;
      if (tableName) {
        const mappingRows = document.querySelectorAll('#etl-mapping-tbody tr');
        const columns = [];
        mappingRows.forEach(tr => {
          const colName = tr.dataset.col;
          const destVal = tr.querySelector('.etl-dest').value;
          const [destTable, destCol] = destVal ? destVal.split('|') : [null, null];
          const entry = {
            column_name: colName,
            destination_table: destTable || null,
            destination_column: destCol || null,
            ignore_column: !destTable,
            property_num_id: null,
            procedure_num_id: null,
            unit_of_measure_id: null,
            conversion_operation: null,
            conversion_value: null
          };
          if (destTable === 'result_num') {
            entry.property_num_id = tr.querySelector('.etl-prop').value || null;
            entry.procedure_num_id = tr.querySelector('.etl-proc').value || null;
            entry.unit_of_measure_id = tr.querySelector('.etl-unit').value || null;
          }
          columns.push(entry);
        });
        const epsg = document.getElementById('etl-epsg').value.trim();
        await api.saveDatasetColumns(tableName, columns, epsg, projectId);
      }

      this.closeDetailPanel();
    } catch (e) {
      statusEl.textContent = t('a.err.prefix') + e.message;
      statusEl.style.color = '#c33';
    }
  }

  async persistCurrentMappings() {
    const section = document.getElementById('etl-mapping-section');
    const tableName = section ? section.dataset.tableName : null;
    if (!tableName) return;
    const mappingRows = document.querySelectorAll('#etl-mapping-tbody tr');
    const columns = [];
    mappingRows.forEach(tr => {
      const colName = tr.dataset.col;
      const destVal = tr.querySelector('.etl-dest').value;
      const [destTable, destCol] = destVal ? destVal.split('|') : [null, null];
      const entry = {
        column_name: colName,
        destination_table: destTable || null,
        destination_column: destCol || null,
        ignore_column: !destTable,
        property_num_id: null,
        procedure_num_id: null,
        unit_of_measure_id: null,
        conversion_operation: null,
        conversion_value: null
      };
      if (destTable === 'result_num') {
        entry.property_num_id = tr.querySelector('.etl-prop').value || null;
        entry.procedure_num_id = tr.querySelector('.etl-proc').value || null;
        entry.unit_of_measure_id = tr.querySelector('.etl-unit').value || null;
      }
      columns.push(entry);
    });
    const epsg = document.getElementById('etl-epsg').value.trim();
    const projectId = document.getElementById('etl-project').value;
    const projectIdToSave = (projectId && projectId !== '__new__') ? projectId : null;
    await api.saveDatasetColumns(tableName, columns, epsg, projectIdToSave);
  }

  async handleEtlValidate() {
    const statusEl = document.getElementById('etl-save-status');
    const section = document.getElementById('etl-mapping-section');
    const tableName = section.dataset.tableName;
    if (!tableName) {
      statusEl.textContent = t('a.noDatasetOpen');
      statusEl.style.color = '#c33';
      return;
    }
    statusEl.textContent = t('a.st.validating');
    statusEl.style.color = '#555';
    try {
      await this.persistCurrentMappings();
      const license = document.getElementById('etl-license')?.value || '';
      const result = await api.validateDataset(tableName, license);
      const cols = result.columns || {};

      // Apply per-column results in the mapping table
      document.querySelectorAll('#etl-mapping-tbody tr').forEach(tr => {
        const colName = tr.dataset.col;
        const cell = tr.querySelector('.etl-validation');
        if (!cell) return;
        const r = cols[colName];
        if (!r) {
          cell.textContent = '';
          cell.style.color = '#555';
          return;
        }
        const text = r.status === 'OK' ? 'OK' : r.errors.join('; ');
        cell.textContent = text;
        cell.style.color = r.status === 'OK' ? '#28a745' : '#dc3545';
      });

      // Rebuild error-cell map and re-render preview to highlight
      this.etlErrorCells = {};
      Object.entries(cols).forEach(([colName, r]) => {
        if (r.error_rows && r.error_rows.length) {
          this.etlErrorCells[colName] = new Set(r.error_rows);
        }
      });
      this.renderEtlPreviewPage();

      statusEl.textContent = result.message;
      statusEl.style.color = /OK/.test(result.message) ? '#28a745' : '#dc3545';

      this.showEtlValidationPopup(result);
    } catch (e) {
      statusEl.textContent = t('a.err.validationFailed') + e.message;
      statusEl.style.color = '#c33';
    }
  }

  // The rule applied for each (destination_table, destination_column) — kept
  // here so we can describe what was checked in the validation report popup.
  // Mirrors RULES in sis-api/main.py:validate_dataset.
  get ETL_RULE_DESCRIPTIONS() {
    return {
      'plot|plot_code':           t('a.val.r.plotCode'),
      'plot|type':                t('a.val.r.plotType'),
      'plot|altitude':            t('a.val.r.altitude'),
      'plot|positional_accuracy': t('a.val.r.posAccuracy'),
      'plot|sampling_date':       t('a.val.r.samplingDate'),
      'plot|geom (longitude)':    t('a.val.r.longitude'),
      'plot|geom (latitude)':     t('a.val.r.latitude'),
      'element|upper_depth':      t('a.val.r.upperDepth'),
      'element|lower_depth':      t('a.val.r.lowerDepth'),
      'element|type':             t('a.val.r.elementType'),
      'element|horizon':          t('a.val.r.horizon'),
      'result_num|value':         t('a.val.r.resultNum'),
    };
  }

  showEtlValidationPopup(result) {
    const cols = result.columns || {};
    const missing = result.missing_required || [];
    const required = ['Profile code', 'Longitude', 'Latitude', 'Sampling date',
                      'Upper depth', 'Lower depth', 'Soil property'];
    const e = (s) => this.escapeHtml(s);

    // Required-destinations checklist
    const reqRows = required.map(r => {
      const ok = !missing.includes(r);
      const icon = ok ? '✅' : '❌';
      const color = ok ? '#28a745' : '#dc3545';
      return `<li style="color:${color};">${icon} ${e(r)}</li>`;
    }).join('');

    // Per-column rule executions — we need to know what destination each
    // CSV column was mapped to. The mapping table has that info on the row.
    const rows = Array.from(document.querySelectorAll('#etl-mapping-tbody tr'));
    const colDestMap = {};   // csv_col → "plot|geom (longitude)" or null
    rows.forEach(tr => {
      const dest = tr.querySelector('.etl-dest');
      colDestMap[tr.dataset.col] = dest && dest.value ? dest.value : null;
    });

    const ruleDescs = this.ETL_RULE_DESCRIPTIONS;
    // String() wrappers below: escapeHtml() treats 0 as falsy and returns ''.
    const fmtBounds = (b) => {
      if (!b) return '';
      const minStr = (b.vmin !== null && b.vmin !== undefined) ? String(b.vmin) : '−∞';
      const maxStr = (b.vmax !== null && b.vmax !== undefined) ? String(b.vmax) : '+∞';
      const unit = b.canonical_unit || '?';
      const conv = b.conversion
        ? ` (CSV value × ${b.conversion.value} ${b.conversion.operation === '/' ? '⁻¹' : ''}, ${b.source_unit} → ${unit})`
        : (b.source_unit && b.source_unit !== unit
            ? ` (no conversion configured: ${b.source_unit} → ${unit})`
            : '');
      const hasData = b.data_min !== null && b.data_min !== undefined;
      const dataLine = hasData
        ? `<div style="font-size:0.85em;color:#555;margin-top:2px;">${t('a.val.yourData')} <strong>${e(String(b.data_min))}</strong>, ${t('a.val.max')} <strong>${e(String(b.data_max))}</strong> ${e(unit)}</div>`
        : '';
      return `<div style="font-size:0.85em;color:#555;margin-top:2px;">${t('a.val.boundsApplied')} <strong>${e(minStr)}</strong> ${t('a.val.and')} <strong>${e(maxStr)}</strong> ${e(unit)}${e(conv)}</div>${dataLine}`;
    };
    const colRows = Object.entries(cols).map(([csvCol, r]) => {
      const dest = colDestMap[csvCol];
      const destLabel = dest ? dest : t('a.val.skip');
      let ruleDesc = dest && ruleDescs[dest] ? ruleDescs[dest] : '—';
      // Specialise the result_num rule with the actual canonical unit so it
      // doesn't read as generic "converted to canonical unit" boilerplate.
      if (dest === 'result_num|value' && r.applied_bounds && r.applied_bounds.canonical_unit) {
        ruleDesc = t('a.val.convertedTo', {unit: r.applied_bounds.canonical_unit});
      }
      const ok = r.status === 'OK';
      const icon = ok ? '✅' : '❌';
      const color = ok ? '#28a745' : '#dc3545';
      const errBlock = (r.errors && r.errors.length)
        ? `<div style="margin-top:4px;font-size:0.85em;color:#dc3545;background:#fff5f5;padding:6px 8px;border-radius:3px;white-space:pre-wrap;">${e(r.errors.join('\n'))}</div>`
        : '';
      return `
        <div style="border:1px solid #e1e4e8;border-radius:4px;padding:8px;margin-bottom:8px;">
          <div style="font-weight:bold;color:${color};">${icon} <code>${e(csvCol)}</code> → ${e(destLabel)}</div>
          <div style="font-size:0.85em;color:#555;margin-top:2px;">${t('a.val.rule')} ${e(ruleDesc)}</div>
          ${fmtBounds(r.applied_bounds)}
          ${errBlock}
        </div>`;
    }).join('') || `<em style="color:#777;">${t('a.val.noCols')}</em>`;

    // Build/replace modal
    document.getElementById('etl-validation-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'etl-validation-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10001;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow:auto;';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:6px;max-width:780px;width:100%;box-shadow:0 4px 20px rgba(0,0,0,0.3);">
        <div style="padding:14px 20px;border-bottom:1px solid #e1e4e8;display:flex;align-items:center;justify-content:space-between;">
          <h3 style="margin:0;color:#2c3e50;">${t('a.val.title')}</h3>
          <button id="etl-validation-close" type="button" style="background:transparent;border:0;font-size:22px;cursor:pointer;color:#555;">&times;</button>
        </div>
        <div style="padding:16px 20px;">
          <div style="margin-bottom:10px;font-size:0.95em;">
            <strong>${t('a.val.summary')}</strong>
            <span style="color:${/OK/.test(result.message) ? '#28a745' : '#dc3545'};">${e(result.message || '')}</span>
            <span style="color:#777;font-size:0.9em;margin-left:8px;">${t('a.val.rowsChecked', {n: result.total_rows ?? '?'})}</span>
          </div>

          <h4 style="margin:16px 0 6px;">${t('a.val.required')}</h4>
          <ul style="margin:0;padding-left:20px;">${reqRows}</ul>

          <h4 style="margin:16px 0 6px;">${t('a.val.countryBounds')}</h4>
          ${this.formatCountryBoundsBlock(result.country_bounds)}

          <h4 style="margin:16px 0 6px;">${t('a.val.perColumn')}</h4>
          ${colRows}
        </div>
        <div style="padding:10px 20px;border-top:1px solid #e1e4e8;text-align:right;">
          <button id="etl-validation-export" type="button" class="btn btn-sm" style="background:#17a2b8;color:#fff;margin-right:8px;">${t('a.val.export')}</button>
          <button id="etl-validation-ok" type="button" class="btn btn-primary btn-sm">${t('a.close')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('#etl-validation-close').addEventListener('click', close);
    modal.querySelector('#etl-validation-ok').addEventListener('click', close);
    modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });
    modal.querySelector('#etl-validation-export').addEventListener('click', () => {
      this.exportEtlValidationReport(result, colDestMap, ruleDescs, missing, required);
    });
  }

  formatCountryBoundsBlock(cb) {
    const e = (s) => this.escapeHtml(String(s));
    if (!cb || !cb.checked) {
      return `<div style="color:#777;font-size:0.9em;">${t('a.val.cbSkipped')}</div>`;
    }
    const ok = cb.status === 'OK';
    const icon = ok ? '✅' : '❌';
    const color = ok ? '#28a745' : '#dc3545';
    const previewRows = (cb.outside_rows_preview && cb.outside_rows_preview.length)
      ? `<div style="font-size:0.85em;color:#dc3545;background:#fff5f5;padding:6px 8px;border-radius:3px;margin-top:6px;">${t('a.val.outsideRows', {n: cb.outside_rows_preview.length})} ${cb.outside_rows_preview.join(', ')}${cb.outside > cb.outside_rows_preview.length ? ', …' : ''}</div>`
      : '';
    return `
      <div style="border:1px solid #e1e4e8;border-radius:4px;padding:8px;">
        <div style="font-weight:bold;color:${color};">${icon} ${t('a.val.cbHeadline', {p: cb.percent_inside, c: cb.country_code, t: cb.threshold})}</div>
        <div style="font-size:0.85em;color:#555;margin-top:2px;">${t('a.val.cbRule')}</div>
        <div style="font-size:0.85em;color:#555;margin-top:2px;">${t('a.val.cbCounts', {n: cb.checked_rows, i: cb.inside, o: cb.outside})}</div>
        ${previewRows}
      </div>`;
  }

  exportEtlValidationReport(result, colDestMap, ruleDescs, missing, required) {
    const cols = result.columns || {};
    const section = document.getElementById('etl-mapping-section');
    const tableName = section ? section.dataset.tableName : 'dataset';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    const lines = [];
    lines.push(`# Validation report — ${tableName}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push(`**Summary:** ${result.message || ''}`);
    lines.push(`Rows checked: ${result.total_rows ?? '?'}`);
    lines.push('');
    lines.push('## Required destinations');
    required.forEach(r => {
      const ok = !missing.includes(r);
      lines.push(`- ${ok ? '[x]' : '[ ]'} ${r}`);
    });
    lines.push('');
    lines.push('## Country bounds');
    const cb = result.country_bounds || {};
    if (!cb.checked) {
      lines.push('- Skipped (needs Longitude, Latitude, COUNTRY_CODE, geom_convexhull).');
    } else {
      lines.push(`- Status: ${cb.status}`);
      lines.push(`- Country: ${cb.country_code}`);
      lines.push(`- Inside: ${cb.percent_inside}% (${cb.inside} of ${cb.checked_rows}); threshold ≥${cb.threshold}%`);
      if (cb.outside_rows_preview && cb.outside_rows_preview.length) {
        lines.push(`- Outside rows (first ${cb.outside_rows_preview.length}): ${cb.outside_rows_preview.join(', ')}`);
      }
    }
    lines.push('');
    lines.push('## Per-column checks');
    Object.entries(cols).forEach(([csvCol, r]) => {
      const dest = colDestMap[csvCol] || '(skip)';
      let rule = (colDestMap[csvCol] && ruleDescs[colDestMap[csvCol]]) || '—';
      if (dest === 'result_num|value' && r.applied_bounds && r.applied_bounds.canonical_unit) {
        rule = `must be a number; converted to ${r.applied_bounds.canonical_unit}`;
      }
      const status = r.status === 'OK' ? 'OK' : 'ERROR';
      lines.push(`### ${csvCol} → ${dest}`);
      lines.push(`- Rule: ${rule}`);
      lines.push(`- Status: ${status}`);
      if (r.applied_bounds) {
        const b = r.applied_bounds;
        const min = (b.vmin !== null && b.vmin !== undefined) ? b.vmin : '-inf';
        const max = (b.vmax !== null && b.vmax !== undefined) ? b.vmax : '+inf';
        lines.push(`- Bounds: between ${min} and ${max} ${b.canonical_unit || '?'}`);
        if (b.data_min !== null && b.data_min !== undefined) {
          lines.push(`- Your data: min = ${b.data_min}, max = ${b.data_max} ${b.canonical_unit || '?'}`);
        }
        if (b.conversion) {
          lines.push(`- Conversion: CSV ${b.conversion.operation} ${b.conversion.value} (${b.source_unit} → ${b.canonical_unit})`);
        } else if (b.source_unit && b.source_unit !== b.canonical_unit) {
          lines.push(`- Conversion: NONE (source ${b.source_unit} ≠ canonical ${b.canonical_unit})`);
        }
      }
      if (r.errors && r.errors.length) {
        lines.push('- Errors:');
        r.errors.forEach(err => lines.push(`  - ${err}`));
      }
      lines.push('');
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `validation_${tableName}_${stamp}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async handleEtlUpload() {
    const fileInput = document.getElementById('etl-file-input');
    const statusEl = document.getElementById('etl-upload-status');
    if (!fileInput.files.length) {
      statusEl.textContent = t('a.selectCsv');
      statusEl.style.color = '#c33';
      return;
    }
    const projectId = document.getElementById('etl-project').value;
    const btn = document.getElementById('etl-upload-btn');
    btn.disabled = true;
    statusEl.textContent = t('a.st.uploading');
    statusEl.style.color = '#555';
    try {
      const result = await api.uploadCsv(fileInput.files[0], projectId !== '__new__' ? projectId : null);
      this.etlUploadResult = result;
      statusEl.textContent = '';
      fileInput.value = '';
      await this.loadEtlDatasets();
      this.openDataset(result.table_name);
    } catch (e) {
      statusEl.textContent = t('a.err.prefix') + e.message;
      statusEl.style.color = '#c33';
    } finally {
      btn.disabled = false;
    }
  }

  async loadEtlDatasets() {
    try {
      const datasets = await api.getDatasets();
      this.etlDatasets = datasets;
      this.renderEtlDatasets();
    } catch (e) {
      console.error('Error loading datasets:', e);
    }
  }

  renderEtlDatasets() {
    const container = document.getElementById('etl-datasets-list');
    if (!container) return;
    if (!this.etlDatasets.length) {
      container.innerHTML = `<p style="font-size:var(--fs-sm);color:#555;">${t('a.noDatasets')}</p>`;
      return;
    }
    const fmtDate = v => {
      if (!v) return '-';
      const d = new Date(v);
      return isNaN(d) ? this.escapeHtml(String(v)) : d.toISOString().slice(0, 10);
    };
    container.innerHTML = `
      <table class="admin-table">
        <thead><tr><th>${t('a.etl.table')}</th><th>${t('a.user')}</th><th>${t('a.etl.uploaded')}</th><th>${t('a.etl.ingested')}</th><th>${t('a.status')}</th><th>${t('a.etl.cols')}</th><th>${t('a.etl.rows')}</th><th>${t('a.actions')}</th><th>${t('a.etl.result')}</th></tr></thead>
        <tbody>${this.etlDatasets.map(d => {
          const tn = this.escapeHtml(d.table_name);
          const tnJs = this.escapeJsAttr(d.table_name);
          const ingested = d.status === 'Ingested' || d.status === 'Partial';
          const noPrune = d.status === 'Uploaded' || d.status === 'Removed' || !d.status;
          return `<tr data-table="${tn}">
            <td>${tn}</td>
            <td>${this.escapeHtml(d.user_id || '-')}</td>
            <td>${fmtDate(d.upload_date)}</td>
            <td>${fmtDate(d.ingestion_date)}</td>
            <td>${this.escapeHtml(d.status || '-')}</td>
            <td>${d.n_col ?? '-'}</td>
            <td>${d.n_rows ?? '-'}</td>
            <td>
              <button class="btn btn-primary btn-sm" onclick="adminDashboard.openDataset('${tnJs}')">${t('a.etl.open')}</button>
              <button class="btn btn-sm" style="background:#28a745;color:#fff;margin-left:4px;${ingested ? 'opacity:0.5;pointer-events:none;' : ''}" onclick="adminDashboard.ingestDataset('${tnJs}')"${ingested ? ' disabled' : ''}>${t('a.etl.ingest')}</button>
              ${this.isAdmin ? `<button class="btn btn-sm" style="background:#dc3545;color:#fff;margin-left:4px;" onclick="adminDashboard.deleteDataset('${tnJs}')">${t('a.delete')}</button>` : ''}
            </td>
            <td class="etl-result" style="font-size:var(--fs-xs);max-width:300px;white-space:pre-wrap;">${this.escapeHtml(d.note || '')}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>`;
  }

  async openDataset(tableName) {
    try {
      const [preview, columns] = await Promise.all([
        api.getDatasetPreview(tableName),
        api.getDatasetColumns(tableName)
      ]);
      this.etlUploadResult = { table_name: tableName, columns: preview.columns };
      this.etlErrorCells = {};
      this.showEtlPreview(preview.columns, preview.rows);
      this.showEtlMapping(tableName, preview.columns, columns);

      // Restore project and authors from the dataset record
      const dataset = (this.etlDatasets || []).find(d => d.table_name === tableName);
      if (dataset && dataset.project_id) {
        const projEl = document.getElementById('etl-project');
        if (projEl) projEl.value = dataset.project_id;
        this.loadProjectDetails(dataset.project_id);
      } else {
        document.getElementById('etl-project').value = '';
        document.getElementById('etl-abstract').value = '';
        document.getElementById('etl-license').value = '';
      }

      // Switch to detail panel
      document.getElementById('etl-list-view').style.display = 'none';
      document.getElementById('etl-detail-panel').style.display = '';
      document.getElementById('etl-detail-title').textContent = tableName;
      document.getElementById('etl-save-status').textContent = '';
    } catch (e) {
      alert(t('a.err.loadFailed') + e.message);
    }
  }

  closeDetailPanel() {
    document.getElementById('etl-detail-panel').style.display = 'none';
    document.getElementById('etl-list-view').style.display = '';
    this.loadEtlDatasets();
  }

  setRowResult(tableName, html, isError) {
    const row = document.querySelector(`tr[data-table="${tableName}"]`);
    if (!row) return;
    const cell = row.querySelector('.etl-result');
    if (cell) {
      cell.innerHTML = html;
      cell.style.color = isError ? '#dc3545' : '#28a745';
    }
  }

  async ingestDataset(tableName) {
    // Send the currently-picked licence when the Metadata form has one. Do NOT
    // hard-block on an empty select: the Ingest button lives on the list view,
    // where the Metadata form may never have been loaded — the backend enforces
    // the licence rule and falls back to the licence already recorded on the
    // project's stub mapset.
    const licenseEl = document.getElementById('etl-license');
    const license = (licenseEl && licenseEl.value || '').trim() || null;
    this.setRowResult(tableName, t('a.st.ingesting'), false);
    try {
      const result = await api.ingestDataset(tableName, { license });
      let msg = result.message || t('a.etl.ingestedRows', {a: result.ingested, b: result.total});
      if (result.errors && result.errors.length) {
        msg += '\n' + t('a.etl.errorsCount', {n: result.errors.length});
      }
      this.setRowResult(tableName, this.escapeHtml(msg), false);
      this.loadEtlDatasets();
      // Soil profile counts are stale — refresh.
      await this.loadSoilProfileLayers();
      this.renderSoilProfileLayers();
    } catch (e) {
      this.setRowResult(tableName, this.escapeHtml(e.message), true);
    }
  }

  async pruneDataset(tableName) {
    this.setRowResult(tableName, t('a.st.pruning'), false);
    try {
      const result = await api.pruneDataset(tableName);
      this.setRowResult(tableName, this.escapeHtml(result.message), false);
      this.loadEtlDatasets();
      // Profile counts on the Soil profiles tab are now stale — refresh.
      await this.loadSoilProfileLayers();
      this.renderSoilProfileLayers();
    } catch (e) {
      this.setRowResult(tableName, this.escapeHtml(e.message), true);
    }
  }

  async deleteDataset(tableName) {
    if (!confirm(t('a.etl.deleteCsvConfirm', {name: tableName}))) return;
    this.setRowResult(tableName, t('a.st.deleting'), false);
    try {
      await api.deleteDataset(tableName);
      await this.loadEtlDatasets();
    } catch (e) {
      this.setRowResult(tableName, this.escapeHtml(e.message), true);
    }
  }

  // Project-level delete (Soil profiles section). Fans out to the existing
  // per-CSV prune endpoint for each uploaded dataset belonging to the project,
  // so the soil_data rows for this project's profiles are removed without
  // touching the uploaded CSV table itself.
  async deleteProjectProfiles(projectId, projectName) {
    try {
      // Delete by project (not by csv tag), so profiles orphaned from a deleted
      // ETL dataset are removed too.
      await api.deleteSoilProfileData(projectId);
      await this.loadEtlDatasets();
      await this.loadSoilProfileLayers();
      this.renderSoilProfileLayers();
    } catch (e) {
      alert(t('a.err.deleteFailed') + (e && e.message ? e.message : e));
    }
  }

  // ==================== Administrative divisions ====================

  initAdminDivisionsTab() {
    document.getElementById('admdiv-upload-btn').addEventListener('click', () => this.uploadAdminDivision());
  }

  async loadAdminDivisions() {
    try {
      this.adminDivisions = await api.getAdminDivisionsManage();
    } catch (e) {
      console.error('Error loading administrative divisions:', e);
      this.adminDivisions = [];
    }
  }

  async uploadAdminDivision() {
    const nameEl = document.getElementById('admdiv-name');
    const fileEl = document.getElementById('admdiv-file');
    const status = document.getElementById('admdiv-upload-status');
    const name = (nameEl.value || '').trim();
    const file = fileEl.files && fileEl.files[0];
    if (!name) { status.textContent = t('a.admdiv.nameRequired'); status.style.color = '#dc3545'; return; }
    if (!file) { status.textContent = t('a.admdiv.chooseFile'); status.style.color = '#dc3545'; return; }
    status.textContent = t('a.st.uploading'); status.style.color = '#666';
    try {
      const res = await api.uploadAdminDivision(file, name);
      status.textContent = res.message; status.style.color = '#28a745';
      nameEl.value = ''; fileEl.value = '';
      await this.loadAdminDivisions();
      this.renderAdminDivisions();
    } catch (e) {
      status.textContent = t('a.err.prefix') + e.message; status.style.color = '#dc3545';
    }
  }

  renderAdminDivisions() {
    const tbody = document.getElementById('admdiv-tbody');
    if (!tbody) return;
    const rows = this.adminDivisions || [];
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="11" class="empty-state">${t('a.admdiv.none')}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(d => {
      const id = d.division_id;
      const pub = d.is_published
        ? `<span class="badge badge-success admdiv-pub" data-id="${id}" data-value="0" style="cursor:pointer;" title="${t('a.admdiv.pubTip')}">${t('a.yes')}</span>`
        : `<span class="badge badge-danger admdiv-pub" data-id="${id}" data-value="1" style="cursor:pointer;" title="${t('a.admdiv.unpubTip')}">${t('a.no')}</span>`;
      const activeBadge = (d.active_default === false)
        ? `<span class="badge badge-danger admdiv-active" data-id="${id}" data-value="1" style="cursor:pointer;" title="${t('a.sp.activeOffTip')}">${t('a.no')}</span>`
        : `<span class="badge badge-success admdiv-active" data-id="${id}" data-value="0" style="cursor:pointer;" title="${t('a.sp.activeOnTip')}">${t('a.yes')}</span>`;
      return `<tr data-id="${id}">
        <td><input type="number" class="admdiv-order" data-id="${id}" value="${d.display_order ?? 0}" min="0" max="999" style="width:64px;"></td>
        <td><input type="text" class="admdiv-name" data-id="${id}" value="${this.escapeHtml(d.name)}" style="min-width:160px;"></td>
        <td>${d.feature_count ?? '-'}</td>
        <td><input type="color" class="admdiv-stroke" data-id="${id}" value="${this.escapeHtml(d.stroke_color || '#444444')}"></td>
        <td><input type="number" class="admdiv-width" data-id="${id}" value="${d.stroke_width ?? 1.5}" min="0" max="20" step="0.5" style="width:64px;"></td>
        <td><select class="admdiv-stroke-type" data-id="${id}">
          ${[['solid', t('a.stroke.solid')], ['dashed', t('a.stroke.dashed')], ['dotted', t('a.stroke.dotted')], ['dash-dot', t('a.stroke.dashdot')]]
            .map(([v, l]) => `<option value="${v}"${(d.stroke_type || 'solid') === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select></td>
        <td><input type="color" class="admdiv-fill" data-id="${id}" value="${this.escapeHtml(d.fill_color || '#cccccc')}"></td>
        <td style="white-space:nowrap;">
          <input type="range" class="admdiv-opacity" data-id="${id}" value="${d.fill_opacity ?? 0}" min="0" max="1" step="0.05" style="width:70px;" title="${t('a.fillOpacityTip')}">
          <span class="admdiv-opacity-val" style="font-size:var(--fs-xs);color:#555;min-width:26px;">${d.fill_opacity ?? 0}</span>
        </td>
        <td>${pub}</td>
        <td>${activeBadge}</td>
        <td><button class="btn btn-sm admdiv-del" data-id="${id}" data-name="${this.escapeHtml(d.name)}" style="background:#dc3545;color:#fff;">${t('a.delete')}</button></td>
      </tr>`;
    }).join('');

    const patch = async (id, payload) => {
      try { await api.updateAdminDivision(id, payload); }
      catch (e) { alert(t('a.err.updateFailed') + e.message); }
    };
    tbody.querySelectorAll('.admdiv-order').forEach(el => el.addEventListener('change', e =>
      patch(e.target.dataset.id, { display_order: parseInt(e.target.value || '0', 10) })));
    tbody.querySelectorAll('.admdiv-name').forEach(el => el.addEventListener('change', e => {
      const v = e.target.value.trim();
      if (!v) { alert(t('a.nameEmpty')); return; }
      patch(e.target.dataset.id, { name: v });
    }));
    tbody.querySelectorAll('.admdiv-stroke').forEach(el => el.addEventListener('change', e =>
      patch(e.target.dataset.id, { stroke_color: e.target.value })));
    tbody.querySelectorAll('.admdiv-width').forEach(el => el.addEventListener('change', e =>
      patch(e.target.dataset.id, { stroke_width: parseFloat(e.target.value || '1.5') })));
    tbody.querySelectorAll('.admdiv-stroke-type').forEach(el => el.addEventListener('change', e =>
      patch(e.target.dataset.id, { stroke_type: e.target.value })));
    tbody.querySelectorAll('.admdiv-fill').forEach(el => el.addEventListener('change', e =>
      patch(e.target.dataset.id, { fill_color: e.target.value })));
    tbody.querySelectorAll('.admdiv-opacity').forEach(el => {
      const label = el.parentElement.querySelector('.admdiv-opacity-val');
      el.addEventListener('input', e => { if (label) label.textContent = e.target.value; });
      el.addEventListener('change', e =>
        patch(e.target.dataset.id, { fill_opacity: parseFloat(e.target.value || '0') }));
    });
    tbody.querySelectorAll('.admdiv-pub').forEach(el => el.addEventListener('click', async (e) => {
      await patch(e.currentTarget.dataset.id, { is_published: e.currentTarget.dataset.value === '1' });
      await this.loadAdminDivisions();
      this.renderAdminDivisions();
    }));
    tbody.querySelectorAll('.admdiv-active').forEach(el => el.addEventListener('click', async (e) => {
      await patch(e.currentTarget.dataset.id, { active_default: e.currentTarget.dataset.value === '1' });
      await this.loadAdminDivisions();
      this.renderAdminDivisions();
    }));
    tbody.querySelectorAll('.admdiv-del').forEach(el => el.addEventListener('click', async (e) => {
      const { id, name } = e.currentTarget.dataset;
      if (!confirm(t('a.admdiv.deleteConfirm', {name}))) return;
      try {
        await api.deleteAdminDivision(id);
        await this.loadAdminDivisions();
        this.renderAdminDivisions();
      } catch (err) {
        alert(t('a.err.deleteFailed') + err.message);
      }
    }));
  }

  showEtlPreview(columns, rows) {
    this.etlPreviewColumns = columns;
    this.etlPreviewRows = rows;
    this.etlPreviewPage = 0;
    this.etlPreviewPageSize = 100;
    this.etlErrorCells = this.etlErrorCells || {};
    this.etlSort = [];
    this.renderEtlPreviewPage();
  }

  etlToggleSort(col, additive) {
    if (!this.etlSort) this.etlSort = [];
    const idx = this.etlSort.findIndex(s => s.col === col);
    if (!additive) {
      // Plain click: if only this column is sorted, cycle it; else replace with asc on this column
      if (this.etlSort.length === 1 && idx === 0) {
        const dir = this.etlSort[0].dir;
        if (dir === 'asc') this.etlSort = [{ col, dir: 'desc' }];
        else this.etlSort = [];
      } else {
        this.etlSort = [{ col, dir: 'asc' }];
      }
    } else {
      // Shift+click: add or cycle this column within existing sort
      if (idx === -1) {
        this.etlSort.push({ col, dir: 'asc' });
      } else if (this.etlSort[idx].dir === 'asc') {
        this.etlSort[idx].dir = 'desc';
      } else {
        this.etlSort.splice(idx, 1);
      }
    }
    this.etlPreviewPage = 0;
    this.renderEtlPreviewPage();
  }

  renderEtlPreviewPage() {
    const thead = document.getElementById('etl-preview-thead');
    const tbody = document.getElementById('etl-preview-tbody');
    const info = document.getElementById('etl-preview-info');
    const pageInfo = document.getElementById('etl-preview-page-info');
    const prevBtn = document.getElementById('etl-preview-prev');
    const nextBtn = document.getElementById('etl-preview-next');

    const columns = this.etlPreviewColumns || [];
    const rows = this.etlPreviewRows || [];
    const pageSize = this.etlPreviewPageSize || 100;
    const total = rows.length;

    // Build index array, sort if requested — preserves original indices for error highlighting
    let order = rows.map((_, i) => i);
    const sortList = this.etlSort || [];
    if (sortList.length) {
      const asNum = v => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const getVal = (idx, col) => {
        const row = rows[idx];
        return Array.isArray(row) ? row[columns.indexOf(col)] : row[col];
      };
      order.sort((a, b) => {
        for (const { col, dir } of sortList) {
          const va = getVal(a, col), vb = getVal(b, col);
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
    }

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (this.etlPreviewPage >= totalPages) this.etlPreviewPage = totalPages - 1;
    if (this.etlPreviewPage < 0) this.etlPreviewPage = 0;
    const start = this.etlPreviewPage * pageSize;
    const end = Math.min(start + pageSize, total);

    info.textContent = t('a.etl.rowsLoaded', {n: total});
    pageInfo.textContent = t('a.etl.pageInfo', {p: this.etlPreviewPage + 1, tp: totalPages, a: start + 1, b: end});
    prevBtn.disabled = this.etlPreviewPage === 0;
    nextBtn.disabled = this.etlPreviewPage >= totalPages - 1;

    const sortIndicator = c => {
      const i = sortList.findIndex(s => s.col === c);
      if (i === -1) return '';
      const arrow = sortList[i].dir === 'asc' ? '▲' : '▼';
      const badge = sortList.length > 1 ? `<sup style="font-size:0.75em;">${i + 1}</sup>` : '';
      return ` ${arrow}${badge}`;
    };
    thead.innerHTML = '<tr><th style="width:40px;">#</th>' + columns.map(c =>
      `<th class="etl-preview-sort" data-col="${this.escapeHtml(c)}" style="cursor:pointer;user-select:none;" title="${t('a.etl.sortTip')}">${this.escapeHtml(c)}${sortIndicator(c)}</th>`
    ).join('') + '</tr>';

    thead.querySelectorAll('.etl-preview-sort').forEach(th => {
      th.addEventListener('click', (e) => this.etlToggleSort(th.dataset.col, e.shiftKey));
    });

    const errCells = this.etlErrorCells || {};
    const getErrCols = rid => {
      const cols = [];
      columns.forEach(c => {
        const set = errCells[c];
        if (set && set.has(rid)) cols.push(c);
      });
      return new Set(cols);
    };

    const html = [];
    for (let pos = start; pos < end; pos++) {
      const i = order[pos];
      const row = rows[i];
      const rid = row._row_id;
      const errSet = getErrCols(rid);
      html.push(`<tr data-rid="${rid}"><td style="color:#777;">${rid}</td>` + columns.map(c => {
        const v = row[c];
        const val = v == null ? '' : String(v);
        const cls = errSet.has(c) ? 'etl-preview-cell etl-preview-error' : 'etl-preview-cell';
        return `<td class="${cls}" contenteditable="true" data-rid="${rid}" data-col="${this.escapeHtml(c)}" data-orig="${this.escapeHtml(val)}" spellcheck="false">${this.escapeHtml(val)}</td>`;
      }).join('') + '</tr>');
    }
    tbody.innerHTML = html.join('');

    // Wire cell edits
    tbody.querySelectorAll('.etl-preview-cell').forEach(td => {
      td.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); td.blur(); }
        if (e.key === 'Escape') { td.textContent = td.dataset.orig; td.blur(); }
      });
      td.addEventListener('blur', () => this.handleEtlCellEdit(td));
    });
  }

  async handleEtlCellEdit(td) {
    const section = document.getElementById('etl-mapping-section');
    const tableName = section.dataset.tableName;
    if (!tableName) return;
    const rid = parseInt(td.dataset.rid, 10);
    const col = td.dataset.col;
    const orig = td.dataset.orig;
    const newVal = td.textContent;
    if (newVal === orig) return;
    td.style.backgroundColor = '#fff3cd';
    try {
      const result = await api.editDatasetCells(tableName, [{ row_id: rid, column: col, value: newVal }]);
      if (result.updated) {
        td.dataset.orig = newVal;
        // Update local row data
        const row = (this.etlPreviewRows || []).find(r => r._row_id === rid);
        if (row) row[col] = newVal;
        td.style.backgroundColor = '#d4edda';
        setTimeout(() => { td.style.backgroundColor = ''; }, 800);
        // Debounce revalidate
        clearTimeout(this._etlRevalidateTimer);
        this._etlRevalidateTimer = setTimeout(() => this.handleEtlValidate(), 1000);
      } else {
        td.textContent = orig;
        td.style.backgroundColor = '';
        if (result.errors && result.errors.length) {
          alert(t('a.err.updateFailed') + result.errors.join('; '));
        }
      }
    } catch (e) {
      td.textContent = orig;
      td.style.backgroundColor = '';
      alert(t('a.err.updateFailed') + e.message);
    }
  }

  showEtlMapping(tableName, columns, existingMappings) {
    const section = document.getElementById('etl-mapping-section');
    const tbody = document.getElementById('etl-mapping-tbody');
    section.dataset.tableName = tableName;

    const destOptions = this.ETL_DEST_OPTIONS;
    const cl = this.etlCodelists;
    const ss = 'font-size:var(--fs-xs);padding:2px 4px;';

    const existingMap = {};
    if (existingMappings) {
      existingMappings.forEach(m => { existingMap[m.column_name] = m; });
    }

    tbody.innerHTML = columns.map(col => {
      const existing = existingMap[col] || {};
      const selTable = existing.destination_table || '';
      const selCol = existing.destination_column || '';
      const selVal = this.etlDestValue(selTable, selCol);
      const isResult = selTable === 'result_num';

      const destOpts = '<option value="">(skip)</option>' +
        destOptions.map(o => {
          const v = `${o.table}|${o.column}`;
          const labelText = (o.required ? '* ' : '') + o.label;
          const styleAttr = o.required ? ' style="font-weight:bold;"' : '';
          return `<option value="${v}"${selVal === v ? ' selected' : ''}${styleAttr}>${this.escapeHtml(labelText)}</option>`;
        }).join('');

      const propOpts = '<option value="">—</option>' + (cl.properties || []).map(p =>
        `<option value="${p.property_num_id}" data-uri="${this.escapeHtml(p.uri || '')}"${existing.property_num_id == p.property_num_id ? ' selected' : ''}>${this.escapeHtml(p.property_name)}</option>`
      ).join('') + '<option value="__new__">+ Add Property…</option>';

      const hideResult = isResult ? '' : 'display:none;';

      const validation = existing.validation || '';
      const valColor = validation === 'OK' ? '#28a745' : (validation ? '#dc3545' : '#555');

      const linkSS = 'margin-left:4px;font-size:var(--fs-xs);text-decoration:none;';
      return `
        <tr data-col="${this.escapeHtml(col)}">
          <td><strong>${this.escapeHtml(col)}</strong></td>
          <td><select class="etl-dest" style="${ss}">${destOpts}</select></td>
          <td style="white-space:nowrap;">
            <select class="etl-prop" style="${ss}${hideResult}">${propOpts}</select>
            <a class="etl-prop-link" href="" target="_blank" rel="noopener" title="${t('a.etl.openRef')}" style="${linkSS}display:none;">↗</a>
          </td>
          <td style="white-space:nowrap;">
            <select class="etl-proc" style="${ss}${hideResult}"><option value="">—</option></select>
            <a class="etl-proc-link" href="" target="_blank" rel="noopener" title="${t('a.etl.openRef')}" style="${linkSS}display:none;">↗</a>
          </td>
          <td style="white-space:nowrap;">
            <select class="etl-unit" style="${ss}${hideResult}"><option value="">—</option></select>
            <a class="etl-unit-link" href="" target="_blank" rel="noopener" title="${t('a.etl.openRef')}" style="${linkSS}display:none;">↗</a>
          </td>
          <td class="etl-validation" style="font-size:var(--fs-xs);max-width:260px;white-space:pre-wrap;color:${valColor};vertical-align:middle;">${this.escapeHtml(validation)}</td>
        </tr>`;
    }).join('');

    // Rebuild every dest dropdown so options already used by other rows are hidden.
    // result_num|value is the only multi-use destination (one per soil-property column).
    const refreshDestDropdowns = () => {
      const allSelects = tbody.querySelectorAll('.etl-dest');
      const used = new Set();
      allSelects.forEach(s => {
        if (s.value && s.value !== 'result_num|value') used.add(s.value);
      });
      allSelects.forEach(s => {
        const current = s.value;
        const opts = ['<option value="">(skip)</option>'];
        destOptions.forEach(o => {
          const v = `${o.table}|${o.column}`;
          if (used.has(v) && v !== current) return; // hide if taken by another row
          const labelText = (o.required ? '* ' : '') + o.label;
          const styleAttr = o.required ? ' style="font-weight:bold;"' : '';
          const selected = current === v ? ' selected' : '';
          opts.push(`<option value="${v}"${selected}${styleAttr}>${this.escapeHtml(labelText)}</option>`);
        });
        s.innerHTML = opts.join('');
      });
    };
    refreshDestDropdowns();

    // Cascade: destination changes → toggle result_num extras + refilter all dropdowns
    tbody.querySelectorAll('.etl-dest').forEach(sel => {
      sel.addEventListener('change', () => {
        const tr = sel.closest('tr');
        const [table] = (sel.value || '').split('|');
        const isResult = table === 'result_num';

        tr.querySelector('.etl-prop').style.display = isResult ? '' : 'none';
        tr.querySelector('.etl-proc').style.display = isResult ? '' : 'none';
        tr.querySelector('.etl-unit').style.display = isResult ? '' : 'none';
        const propLink = tr.querySelector('.etl-prop-link');
        const procLink = tr.querySelector('.etl-proc-link');
        const unitLink = tr.querySelector('.etl-unit-link');
        if (!isResult) {
          tr.querySelector('.etl-proc').innerHTML = '<option value="">—</option>';
          tr.querySelector('.etl-unit').innerHTML = '<option value="">—</option>';
          if (propLink) propLink.style.display = 'none';
          if (procLink) procLink.style.display = 'none';
          if (unitLink) unitLink.style.display = 'none';
        } else {
          updateRefLink(tr.querySelector('.etl-prop'), '.etl-prop-link');
          updateRefLink(tr.querySelector('.etl-proc'), '.etl-proc-link');
          updateUnitLink(tr);
        }
        refreshDestDropdowns();
      });
    });

    const updateRefLink = (selectEl, linkClass) => {
      const tr = selectEl.closest('tr');
      const link = tr.querySelector(linkClass);
      if (!link) return;
      const opt = selectEl.options[selectEl.selectedIndex];
      const uri = (opt && opt.dataset && opt.dataset.uri) ? opt.dataset.uri : '';
      if (uri) {
        link.href = uri;
        link.style.display = '';
      } else {
        link.removeAttribute('href');
        link.style.display = 'none';
      }
    };

    // Initial state for prop links (procedure links are wired after async load)
    tbody.querySelectorAll('.etl-prop').forEach(sel => updateRefLink(sel, '.etl-prop-link'));

    const updateUnitLink = (tr) => {
      const link = tr.querySelector('.etl-unit-link');
      const unitSel = tr.querySelector('.etl-unit');
      if (!link || !unitSel) return;
      const uri = unitSel.dataset.canonicalUri || '';
      if (uri) {
        link.href = uri;
        link.style.display = '';
      } else {
        link.removeAttribute('href');
        link.style.display = 'none';
      }
    };

    const reloadUnits = async (tr, selectedUnit) => {
      const propId = tr.querySelector('.etl-prop').value;
      const procId = tr.querySelector('.etl-proc').value;
      const unitSel = tr.querySelector('.etl-unit');
      delete unitSel.dataset.canonicalUri;
      if (!propId || !procId) {
        unitSel.innerHTML = '<option value="">—</option>';
        updateUnitLink(tr);
        return;
      }
      unitSel.innerHTML = `<option value="">${t('a.loading')}</option>`;
      try {
        const opts = await api.getSourceUnitsForObservation(propId, procId);
        const canonical = opts.find(u => u.is_canonical);
        if (canonical && canonical.uri) unitSel.dataset.canonicalUri = canonical.uri;
        unitSel.innerHTML = '<option value="">—</option>' + opts.map(u => {
          const v = u.unit_of_measure_id;
          const sel = selectedUnit && selectedUnit === v ? ' selected' : '';
          let label;
          if (u.is_canonical) {
            label = `${v} (canonical)`;
          } else if (u.unit_to && u.operation) {
            label = `${v} → ${u.unit_to} (${u.operation}${u.value})`;
          } else {
            // Fallback "show all" entry — no conversion info to display.
            label = v;
          }
          return `<option value="${v}"${sel}>${this.escapeHtml(label)}</option>`;
        }).join('');
      } catch (e) {
        unitSel.innerHTML = '<option value="">Error</option>';
      }
      updateUnitLink(tr);
    };

    const procOptionsHtml = (procs, selectedId) => '<option value="">—</option>' +
      procs.map(p => {
        const sel = selectedId && p.procedure_num_id === selectedId ? ' selected' : '';
        return `<option value="${p.procedure_num_id}" data-uri="${this.escapeHtml(p.uri || '')}"${sel}>${this.escapeHtml(p.procedure_name)}</option>`;
      }).join('') + '<option value="__new__">+ Add Procedure…</option>';

    // Cascade: property changes → load procedures, clear units, update prop link
    tbody.querySelectorAll('.etl-prop').forEach(sel => {
      sel.addEventListener('change', async () => {
        if (sel.value === '__new__') {
          const added = await this.etlPromptAddProperty();
          if (added) {
            // Append to cached list and re-render this select (and every other
            // .etl-prop) so the new entry is visible everywhere.
            this.etlCodelists.properties = (this.etlCodelists.properties || []).concat([added]);
            this._refreshEtlPropertyDropdowns(added.property_num_id, sel);
            sel.value = added.property_num_id;
          } else {
            sel.value = '';
          }
        }
        updateRefLink(sel, '.etl-prop-link');
        const tr = sel.closest('tr');
        const procSel = tr.querySelector('.etl-proc');
        const unitSel = tr.querySelector('.etl-unit');
        const propId = sel.value;
        unitSel.innerHTML = '<option value="">—</option>';
        procSel.innerHTML = `<option value="">${t('a.loading')}</option>`;
        updateRefLink(procSel, '.etl-proc-link');
        if (!propId) {
          procSel.innerHTML = '<option value="">—</option>';
          return;
        }
        try {
          const procs = await api.getProceduresForProperty(propId);
          procSel.innerHTML = procOptionsHtml(procs, null);
        } catch (e) {
          procSel.innerHTML = '<option value="">Error</option>';
        }
        updateRefLink(procSel, '.etl-proc-link');
      });
    });

    // Cascade: procedure changes → load source-unit options + update proc link
    tbody.querySelectorAll('.etl-proc').forEach(sel => {
      sel.addEventListener('change', async () => {
        if (sel.value === '__new__') {
          const tr = sel.closest('tr');
          const propId = tr.querySelector('.etl-prop').value;
          if (!propId) {
            alert(t('a.pickPropertyAlert'));
            sel.value = '';
            return;
          }
          const added = await this.etlPromptAddProcedure(propId);
          if (added) {
            // Refresh just this row's procedure dropdown so the new entry
            // (linked to the current property via observation_num) shows up.
            try {
              const procs = await api.getProceduresForProperty(propId);
              sel.innerHTML = procOptionsHtml(procs, added.procedure_num_id);
              sel.value = added.procedure_num_id;
            } catch (e) {
              sel.value = '';
            }
          } else {
            sel.value = '';
          }
        }
        updateRefLink(sel, '.etl-proc-link');
        reloadUnits(sel.closest('tr'), null);
      });
    });


    // For existing mappings, restore procedures and units
    if (existingMappings) {
      tbody.querySelectorAll('tr[data-col]').forEach(tr => {
        const col = tr.dataset.col;
        const existing = existingMap[col];
        if (existing && existing.property_num_id) {
          const savedProc = existing.procedure_num_id;
          const savedUnit = existing.unit_of_measure_id;
          api.getProceduresForProperty(existing.property_num_id).then(procs => {
            const procSel = tr.querySelector('.etl-proc');
            procSel.innerHTML = procOptionsHtml(procs, savedProc);
            updateRefLink(procSel, '.etl-proc-link');
            if (savedProc) reloadUnits(tr, savedUnit);
          }).catch(() => {});
        }
      });
    }
  }

  // handleSaveMapping merged into handleEtlSave

  // ==================== GloSIS Federation ====================

  initGlosis() {
    const enableBtn = document.getElementById('glosis-enable-btn');
    const disableBtn = document.getElementById('glosis-disable-btn');
    const disableDeleteBtn = document.getElementById('glosis-disable-delete-btn');
    if (!enableBtn || !disableBtn || !disableDeleteBtn) return;

    enableBtn.addEventListener('click', async () => {
      try {
        await api.enableGlosis();
        await this.loadGlosis();
      } catch (e) {
        alert(t('a.err.enableFailed') + e.message);
      }
    });
    disableBtn.addEventListener('click', async () => {
      try { await api.disableGlosis(); await this.loadGlosis(); }
      catch (e) { alert(t('a.err.disableFailed') + e.message); }
    });
    disableDeleteBtn.addEventListener('click', async () => {
      if (!confirm(t('a.glosis.disableConfirm'))) return;
      try { await api.disableAndDeleteGlosis(); await this.loadGlosis(); }
      catch (e) { alert(t('a.err.failed') + e.message); }
    });

    this.renderGlosisEndpoints();
    this.loadGlosis();
  }

  renderGlosisEndpoints(apiKey) {
    const ul = document.getElementById('glosis-endpoints');
    if (!ul) return;
    const origin = window.location.origin;
    const tokenDisplay = apiKey
      ? `<code>${this.escapeHtml(apiKey)}</code>`
      : '<em>&lt;federation token — Enable to generate&gt;</em>';
    // sis-api-glosis is exposed on host port 8006 in dev. In prod (nginx-only),
    // the operator should front it under e.g. /glosis/ — show both.
    const items = [
      `<li>Manifest: <code>${origin}:8006/manifest</code> (or via nginx, <code>/glosis/manifest</code>)</li>`,
      `<li>Profiles: <code>${origin}:8006/profile</code></li>`,
      `<li>Observations: <code>${origin}:8006/observation</code></li>`,
      `<li>Header to send: <code>X-API-Key:</code> ${tokenDisplay}</li>`,
      `<li>Metadata catalogue (rasters, public): <code>${origin}:8003/collections/metadata:main/items</code></li>`,
    ];
    ul.innerHTML = items.join('');
  }

  async loadGlosis() {
    const statusEl = document.getElementById('glosis-status');
    if (!statusEl) return;
    try {
      const data = await api.getGlosisStatus();
      const enabled = !!data.enabled;
      statusEl.textContent = enabled ? t('a.enabled') : t('a.disabled');
      statusEl.style.color = enabled ? '#28a745' : '#777';
      document.getElementById('glosis-enable-btn').disabled = enabled;
      document.getElementById('glosis-disable-btn').disabled = !enabled;
      document.getElementById('glosis-disable-delete-btn').disabled = !data.token;
      this.renderGlosisEndpoints(data.token ? data.token.api_key : null);
    } catch (e) {
      statusEl.textContent = t('a.error');
      statusEl.style.color = '#c33';
    }
  }

  // ==================== Utility ====================

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Escape a value so it can appear inside a single-quoted JS string literal
  // that is itself inside an HTML attribute. Protects against payloads like
  // ');alert(1);// breaking out of the JS string and executing.
  escapeJsAttr(text) {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/"/g, '&quot;')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\r?\n/g, '\\n');
  }
}

// Create singleton instance and expose it globally for onclick handlers
const adminDashboard = new AdminDashboard();
window.adminDashboard = adminDashboard;

export default adminDashboard;