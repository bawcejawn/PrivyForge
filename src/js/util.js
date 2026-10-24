export const $ = (sel, root = document) => root.querySelector(sel);

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const baseName = (name) => name.replace(/\.[^.]+$/, '');

/** Wire a .drop element to a hidden file input + drag/drop + paste. */
export function setupDropzone(drop, { accept, multiple = true, onFiles }) {
  const input = drop.querySelector('input[type=file]');
  input.accept = accept === '*/*' ? '' : accept; input.multiple = multiple;
  const filter = (list) => [...list].filter((f) => accept === '*/*' || accept.split(',').some((a) => {
    a = a.trim();
    return a.startsWith('.') ? f.name.toLowerCase().endsWith(a) : a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.type === a;
  }));
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { const f = filter(input.files); if (f.length) onFiles(f); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const f = filter(e.dataTransfer.files); if (f.length) onFiles(f);
  });
  document.addEventListener('paste', (e) => {
    const f = filter([...(e.clipboardData?.files || [])]); if (f.length) onFiles(f);
  });
}

/** Parse "1-3, 5, 8-" into zero-based page index groups. Returns null on bad input. */
export function parseRanges(str, pageCount) {
  const groups = [];
  for (const part of str.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*(-)?\s*(\d*)$/);
    if (!m) return null;
    let a = m[1] ? +m[1] : 1;
    let b = m[2] ? (m[3] ? +m[3] : pageCount) : a;
    if (a < 1 || b > pageCount || a > b) return null;
    groups.push(Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i));
  }
  return groups.length ? groups : null;
}
