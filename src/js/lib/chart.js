// Tiny dependency-free line chart for calculators. Colors come from CSS tokens.
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export const fmtMoneyShort = (v) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`);

/**
 * @param {HTMLCanvasElement} cv
 * @param {{values:number[], color:string, dash?:number[]}[]} series  color = CSS var name or color
 * @param {{xLabel:(i:number)=>string, xTicks?:number, yFormat?:(v:number)=>string, minZero?:boolean}} o
 */
export function lineChart(cv, series, o = {}) {
  const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);
  const len = Math.max(...series.map((s) => s.values.length));
  if (!len) return;
  const all = series.flatMap((s) => s.values);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (o.minZero !== false) lo = Math.min(0, lo);
  if (hi === lo) hi = lo + 1;
  const pad = { l: 58, r: 14, t: 12, b: 26 };
  const x = (i) => pad.l + (i / Math.max(1, len - 1)) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - ((v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const yf = o.yFormat || fmtMoneyShort;
  ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) / 4) * k, yy = y(v);
    ctx.strokeStyle = css('--line'); ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    ctx.fillStyle = css('--ink-2'); ctx.fillText(yf(v), 4, yy + 4);
  }
  if (lo < 0) { ctx.strokeStyle = css('--ink-2'); ctx.beginPath(); ctx.moveTo(pad.l, y(0)); ctx.lineTo(W - pad.r, y(0)); ctx.stroke(); }
  const ticks = o.xTicks || 6, step = o.xStep || Math.max(1, Math.ceil(len / ticks));
  ctx.fillStyle = css('--ink-2');
  for (let i = step - 1; i < len; i += step) ctx.fillText(o.xLabel ? o.xLabel(i) : String(i + 1), Math.min(W - pad.r - 34, x(i) - 12), H - 8);
  for (const s of series) {
    ctx.beginPath(); ctx.strokeStyle = s.color.startsWith('--') ? css(s.color) : s.color; ctx.lineWidth = 2.5;
    ctx.setLineDash(s.dash || []);
    s.values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/** x-axis step + label for month-indexed series: whole years once the span passes 2 years. */
export function monthAxis(len, offset = 0) {
  if (len <= 24) return { xStep: Math.max(1, Math.ceil(len / 6)), xLabel: (i) => `${i + offset}mo` };
  const yrs = Math.max(1, Math.ceil(len / 12 / 6));
  return { xStep: 12 * yrs, xLabel: (i) => `Yr ${Math.round((i + offset) / 12)}` };
}

export const money = (n, d = 0) => (Number.isFinite(n) ? n : 0).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: d, minimumFractionDigits: d });

export function monthsToText(m) {
  if (!Number.isFinite(m)) return 'never';
  const y = Math.floor(m / 12), r = m % 12;
  return [y && `${y} yr`, r && `${r} mo`].filter(Boolean).join(' ') || '0 mo';
}

export function dateAfterMonths(m) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + m);
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/** Restore/persist a form's inputs in the URL so scenarios can be bookmarked and shared. */
export function syncFormWithURL(form, skip = []) {
  const qs = new URLSearchParams(location.search);
  for (const el of form.elements) if (el.name && qs.has(el.name) && !skip.includes(el.name)) {
    if (el.type === 'checkbox') el.checked = qs.get(el.name) === '1'; else el.value = qs.get(el.name);
  }
  return () => {
    const p = new URLSearchParams();
    for (const el of form.elements) if (el.name && !skip.includes(el.name)) p.set(el.name, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
    history.replaceState(null, '', `?${p}`);
  };
}
