import { hashBuffer, cleanHash, algoForLength, sameHash, ALGOS } from './lib/hash.js';
import { $, setupDropzone, formatBytes, downloadBlob } from './util.js';

const list = $('#files'), expected = $('#expected'), algoSel = $('#algo');
const items = []; // { file, hashes: {algo: hex} }
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

setupDropzone($('#drop'), { accept: '*/*', onFiles: add });

async function add(files) {
  for (const file of files) {
    const item = { file, hashes: {} };
    items.push(item);
    item.row = document.createElement('li'); item.row.className = 'file';
    list.append(item.row);
    await compute(item);
  }
}

async function compute(item) {
  const algo = algoSel.value;
  render(item, 'hashing…');
  if (item.file.size > 2 * 1024 ** 3) return render(item, 'Files over 2 GB are too large to hash in a browser tab.');
  try {
    item.hashes[algo] ||= await hashBuffer(await item.file.arrayBuffer(), algo);
    render(item);
  } catch (e) { render(item, `Couldn't read this file (${e.message}).`); }
}

function render(item, msg) {
  const algo = algoSel.value, h = item.hashes[algo];
  const want = cleanHash(expected.value);
  let verdict = '';
  if (h && want) {
    const wantAlgo = algoForLength(want);
    verdict = sameHash(h, want) ? '<span class="save">✓ Match — file is intact</span>'
      : wantAlgo && wantAlgo !== algo ? `<span style="color:var(--warn)">That looks like a ${wantAlgo} hash — switch the algorithm above.</span>`
        : '<span style="color:var(--err)">✗ No match — the file differs from the original</span>';
  }
  item.row.innerHTML = `
    <div class="thumb" aria-hidden="true">${esc((item.file.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase())}</div>
    <div style="min-width:0"><div class="name">${esc(item.file.name)}</div>
      <div class="meta">${formatBytes(item.file.size)} · ${algo}</div>
      <div class="meta" style="word-break:break-all;color:var(--ink)">${msg ? esc(msg) : h}</div>
      ${verdict ? `<div class="meta">${verdict}</div>` : ''}</div>
    <div class="act">${h ? '<button class="btn sm ghost" data-copy>Copy</button> <button class="btn sm" data-proof title="Download a timestamped receipt">Proof</button>' : ''}</div>`;
  item.row.querySelector('[data-copy]')?.addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(h); e.target.textContent = 'Copied ✓'; } catch { prompt('Copy:', h); }
  });
  item.row.querySelector('[data-proof]')?.addEventListener('click', () => proof(item));
}

// A local "proof of existence" receipt. For an independent, tamper-evident timestamp,
// users can submit this hash (never the file) to a public timestamping service.
async function proof(item) {
  const sha256 = item.hashes['SHA-256'] ||= await hashBuffer(await item.file.arrayBuffer(), 'SHA-256');
  const receipt = {
    type: 'PrivyForge file fingerprint',
    file: item.file.name, bytes: item.file.size,
    lastModified: new Date(item.file.lastModified).toISOString(),
    sha256, createdAt: new Date().toISOString(),
    note: 'This fingerprint was computed on the owner\'s device. The file itself was never uploaded. Anyone holding the original file can recompute SHA-256 and compare.',
  };
  downloadBlob(new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' }), `${item.file.name}.sha256-proof.json`);
}

algoSel.addEventListener('change', () => items.forEach(compute));
expected.addEventListener('input', () => {
  const a = algoForLength(cleanHash(expected.value));
  if (a && a !== algoSel.value && ALGOS.includes(a)) { algoSel.value = a; items.forEach(compute); }
  else items.forEach((i) => render(i));
});
