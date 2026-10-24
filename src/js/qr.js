// Static QR codes generated locally. They encode the data directly, so they never expire
// and don't depend on PrivyForge staying online (unlike most "dynamic" QR services).
import QRCode from 'qrcode';
import { $, downloadBlob } from './util.js';

const TYPES = {
  url: { label: 'URL', fields: [['url', 'Website URL', 'https://example.com']] },
  text: { label: 'Text', fields: [['text', 'Text', 'Any text', 'textarea']] },
  wifi: { label: 'Wi-Fi', fields: [['ssid', 'Network name (SSID)', 'MyWiFi'], ['pass', 'Password', ''], ['enc', 'Security', 'WPA', 'select:WPA,WEP,nopass'], ['hidden', 'Hidden network', '', 'checkbox']] },
  email: { label: 'Email', fields: [['to', 'Email address', 'name@example.com'], ['subject', 'Subject', ''], ['body', 'Message', '', 'textarea']] },
  phone: { label: 'Phone', fields: [['tel', 'Phone number', '+1 555 123 4567']] },
  sms: { label: 'SMS', fields: [['tel', 'Phone number', '+1 555 123 4567'], ['msg', 'Message', '', 'textarea']] },
  vcard: { label: 'Contact', fields: [['name', 'Full name', 'Jane Doe'], ['org', 'Company', ''], ['tel', 'Phone', ''], ['email', 'Email', ''], ['url', 'Website', '']] },
};

// Wi-Fi/vCard need backslash-escaping of special characters.
const esc = (s = '') => s.replace(/([\\;,:"])/g, '\\$1');

function payload(type, v) {
  switch (type) {
    case 'url': { const u = v.url.trim(); return u && !/^[a-z]+:/i.test(u) ? `https://${u}` : u; }
    case 'text': return v.text;
    case 'wifi': return v.ssid ? `WIFI:T:${v.enc};S:${esc(v.ssid)};${v.enc !== 'nopass' ? `P:${esc(v.pass)};` : ''}${v.hidden ? 'H:true;' : ''};` : '';
    case 'email': {
      if (!v.to) return '';
      const q = new URLSearchParams(); if (v.subject) q.set('subject', v.subject); if (v.body) q.set('body', v.body);
      const s = q.toString().replace(/\+/g, '%20'); return `mailto:${v.to}${s ? `?${s}` : ''}`;
    }
    case 'phone': return v.tel ? `tel:${v.tel.replace(/[^\d+]/g, '')}` : '';
    case 'sms': return v.tel ? `SMSTO:${v.tel.replace(/[^\d+]/g, '')}:${v.msg || ''}` : '';
    case 'vcard': return v.name ? ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(v.name)}`, v.org && `ORG:${esc(v.org)}`, v.tel && `TEL:${v.tel}`, v.email && `EMAIL:${v.email}`, v.url && `URL:${v.url}`, 'END:VCARD'].filter(Boolean).join('\n') : '';
  }
  return '';
}

const tabs = $('#qr-tabs'), form = $('#qr-fields'), canvas = $('#qr-canvas'), msg = $('#qr-msg');
const style = { fg: $('#fg'), bg: $('#bg'), ecc: $('#ecc'), size: $('#size'), margin: $('#margin') };
let type = new URLSearchParams(location.search).get('type') || 'url';
if (!TYPES[type]) type = 'url';

function renderTabs() {
  tabs.innerHTML = Object.entries(TYPES).map(([k, t]) => `<button class="btn sm ${k === type ? '' : 'ghost'}" data-type="${k}" aria-pressed="${k === type}">${t.label}</button>`).join('');
}
function renderFields() {
  form.innerHTML = TYPES[type].fields.map(([name, label, ph, kind = 'input']) => {
    if (kind === 'textarea') return `<label class="field">${label}<textarea name="${name}" placeholder="${ph}"></textarea></label>`;
    if (kind === 'checkbox') return `<label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="${name}"> ${label}</label>`;
    if (kind.startsWith('select:')) return `<label class="field">${label}<select name="${name}">${kind.slice(7).split(',').map((o) => `<option>${o}</option>`).join('')}</select></label>`;
    return `<label class="field">${label}<input name="${name}" placeholder="${ph}" ${name === 'pass' ? 'type="text" autocomplete="off"' : ''}></label>`;
  }).join('');
  if (type === 'url') form.querySelector('input').value = 'https://example.com';
}
function values() {
  const v = {};
  for (const el of form.elements) v[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  return v;
}
function options(width) {
  return { errorCorrectionLevel: style.ecc.value, margin: +style.margin.value, width, color: { dark: style.fg.value, light: style.bg.value } };
}

let current = '';
async function draw() {
  current = payload(type, values());
  const empty = !current;
  $('#dl-png').disabled = $('#dl-svg').disabled = empty;
  if (empty) { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); msg.textContent = 'Fill in the fields to generate your code.'; return; }
  try {
    await QRCode.toCanvas(canvas, current, options(520));
    canvas.style.width = canvas.style.height = '260px';
    const contrastWarn = luminance(style.fg.value) > luminance(style.bg.value);
    msg.textContent = contrastWarn ? '⚠ Light code on a dark background — many scanners struggle with inverted codes.' : `${current.length} characters · scan with any phone camera.`;
  } catch (e) { msg.textContent = `Too much data for a QR code (${e.message}).`; }
}
function luminance(hex) {
  const [r, g, b] = hex.match(/\w\w/g).map((x) => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

tabs.addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]'); if (!b) return;
  type = b.dataset.type; renderTabs(); renderFields(); draw();
});
form.addEventListener('input', draw);
Object.values(style).forEach((el) => el.addEventListener('input', draw));

$('#dl-png').onclick = async () => {
  const c = document.createElement('canvas');
  await QRCode.toCanvas(c, current, options(+style.size.value));
  c.toBlob((b) => downloadBlob(b, `qr-${type}.png`), 'image/png');
};
$('#dl-svg').onclick = async () => {
  const svg = await QRCode.toString(current, { ...options(+style.size.value), type: 'svg' });
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `qr-${type}.svg`);
};

renderTabs(); renderFields(); draw();
