// File hashing with the browser's built-in WebCrypto. Nothing leaves the device.
export const ALGOS = ['SHA-256', 'SHA-1', 'SHA-384', 'SHA-512'];

export const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hashBuffer(buf, algo = 'SHA-256') {
  return toHex(await crypto.subtle.digest(algo, buf));
}

/** Normalize a pasted hash: strip spaces, "sha256:" prefixes, filenames from `sha256sum` output. */
export function cleanHash(s) {
  const t = String(s || '').trim().toLowerCase().replace(/^(sha-?\d+|md5)[:=\s]+/, '');
  const m = t.match(/[0-9a-f]{32,128}/);
  return m ? m[0] : '';
}

/** Which algorithm a hex digest length implies. */
export function algoForLength(hex) {
  return { 40: 'SHA-1', 64: 'SHA-256', 96: 'SHA-384', 128: 'SHA-512', 32: 'MD5' }[hex.length] || null;
}

/** Constant-time-ish comparison (avoids early exit; mostly for correctness, not secrecy). */
export function sameHash(a, b) {
  a = cleanHash(a); b = cleanHash(b);
  if (!a || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
