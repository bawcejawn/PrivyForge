import QRCode from 'qrcode';
import { SUPPORT } from './config.js';
import { $ } from './util.js';

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const links = SUPPORT.links.filter((l) => /^https:\/\//.test(l.url));
const crypto = SUPPORT.crypto.filter((c) => c.address);

$('#links').innerHTML = links.length
  ? links.map((l) => `<a class="btn" href="${esc(l.url)}" rel="noopener" target="_blank">${esc(l.label)}</a>`).join(' ')
  : '<p class="status">Support links coming soon. Sharing PrivyForge with a friend helps just as much.</p>';

if (crypto.length) {
  $('#crypto-wrap').hidden = false;
  $('#crypto').innerHTML = crypto.map((c, i) => `
    <div class="kpi" style="display:grid;grid-template-columns:96px 1fr;gap:12px;align-items:center">
      <canvas width="96" height="96" data-i="${i}" aria-label="QR code for ${esc(c.chain)} address"></canvas>
      <div style="min-width:0"><span>${esc(c.chain)}</span><code style="display:block;word-break:break-all;margin:4px 0">${esc(c.address)}</code>
      <button class="btn sm ghost" data-copy="${i}">Copy address</button></div>
    </div>`).join('');
  crypto.forEach((c, i) => QRCode.toCanvas($(`canvas[data-i="${i}"]`), c.address, { width: 96, margin: 1 }));
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const a = crypto[+b.dataset.copy].address;
    try { await navigator.clipboard.writeText(a); b.textContent = 'Copied ✓'; } catch { prompt('Copy:', a); }
  }));
}
