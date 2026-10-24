// On-device storage for the personal dashboard. Never synced or sent anywhere.
// Every access is guarded: private windows and blocked storage must not break tools.
const NS = 'pf:';

export function get(key, fallback) {
  try { const v = localStorage.getItem(NS + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function set(key, value) {
  try { localStorage.setItem(NS + key, JSON.stringify(value)); return true; } catch { return false; }
}
export function remove(key) { try { localStorage.removeItem(NS + key); } catch { /* ignore */ } }

// ---- favorites
export const favorites = () => get('favorites', []);
export function toggleFavorite(slug) {
  const f = favorites(); const i = f.indexOf(slug);
  if (i === -1) f.unshift(slug); else f.splice(i, 1);
  set('favorites', f); return i === -1;
}

// ---- recent tools (most recent first, max 8)
export const recent = () => get('recent', []);
export function touchRecent(slug) {
  const r = recent().filter((x) => x.slug !== slug);
  r.unshift({ slug, at: Date.now() });
  set('recent', r.slice(0, 8));
}

// ---- saved scenarios: { id, name, tool, url, savedAt }
export const scenarios = () => get('scenarios', []);
export function saveScenario({ name, tool, url }) {
  const list = scenarios();
  const item = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: String(name).slice(0, 80), tool, url, savedAt: Date.now() };
  list.unshift(item); set('scenarios', list.slice(0, 100)); return item;
}
export function updateScenario(id, patch) { set('scenarios', scenarios().map((s) => (s.id === id ? { ...s, ...patch } : s))); }
export function deleteScenario(id) { set('scenarios', scenarios().filter((s) => s.id !== id)); }

// ---- money checkup progress
export const checkup = () => get('checkup', {});
export function setCheck(step, done) { const c = checkup(); c[step] = done; set('checkup', c); }

// ---- backup
const KEYS = ['favorites', 'recent', 'scenarios', 'checkup'];
export function exportAll() { return { app: 'PrivyForge', version: 1, exportedAt: new Date().toISOString(), data: Object.fromEntries(KEYS.map((k) => [k, get(k, null)])) }; }
export function importAll(obj) {
  if (!obj || obj.app !== 'PrivyForge' || typeof obj.data !== 'object') throw new Error('Not a PrivyForge backup file.');
  for (const k of KEYS) {
    const v = obj.data[k];
    if (v == null) continue;
    // shape checks so a hand-edited file can't break the dashboard
    if (k === 'checkup' ? typeof v !== 'object' || Array.isArray(v) : !Array.isArray(v)) throw new Error(`Invalid "${k}" in backup.`);
    set(k, v);
  }
}
export function clearAll() { KEYS.forEach(remove); }

/** Only allow same-site relative URLs to be stored/opened as scenarios. */
export function safeLocalUrl(u) {
  try { const x = new URL(u, location.origin); return x.origin === location.origin ? x.pathname + x.search + x.hash : null; } catch { return null; }
}
