// Runs on every page: nav state, ad slots, offline indicator, favorites/recent/saved scenarios.
import { MONETIZATION } from './config.js';
import tools from '../data/tools.json';
import { favorites, toggleFavorite, touchRecent, saveScenario } from './lib/store.js';

for (const a of document.querySelectorAll('.nav a')) {
  if (a.getAttribute('href') === location.pathname) a.setAttribute('aria-current', 'page');
}

// ---- Personal dashboard hooks (all stored on this device only; see /my/)
const BASE = import.meta.env.BASE_URL; // '/' or '/<repo>/' on GitHub Pages
const here = '/' + location.pathname.slice(BASE.length).replace(/^\/?/, '');
const tool = tools.find((t) => t.enabled !== false && !t.href.includes('?') && t.href === here);
if (tool) {
  touchRecent(tool.slug);
  const h1 = document.querySelector('main h1');
  if (h1) {
    const fav = document.createElement('button');
    fav.type = 'button'; fav.className = 'btn ghost sm fav-btn';
    const paint = (on) => { fav.setAttribute('aria-pressed', on); fav.textContent = on ? '★ Saved to My PrivyForge' : '☆ Add to favorites'; };
    paint(favorites().includes(tool.slug));
    fav.onclick = () => paint(toggleFavorite(tool.slug));
    h1.after(fav);
    // Calculators keep their inputs in the URL, so a scenario is just the current link.
    if (['Finance', 'Save money'].includes(tool.category) && tool.slug !== 'subscription-finder') {
      const save = document.createElement('button');
      save.type = 'button'; save.className = 'btn ghost sm fav-btn';
      save.textContent = '💾 Save this scenario';
      save.onclick = () => {
        const name = prompt('Name this scenario (saved only on this device):', `${tool.title} — ${new Date().toLocaleDateString()}`);
        if (!name) return;
        saveScenario({ name, tool: tool.slug, url: location.pathname + location.search });
        save.textContent = '✓ Saved — see My PrivyForge';
        setTimeout(() => { save.textContent = '💾 Save this scenario'; }, 2500);
      };
      fav.after(save);
    }
  }
}

// ---- Ads: load AdSense lazily, only if configured, only when a slot nears the viewport.
const slots = [...document.querySelectorAll('.ad-slot[data-slot]')];
const client = MONETIZATION.ADSENSE_CLIENT;
if (!client) {
  if (import.meta.env.DEV && MONETIZATION.SHOW_PLACEHOLDERS_IN_DEV) {
    slots.forEach((s) => { s.classList.add('placeholder'); s.textContent = `Ad slot: ${s.dataset.slot}`; });
  } else {
    slots.forEach((s) => { s.hidden = true; }); // no ads configured yet -> no empty gaps
  }
} else if (slots.length) {
  let loaded = false;
  const loadScript = () => {
    if (loaded) return; loaded = true;
    const s = document.createElement('script');
    s.async = true; s.crossOrigin = 'anonymous';
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}`;
    document.head.appendChild(s);
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const unit = MONETIZATION.SLOTS[e.target.dataset.slot];
      if (!unit) continue;
      loadScript();
      e.target.innerHTML = `<ins class="adsbygoogle" style="display:block" data-ad-client="${client}" data-ad-slot="${unit}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    }
  }, { rootMargin: '300px' });
  slots.forEach((s) => io.observe(s));
}

// ---- Offline indicator: proves the "nothing is uploaded" claim in a way users can test.
const pill = document.querySelector('[data-offline-pill]');
const updatePill = () => {
  if (!pill) return;
  pill.textContent = navigator.onLine ? '⚡ Works offline after first visit' : '✈ You are offline — the tool still works';
};
addEventListener('online', updatePill); addEventListener('offline', updatePill); updatePill();
