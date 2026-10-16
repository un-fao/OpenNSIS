/**
 * API Client for Soil Information System
 * Handles all API communication with authentication
 */

// Read API configuration from environment or fallback to defaults
// Parcel will replace process.env at build time
const API_BASE_URL = process.env.API_URL;
const API_KEY = process.env.API_KEY;
const MAPSERVER_URL = process.env.MAPSERVER_URL;


class SISApiClient {
  constructor() {
    this.baseURL = API_BASE_URL;
    this.apiKey = API_KEY;
    this.jwtToken = null;
  }

  /**
   * Make authenticated request with API key
   */
  // FastAPI's `detail` can be a string, a structured object (e.g. the DST
  // validation report {message, report:{errors:[…]}}), or a 422 error list.
  // Flatten any of those to a readable message instead of "[object Object]".
  _detailToMessage(detail) {
    if (detail == null) return '';
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) return detail.map(d => (d && d.msg) || JSON.stringify(d)).join('; ');
    let msg = detail.message || detail.detail || '';
    const errs = detail.report && Array.isArray(detail.report.errors) ? detail.report.errors : null;
    if (errs && errs.length) msg = (msg ? msg + ': ' : '') + errs.join('; ');
    return msg || JSON.stringify(detail);
  }

  async request(endpoint, options = {}) {
    const headers = {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
      ...options.headers
    };

    const response = await fetch(`${this.baseURL}${endpoint}`, {
      ...options,
      headers
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(this._detailToMessage(error.detail) || `API Error: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Make authenticated request with JWT token (for admin operations)
   */
  async authenticatedRequest(endpoint, options = {}) {
    if (!this.jwtToken) {
      throw new Error('Not authenticated. Please login first.');
    }

    const headers = {
      'Authorization': `Bearer ${this.jwtToken}`,
      'Content-Type': 'application/json',
      ...options.headers
    };

    const response = await fetch(`${this.baseURL}${endpoint}`, {
      ...options,
      headers
    });

    if (!response.ok) {
      if (response.status === 401) {
        this.jwtToken = null;
        localStorage.removeItem('jwt_token');
        window.dispatchEvent(new Event('auth:expired'));
        throw new Error('Session expired. Please login again.');
      }
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(this._detailToMessage(error.detail) || `API Error: ${response.status}`);
    }

    return response.json();
  }

  // ==================== Authentication ====================

  async login(email, password) {
    const response = await fetch(`${this.baseURL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: email, password })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Login failed' }));
      const msg = typeof error.detail === 'string'
        ? error.detail
        : Array.isArray(error.detail)
          ? error.detail.map(e => e.msg || JSON.stringify(e)).join('; ')
          : 'Login failed';
      throw new Error(msg);
    }

    const data = await response.json();
    this.jwtToken = data.access_token;
    localStorage.setItem('jwt_token', this.jwtToken);
    return data;
  }

  logout() {
    this.jwtToken = null;
    localStorage.removeItem('jwt_token');
  }

  isAuthenticated() {
    return !!this.jwtToken;
  }

  restoreSession() {
    const token = localStorage.getItem('jwt_token');
    if (token) {
      this.jwtToken = token;
      return true;
    }
    return false;
  }

  // ==================== Data Endpoints (API Key) ====================

  async getSettings() {
    return this.request('/api/setting');
  }

  async getLayers() {
    return this.request('/api/layer');
  }

  async getDstPixel(layerId, lon, lat) {
    return this.request(
      `/api/dst/pixel/${encodeURIComponent(layerId)}?lon=${lon}&lat=${lat}`);
  }

  async getProfiles() {
    return this.request('/api/profile');
  }

  async getProfileBlurFlags() {
    return this.request('/api/profile/blur');
  }

  async getObservations(profileCode = null) {
    const endpoint = profileCode 
      ? `/api/observation?profile_code=${encodeURIComponent(profileCode)}`
      : '/api/observation';
    return this.request(endpoint);
  }

  async getManifest() {
    return this.request('/api/manifest');
  }

  async getObservationBounds() {
    return this.request('/api/observation_bounds');
  }

  // ==================== Admin Endpoints (JWT Token) ====================

  // Settings Management
  async getAllSettings() {
    return this.authenticatedRequest('/api/setting/all');
  }

  async createSetting(key, value) {
    return this.authenticatedRequest('/api/setting', {
      method: 'POST',
      body: JSON.stringify({ key, value })
    });
  }

  async updateSetting(key, value) {
    return this.authenticatedRequest(`/api/setting/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value })
    });
  }

  async deleteSetting(key) {
    return this.authenticatedRequest(`/api/setting/${key}`, {
      method: 'DELETE'
    });
  }

  // Layer Management
  async getAllLayers() {
    return this.authenticatedRequest('/api/layer/all');
  }

  async updatePropertyColours(propertyId, body) {
    return this.authenticatedRequest(`/api/mapped-property/${encodeURIComponent(propertyId)}/colours`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async updateClassColours(mapsetId, body) {
    return this.authenticatedRequest(`/api/mapset/${encodeURIComponent(mapsetId)}/class-colours`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async updateLayerCustom(layerId, fields) {
    return this.authenticatedRequest(`/api/layer/${encodeURIComponent(layerId)}/custom`, {
      method: 'PATCH',
      body: JSON.stringify(fields)
    });
  }

  async toggleLayerPublish(layerId, publish) {
    return this.authenticatedRequest(`/api/layer/${layerId}/publish`, {
      method: 'PATCH',
      body: JSON.stringify({ publish })
    });
  }

  async deleteLayer(layerId) {
    return this.authenticatedRequest(`/api/layer/${layerId}`, {
      method: 'DELETE'
    });
  }

  async setDefaultLayer(layerId) {
    return this.authenticatedRequest(`/api/layer/${layerId}/default`, {
      method: 'PATCH'
    });
  }

  async clearDefaultLayer() {
    return this.authenticatedRequest('/api/default-layer/clear', {
      method: 'POST'
    });
  }

  // Soil profile layers (per-project)
  async getSoilProfileLayers() {
    return this.authenticatedRequest('/api/layer/soil_profiles');
  }

  async getProfileSymbology() {
    return this.request('/api/profile/symbology');
  }

  async setSoilProfileSymbology(projectId, body) {
    return this.authenticatedRequest(`/api/layer/soil_profiles/${encodeURIComponent(projectId)}/symbology`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  async setSoilProfileOrder(projectId, displayOrder) {
    return this.authenticatedRequest(`/api/layer/soil_profiles/${encodeURIComponent(projectId)}/order`, {
      method: 'PATCH',
      body: JSON.stringify({ display_order: displayOrder }),
    });
  }

  async setSoilProfileActive(projectId, activeDefault) {
    return this.authenticatedRequest(`/api/layer/soil_profiles/${encodeURIComponent(projectId)}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ active_default: activeDefault }),
    });
  }

  async setSoilProfilePublish(projectId, isPublished) {
    return this.authenticatedRequest(`/api/layer/soil_profiles/${encodeURIComponent(projectId)}/publish`, {
      method: 'PATCH',
      body: JSON.stringify({ is_published: isPublished })
    });
  }

  async setSoilProfileLimit(projectId, profileLimit) {
    return this.authenticatedRequest(`/api/layer/soil_profiles/${encodeURIComponent(projectId)}/limit`, {
      method: 'PATCH',
      body: JSON.stringify({ profile_limit: profileLimit })
    });
  }

  async setSoilProfileBlur(projectId, spatialBlurM) {
    return this.authenticatedRequest(`/api/layer/soil_profiles/${encodeURIComponent(projectId)}/blur`, {
      method: 'PATCH',
      body: JSON.stringify({ spatial_blur_m: spatialBlurM })
    });
  }

  async setSoilProfileLocationsOnly(projectId, locationsOnly) {
    return this.authenticatedRequest(`/api/layer/soil_profiles/${encodeURIComponent(projectId)}/locations-only`, {
      method: 'PATCH',
      body: JSON.stringify({ locations_only: locationsOnly })
    });
  }

  async setSoilProfileHideDownload(projectId, hideDownload) {
    return this.authenticatedRequest(`/api/layer/soil_profiles/${encodeURIComponent(projectId)}/hide-download`, {
      method: 'PATCH',
      body: JSON.stringify({ hide_download: hideDownload })
    });
  }

  async deleteSoilProfileData(projectId) {
    return this.authenticatedRequest(`/api/layer/soil_profiles/${encodeURIComponent(projectId)}/profiles`, {
      method: 'DELETE'
    });
  }

  // Dashboard
  async getDashboardStats() {
    return this.authenticatedRequest('/api/stats/dashboard');
  }

  // ==================== User Management (Admin JWT) ====================

  async verifyAuth() {
    return this.authenticatedRequest('/api/auth/verify');
  }

  async getUsers() {
    return this.authenticatedRequest('/api/users');
  }

  async getSoftwareVersion() {
    return this.authenticatedRequest('/api/admin/version');
  }

  async checkForUpdates() {
    return this.authenticatedRequest('/api/admin/update-check');
  }

  async createUser(userId, password, isAdmin = false) {
    return this.authenticatedRequest('/api/users', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, password, is_admin: isAdmin })
    });
  }

  async toggleUserAdmin(userId, isAdmin) {
    return this.authenticatedRequest(`/api/users/${encodeURIComponent(userId)}/admin?is_admin=${isAdmin}`, {
      method: 'PATCH'
    });
  }

  async toggleUserActive(userId, isActive) {
    return this.authenticatedRequest(`/api/users/${encodeURIComponent(userId)}/active?is_active=${isActive}`, {
      method: 'PATCH'
    });
  }

  async deleteUser(userId) {
    return this.authenticatedRequest(`/api/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE'
    });
  }

  // ==================== Codelist Endpoints (JWT Token) ====================

  async getOrganisations() {
    return this.authenticatedRequest('/api/codelist/organisations');
  }

  async getIndividuals() {
    return this.authenticatedRequest('/api/codelist/individuals');
  }

  async getProjects() {
    return this.authenticatedRequest('/api/codelist/projects');
  }

  async getProperties() {
    return this.authenticatedRequest('/api/codelist/properties');
  }
  async createProperty(body) {
    return this.authenticatedRequest('/api/codelist/properties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async getProcedures() {
    return this.authenticatedRequest('/api/codelist/procedures');
  }
  async createProcedure(body) {
    return this.authenticatedRequest('/api/codelist/procedures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async getUnits() {
    return this.authenticatedRequest('/api/codelist/units');
  }

  async getProceduresForProperty(propertyNumId) {
    return this.authenticatedRequest(`/api/codelist/procedures_for_property/${encodeURIComponent(propertyNumId)}`);
  }

  async getUnitsForProperty(propertyNumId) {
    return this.authenticatedRequest(`/api/codelist/units_for_property/${encodeURIComponent(propertyNumId)}`);
  }

  async getSourceUnitsForObservation(propertyNumId, procedureNumId) {
    return this.authenticatedRequest(
      `/api/codelist/source_units/${encodeURIComponent(propertyNumId)}/${encodeURIComponent(procedureNumId)}`
    );
  }

  async createProject(data) {
    return this.authenticatedRequest('/api/codelist/projects', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async updateProject(projectId, data) {
    return this.authenticatedRequest(`/api/codelist/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
  }

  // Projects management tab
  async getManagedProjects() {
    return this.authenticatedRequest('/api/projects');
  }

  async getProjectDependents(projectId) {
    return this.authenticatedRequest(`/api/projects/${encodeURIComponent(projectId)}/dependents`);
  }

  async deleteProject(projectId, actions) {
    return this.authenticatedRequest(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      body: JSON.stringify(actions || {})
    });
  }

  async createOrganisation(data) {
    return this.authenticatedRequest('/api/codelist/organisations', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async createIndividual(data) {
    return this.authenticatedRequest('/api/codelist/individuals', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // ==================== ETL Endpoints (JWT Token) ====================

  async saveEtlMetadata(metadata) {
    return this.authenticatedRequest('/api/etl/metadata', {
      method: 'PUT',
      body: JSON.stringify(metadata)
    });
  }

  async getProjectAuthors(projectId, countryId) {
    const q = countryId ? `?country_id=${encodeURIComponent(countryId)}` : '';
    return this.authenticatedRequest(`/api/etl/project/${encodeURIComponent(projectId)}/authors${q}`);
  }

  async uploadCsv(file, projectId) {
    if (!this.jwtToken) {
      throw new Error('Not authenticated. Please login first.');
    }
    const formData = new FormData();
    formData.append('file', file);
    if (projectId) formData.append('project_id', projectId);
    const response = await fetch(`${this.baseURL}/api/etl/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.jwtToken}` },
      body: formData
    });
    if (!response.ok) {
      if (response.status === 401) {
        this.jwtToken = null;
        localStorage.removeItem('jwt_token');
        window.dispatchEvent(new Event('auth:expired'));
        throw new Error('Session expired. Please login again.');
      }
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || `API Error: ${response.status}`);
    }
    return response.json();
  }

  // ==================== Administrative divisions ====================

  async getAdminDivisions() {
    return this.request('/api/admin-divisions');
  }

  async getAdminDivisionGeoJson(divisionId) {
    return this.request(`/api/admin-divisions/${divisionId}/geojson`);
  }

  async getAdminDivisionsManage() {
    return this.authenticatedRequest('/api/admin-divisions/manage');
  }

  async uploadAdminDivision(file, name) {
    if (!this.jwtToken) {
      throw new Error('Not authenticated. Please login first.');
    }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', name);
    const response = await fetch(`${this.baseURL}/api/admin-divisions/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.jwtToken}` },
      body: fd
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(this._detailToMessage(error.detail) || `API Error: ${response.status}`);
    }
    return response.json();
  }

  async updateAdminDivision(divisionId, payload) {
    return this.authenticatedRequest(`/api/admin-divisions/${divisionId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  }

  async deleteAdminDivision(divisionId) {
    return this.authenticatedRequest(`/api/admin-divisions/${divisionId}`, {
      method: 'DELETE'
    });
  }

  async getDatasets() {
    return this.authenticatedRequest('/api/etl/datasets');
  }

  async getDatasetPreview(tableName) {
    return this.authenticatedRequest(`/api/etl/datasets/${encodeURIComponent(tableName)}/preview`);
  }

  async getDatasetColumns(tableName) {
    return this.authenticatedRequest(`/api/etl/datasets/${encodeURIComponent(tableName)}/columns`);
  }

  async saveDatasetColumns(tableName, columns, epsg, projectId) {
    return this.authenticatedRequest(`/api/etl/datasets/${encodeURIComponent(tableName)}/columns`, {
      method: 'PUT',
      body: JSON.stringify({ columns, epsg, project_id: projectId || null })
    });
  }

  async ingestDataset(tableName, body) {
    return this.authenticatedRequest(`/api/etl/datasets/${encodeURIComponent(tableName)}/ingest`, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async pruneDataset(tableName) {
    return this.authenticatedRequest(`/api/etl/datasets/${encodeURIComponent(tableName)}/prune`, {
      method: 'POST'
    });
  }

  async deleteDataset(tableName) {
    return this.authenticatedRequest(`/api/etl/datasets/${encodeURIComponent(tableName)}`, {
      method: 'DELETE'
    });
  }

  async validateDataset(tableName, license) {
    return this.authenticatedRequest(`/api/etl/datasets/${encodeURIComponent(tableName)}/validate`, {
      method: 'POST',
      body: JSON.stringify({ license: license || null })
    });
  }

  async editDatasetCells(tableName, edits) {
    return this.authenticatedRequest(`/api/etl/datasets/${encodeURIComponent(tableName)}/cells`, {
      method: 'PATCH',
      body: JSON.stringify({ edits })
    });
  }

  // ==================== GloSIS Federation (Admin) ====================

  async getGlosisStatus() {
    return this.authenticatedRequest('/api/glosis/status');
  }

  async getGlosisHubStatus() {
    return this.authenticatedRequest('/api/glosis/hub/status');
  }

  async connectGlosisHub(baseUrl) {
    return this.authenticatedRequest('/api/glosis/hub/connect',
      { method: 'POST', body: JSON.stringify({ base_url: baseUrl }) });
  }

  async enableGlosis() {
    return this.authenticatedRequest('/api/glosis/enable', { method: 'POST' });
  }

  async disableGlosis() {
    return this.authenticatedRequest('/api/glosis/disable', { method: 'POST' });
  }

  async disableAndDeleteGlosis() {
    return this.authenticatedRequest('/api/glosis/disable_and_delete', { method: 'POST' });
  }

  // ==================== Raster registry ====================

  async listRasterProjects() { return this.authenticatedRequest('/api/raster/projects'); }
  async listRasterProperties() { return this.authenticatedRequest('/api/raster/properties'); }
  async listRasterIndividuals() { return this.authenticatedRequest('/api/raster/individuals'); }
  async listRasterOrganisations() { return this.authenticatedRequest('/api/raster/organisations'); }
  async listRasterCountries() { return this.authenticatedRequest('/api/raster/countries'); }
  async listRasterMappedSoilProperties() { return this.authenticatedRequest('/api/raster/mapped_soil_properties'); }
  async createRasterMappedSoilProperty(body) {
    return this.authenticatedRequest('/api/raster/mapped_soil_properties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async rasterFileExists(fileOrigName) {
    return this.authenticatedRequest(
      `/api/raster/file_exists?file_orig_name=${encodeURIComponent(fileOrigName)}`);
  }

  async listRasterUnitsForProperty(propertyNumId) {
    return this.authenticatedRequest(`/api/raster/units_for_property/${encodeURIComponent(propertyNumId)}`);
  }
  async getRasterObservationLimits(propertyNumId, unitId) {
    return this.authenticatedRequest(
      `/api/raster/observation_limits/${encodeURIComponent(propertyNumId)}/${encodeURIComponent(unitId)}`);
  }
  async createRasterProject(payload) {
    return this.authenticatedRequest('/api/raster/projects', {
      method: 'POST', body: JSON.stringify(payload)
    });
  }

  // Treat a 401 the same way authenticatedRequest does: clear the cached
  // JWT, fire auth:expired so the SPA reopens the login modal, and throw
  // a clear message instead of leaking "Could not validate credentials".
  _handle401() {
    this.jwtToken = null;
    localStorage.removeItem('jwt_token');
    window.dispatchEvent(new Event('auth:expired'));
  }

  async inspectRaster(file) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${this.baseURL}/api/raster/inspect`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.jwtToken}` },
      body: fd
    });
    if (r.status === 401) {
      this._handle401();
      throw new Error('Session expired. Please login again.');
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({ detail: r.statusText }));
      throw new Error(err.detail || `Inspect failed: ${r.status}`);
    }
    return r.json();
  }

  async registerRaster(file, formFields, overrideFilename) {
    const fd = new FormData();
    // Use FormData's filename arg to rename on the wire — avoids
    // constructing a new File() (which has wonky behaviour on large blobs
    // in some browsers).
    if (overrideFilename) {
      fd.append('file', file, overrideFilename);
    } else {
      fd.append('file', file);
    }
    for (const [k, v] of Object.entries(formFields || {})) {
      if (v != null && v !== '') fd.append(k, v);
    }
    const r = await fetch(`${this.baseURL}/api/raster/register`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.jwtToken}` },
      body: fd
    });
    if (r.status === 401) {
      this._handle401();
      throw new Error('Session expired. Please login again.');
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({ detail: r.statusText }));
      throw new Error(typeof err.detail === 'string' ? err.detail : `Register failed: ${r.status}`);
    }
    return r.json();
  }

  // ==================== DST ====================

  async listDstInputs() { return this.authenticatedRequest('/api/dst/inputs'); }
  async listDstRecipes() { return this.authenticatedRequest('/api/dst/recipes'); }
  async getDstRecipe(id) { return this.authenticatedRequest(`/api/dst/recipes/${encodeURIComponent(id)}`); }
  async createDstRecipe(payload) {
    return this.authenticatedRequest('/api/dst/recipes', {
      method: 'POST', body: JSON.stringify(payload)
    });
  }
  async updateDstRecipe(id, payload) {
    return this.authenticatedRequest(`/api/dst/recipes/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(payload)
    });
  }
  async deleteDstRecipe(id) {
    return this.authenticatedRequest(`/api/dst/recipes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  async validateDstRecipe(id) {
    return this.authenticatedRequest(`/api/dst/recipes/${encodeURIComponent(id)}/validate`, { method: 'POST' });
  }
  async runDstRecipe(id) {
    return this.authenticatedRequest(`/api/dst/recipes/${encodeURIComponent(id)}/run`, { method: 'POST' });
  }

  async updateOwnAccount(currentPassword, newUserId, newPassword) {
    const body = { current_password: currentPassword };
    if (newUserId) body.new_user_id = newUserId;
    if (newPassword) body.new_password = newPassword;
    const res = await this.authenticatedRequest('/api/users/me', {
      method: 'PATCH',
      body: JSON.stringify(body)
    });
    if (res.access_token) {
      this.jwtToken = res.access_token;
      localStorage.setItem('jwt_token', res.access_token);
    }
    return res;
  }
}

// Export singleton instance
export { MAPSERVER_URL };
export default new SISApiClient();