// Runs on every page: nav state, ad slots, offline indicator.
import { MONETIZATION } from './config.js';

for (const a of document.querySelectorAll('.nav a')) {
  if (a.getAttribute('href') === location.pathname) a.setAttribute('aria-current', 'page');
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
