/**
 * Shared navigation wiring for the public pages (landing, dashboard,
 * standalone pages). Labels from i18n; About/People/Contact stay muted
 * "coming soon" until the published content carries that page, then they
 * become real links.
 */
import { t } from './i18n.js';

const PAGE_IDS = { about: 'nav-about', people: 'nav-people', contact: 'nav-contact' };

export function applyNav(current, pages) {
  const items = [['nav-home', 'site.nav.home', '/'], ['nav-about', 'site.nav.about', '/about'],
                 ['nav-map', 'site.nav.map', '/map'], ['nav-catalogue', 'site.nav.catalogue', null],
                 ['nav-dashboard', 'site.nav.dashboard', '/dashboard'],
                 ['nav-people', 'site.nav.people', '/people'],
                 ['nav-contact', 'site.nav.contact', '/contact']];
  items.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = t(key);
    if (el.classList.contains('nav-soon')) el.title = t('site.comingSoon');
    if (id === `nav-${current}`) el.classList.add('nav-current');
  });
  Object.entries(PAGE_IDS).forEach(([slug, id]) => {
    const el = document.getElementById(id);
    if (!el || !pages || !pages[slug]) return;
    // Published content exists: the muted placeholder becomes a real link.
    const a = document.createElement('a');
    a.id = el.id;
    a.href = `/${slug}`;
    a.className = el.className.replace('nav-soon', '').trim() + ' nav-link';
    a.textContent = el.textContent;
    if (`nav-${current}` === id) a.classList.add('nav-current');
    el.replaceWith(a);
  });
}
