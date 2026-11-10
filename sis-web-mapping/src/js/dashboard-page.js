/**
 * Public dashboard page (/dashboard) — the statistics formerly in the admin
 * panel's Dashboard tab, now public: aggregate counts and charts over the
 * instance's soil data. Reads /api/stats/dashboard with the SPA API key.
 */
import Chart from 'chart.js/auto';
import api from './api-client.js';
import { t } from './i18n.js';
import { applyNav, applyBrand, initHeaderControls } from './site-nav.js';

let _charts = {};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function markup() {
  return `
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
    </div>`;
}

function renderDashboardCards(tt) {
    const grid = document.getElementById('stat-card-grid');
    if (!grid) return;
    const fmt = (n) => Number(n || 0).toLocaleString();
    const cards = [
      { label: 'Projects', value: fmt(tt.project_count), accent: 'c' },
      { label: 'Profiles', value: fmt(tt.profile_count), accent: 'a' },
      { label: 'Properties', value: fmt(tt.property_count), accent: 'd' },
      { label: 'Measurements', value: fmt(tt.observation_count), accent: 'b' },
      { label: 'Rasters', value: fmt(tt.raster_count), accent: 'c' },
    ];
    grid.innerHTML = cards.map(c => `
      <div class="stat-card stat-card-${c.accent}">
        <div class="stat-card-value">${esc(c.value)}</div>
        <div class="stat-card-label">${esc(c.label)}</div>
      </div>
    `).join('');
  }

function renderDashboardCharts(stats) {
    if (_charts) {
      Object.values(_charts).forEach(c => c && c.destroy && c.destroy());
    }
    _charts = {};

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
    _charts.profilesPerProject = new Chart(
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
    _charts.rastersPerProject = new Chart(
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
    _charts.topProperties = new Chart(
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
    _charts.profilesPerYear = new Chart(
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
    _charts.depthDistribution = new Chart(
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
    _charts.valueSummary = new Chart(
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

async function init() {
  let pages = null;
  let siteContent = null;
  try {
    const site = (await api.getSite()) || {};
    siteContent = site.content;
    pages = siteContent?.pages;
    applyBrand(site);
  } catch (e) { /* nav stays muted */ }
  initHeaderControls();
  applyNav('dashboard', pages, siteContent);
  document.getElementById('dash-title').textContent = t('site.nav.dashboard');

  const empty = document.getElementById('dashboard-empty');
  const content = document.getElementById('dashboard-content');
  try {
    const stats = await api.getDashboardStats();
    content.innerHTML = markup();
    renderDashboardCards(stats.totals || {});
    renderDashboardCharts(stats);
    empty.style.display = 'none';
    content.style.display = '';
  } catch (e) {
    console.error('Dashboard load failed:', e);
    empty.textContent = t('a.dash.loadFailed') + (e.message || e);
  }
}

init();
