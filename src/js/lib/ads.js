// Consent-gated AdSense loader.
//
// Modes (src/data/site.json → ads.consent):
//   "banner"      (default) PrivyForge's own banner. The AdSense script is NOT requested until the
//                 visitor clicks Accept. Decline → no ad script, ever (until they change their mind).
//   "google-cmp"  Use Google's certified CMP (AdSense → Privacy & messaging). Google delivers its
//                 consent message through the AdSense tag itself, so the tag loads, but PrivyForge
//                 fills no ad slots until Google reports consent is known (googlefc CONSENT_DATA_READY).
// With no AdSense publisher ID configured, nothing loads in any mode.

const KEY = 'pf:consent';
export const getConsent = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const setConsent = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };

/** Pure decision helper (unit-tested). */
export function decideAds({ client, mode = 'banner', consent }) {
  if (!client || !/^ca-pub-\d{10,20}$/.test(client)) return 'off';
  if (mode === 'google-cmp') return 'load-await-cmp';
  if (consent === 'granted') return 'load';
  if (consent === 'denied') return 'declined';
  return 'ask';
}

function injectScript(client) {
  if (document.querySelector('script[data-pf-adsense]')) return;
  const s = document.createElement('script');
  s.async = true; s.crossOrigin = 'anonymous'; s.dataset.pfAdsense = '1';
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
  document.head.appendChild(s);
}

/** Fill slots lazily as they approach the viewport. */
function fillSlots(slots, client, units) {
  // Hidden elements never intersect: reveal slots that have an ad unit (they reserve space via CSS).
  slots.forEach((s) => { s.hidden = !/^\d{6,12}$/.test(units[s.dataset.slot] || ''); });
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const unit = units[e.target.dataset.slot];
      if (!unit || !/^\d{6,12}$/.test(unit)) { e.target.hidden = true; continue; }
      e.target.hidden = false;
      const ins = document.createElement('ins');
      Object.assign(ins, { className: 'adsbygoogle' });
      ins.style.display = 'block';
      Object.assign(ins.dataset, { adClient: client, adSlot: unit, adFormat: 'auto', fullWidthResponsive: 'true' });
      e.target.replaceChildren(ins);
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    }
  }, { rootMargin: '300px' });
  slots.filter((s) => !s.hidden).forEach((s) => io.observe(s));
}

/** Wait for Google's CMP to know the consent state. Resolves after a timeout too: the ad
 *  requests themselves carry the TCF signal, so AdSense still honours the user's choice. */
function whenCmpReady(timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false; const finish = () => { if (!done) { done = true; resolve(); } };
    window.googlefc = window.googlefc || {};
    window.googlefc.callbackQueue = window.googlefc.callbackQueue || [];
    window.googlefc.callbackQueue.push({ CONSENT_DATA_READY: finish });
    setTimeout(finish, timeoutMs);
  });
}

function showBanner(onChoice) {
  if (document.getElementById('pf-consent')) return;
  const box = document.createElement('div');
  box.id = 'pf-consent'; box.className = 'consent'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Cookie choices');
  box.innerHTML = `<p><b>Ads keep PrivyForge free.</b> With your OK, Google may use cookies to show and measure ads. Your files and numbers are never shared — they never leave your device. <a href="/privacy/">Privacy policy</a></p>
    <div class="row-actions" style="margin:0"><button class="btn sm" data-c="granted">Accept ads cookies</button><button class="btn sm ghost" data-c="denied">No thanks</button></div>`;
  box.addEventListener('click', (e) => { const c = e.target.closest('[data-c]')?.dataset.c; if (c) { box.remove(); onChoice(c); } });
  document.body.appendChild(box);
}

export function initAds({ client, mode, units, dev }) {
  const slots = [...document.querySelectorAll('.ad-slot[data-slot]')];
  const decision = decideAds({ client, mode, consent: getConsent() });
  const hideAll = () => slots.forEach((s) => { s.hidden = true; });

  if (decision === 'off') {
    if (dev) slots.forEach((s) => { s.classList.add('placeholder'); s.textContent = `Ad slot: ${s.dataset.slot}`; });
    else hideAll();
    return decision;
  }
  hideAll(); // slots appear only once an ad is actually requested
  const go = () => { injectScript(client); fillSlots(slots, client, units || {}); };

  if (decision === 'load') go();
  else if (decision === 'load-await-cmp') { injectScript(client); whenCmpReady().then(() => fillSlots(slots, client, units || {})); }
  else if (decision === 'ask') showBanner((c) => { setConsent(c); if (c === 'granted') go(); });

  // "Cookie choices" link in the footer lets visitors change their mind (banner mode only).
  if (mode !== 'google-cmp') {
    const foot = document.querySelector('.site-footer .wrap > p');
    if (foot && !document.querySelector('[data-pf-consent-link]')) {
      const a = document.createElement('a'); a.href = '#'; a.textContent = 'Cookie choices'; a.dataset.pfConsentLink = '1';
      a.onclick = (e) => { e.preventDefault(); try { localStorage.removeItem(KEY); } catch { /* */ } location.reload(); };
      foot.append(' · ', a);
    }
  }
  return decision;
}
