/**
 * Public news page (/news) — blog-style posts written in the admin
 * Website → News sub-tab: title, author, date, Markdown body (rendered and
 * sanitised server-side at save) and an optional image gallery.
 */
import api from './api-client.js';
import { t, setInstanceDefault } from './i18n.js';
import { applyNav, applyBrand, initHeaderControls, applyFooter } from './site-nav.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ISO date (YYYY-MM-DD), same in every language.
const fmtDate = (iso) => (iso || '').slice(0, 10);

let posts = [];
// Multi-select filters, same semantics as the catalogue: OR within a row,
// AND across the rows.
const selYears = new Set();
const selTags = new Set();

function post(p) {
  const imgs = (p.images || []).map((u) =>
    `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="" loading="lazy"></a>`).join('');
  const tags = (p.tags || []).map((tag) =>
    `<span class="cat-chip news-tag${selTags.has(tag) ? ' on' : ''}">${esc(tag)}</span>`).join('');
  return `
  <article class="news-post" id="post-${p.post_id}">
    <h2 class="news-post-title">${esc(p.title)}</h2>
    <p class="news-meta">${esc(p.author)} · ${esc(fmtDate(p.date))}
      ${tags ? `<span class="cat-chips" style="margin-left:10px;">${tags}</span>` : ''}</p>
    <div class="news-body">${p.body_html || ''}</div>
    ${imgs ? `<div class="news-images">${imgs}</div>` : ''}
  </article>`;
}

// Wrap occurrences of the search string in <mark>, walking only text
// nodes so the rendered HTML structure is never re-parsed.
function highlight(q) {
  if (!q) return;
  const needle = q.toLowerCase();
  document.querySelectorAll('.news-post').forEach((art) => {
    const walker = document.createTreeWalker(art, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      let i = lower.indexOf(needle);
      if (i < 0) return;
      const frag = document.createDocumentFragment();
      let pos = 0;
      while (i >= 0) {
        frag.appendChild(document.createTextNode(text.slice(pos, i)));
        const m = document.createElement('mark');
        m.textContent = text.slice(i, i + needle.length);
        frag.appendChild(m);
        pos = i + needle.length;
        i = lower.indexOf(needle, pos);
      }
      frag.appendChild(document.createTextNode(text.slice(pos)));
      node.parentNode.replaceChild(frag, node);
    });
  });
}

function render() {
  const q = document.getElementById('news-search').value.trim().toLowerCase();
  const shown = posts.filter((p) =>
    (!q || p._text.includes(q))
    && (!selYears.size || selYears.has(fmtDate(p.date).slice(0, 4)))
    && (!selTags.size || (p.tags || []).some((tag) => selTags.has(tag))));
  document.getElementById('news-count').textContent = t('site.news.count', { n: shown.length });
  document.getElementById('news-list').innerHTML = shown.map(post).join('');
  highlight(q);
  const empty = document.getElementById('news-empty');
  empty.style.display = shown.length ? 'none' : '';
  empty.textContent = t('site.news.empty');
}

function syncTagPills() {
  document.querySelectorAll('#news-filter-tags .cat-pill')
    .forEach((b) => b.classList.toggle('on', selTags.has(b.dataset.v)));
}

function fillFilters() {
  const years = [...new Set(posts.map((p) => fmtDate(p.date).slice(0, 4)).filter(Boolean))]
    .sort((a, b) => b.localeCompare(a));
  const tags = [...new Set(posts.flatMap((p) => p.tags || []))].sort();
  const fill = (id, label, values, set) => {
    const row = document.getElementById(id);
    if (!values.length) { row.style.display = 'none'; return; }
    row.innerHTML = `<span class="cat-filter-lbl">${esc(label)}:</span>`
      + values.map((v) =>
        `<button type="button" class="cat-pill" data-v="${esc(v)}" aria-pressed="false">${esc(v)}</button>`).join('');
    row.addEventListener('click', (ev) => {
      const b = ev.target.closest('.cat-pill');
      if (!b) return;
      const v = b.dataset.v;
      if (set.has(v)) set.delete(v); else set.add(v);
      b.classList.toggle('on', set.has(v));
      b.setAttribute('aria-pressed', String(set.has(v)));
      render();
    });
  };
  fill('news-filter-years', t('site.cat.year'), years, selYears);
  fill('news-filter-tags', t('site.news.tags'), tags, selTags);
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
  applyNav('news', pages, siteContent);
  document.getElementById('news-title').textContent = t('site.nav.news');

  const search = document.getElementById('news-search');
  search.placeholder = t('site.news.search');
  search.addEventListener('input', render);

  const empty = document.getElementById('news-empty');
  try {
    const data = await api.getNews();
    posts = data.posts || [];
    posts.forEach((p) => {
      p._text = [p.title, p.author, ...(p.tags || []),
        String(p.body_html || '').replace(/<[^>]+>/g, ' ')].join(' ').toLowerCase();
    });
    fillFilters();
    render();
  } catch (e) {
    console.error('News load failed:', e);
    empty.textContent = t('site.news.empty');
  }

  // A tag chip on a post toggles that tag in the filter row.
  document.getElementById('news-list').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.news-tag');
    if (!chip) return;
    const v = chip.textContent;
    if (selTags.has(v)) selTags.delete(v); else selTags.add(v);
    syncTagPills();
    render();
  });
}

init();
