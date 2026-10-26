// HEIC/HEIF decoding for the image tools.
import { looksLikeHeic, sniffHeic, markPrimaryOnly, HEIC_TO_VERSION } from './lib/heic.js';

// Fast path: browsers that decode HEIC themselves (Safari) use createImageBitmap, like any image.
// Everywhere else (Chrome, Edge, Firefox) we lazy-load heic-to (libheif compiled to WebAssembly)
// the first time a HEIC photo is actually added. It runs in its own Web Worker, entirely on
// this device: the photo is never uploaded.
//
// Licensing: heic-to and libheif are LGPL-3.0. We ship heic-to's published "csp" build
// byte-for-byte unmodified as its own file, vendor/heic-to/ — copied from node_modules at build by vite.config.js (tests/heic.test.js checks
// it matches node_modules), with its license, and import it at runtime only when needed, so
// anyone can swap in their own build of the library. The "csp" build needs no 'unsafe-eval'.
// It lives in public/ as .mjs (not bundled by Vite) so the service worker doesn't precache
// 3 MB for every visitor, but caches it on first use (runtime rule for *.mjs in vite.config.js).
const heicToUrl = `${import.meta.env.BASE_URL}vendor/heic-to/heic-to-csp-${HEIC_TO_VERSION}.mjs`;

/** True if the file is HEIC/HEIF, by name/MIME or by its ftyp brands (catches wrong extensions). */
export async function isHeicFile(file) {
  if (looksLikeHeic(file.name, file.type)) return true;
  try { return sniffHeic(new Uint8Array(await file.slice(0, 64).arrayBuffer())); } catch { return false; }
}

// A 402-byte 64x64 HEIC: if the browser can decode it, it can decode iPhone photos too.
const HEIC_PROBE = 'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAVZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABegABAAAAAAAAABgAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA1mlwcnAAAAC3aXBjbwAAAHhodmNDAQNwAAAAkAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQArQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbqSSmubgIaDAgAAAMAyAAAAwAIQGIAAQAHRAHBcrAiQAAAABNjb2xybmNseAABAA0ABoAAAAAUaXNwZQAAAAAAAABAAAAAQAAAABBwaXhpAAAAAAMICAgAAAAXaXBtYQAAAAAAAAABAAEEgQIDBAAAACBtZGF0AAAAFCgBrwQY/Hk46//uPj91wFtDxHQ4';
let native;
/** Resolves true when this browser decodes HEIC natively (checked once, ~1 ms in Safari). */
export function nativeHeic() {
  return (native ||= (async () => {
    try {
      const bytes = Uint8Array.from(atob(HEIC_PROBE), (c) => c.charCodeAt(0));
      const bmp = await Promise.race([
        createImageBitmap(new Blob([bytes], { type: 'image/heic' })),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
      ]);
      const ok = bmp.width === 64 && bmp.height === 64; bmp.close?.();
      return ok;
    } catch { return false; }
  })());
}

let lib;
export class DecoderLoadError extends Error {}
/** Loads heic-to once. Rejects with DecoderLoadError if the file can't be fetched (e.g. offline). */
export function loadHeicDecoder() {
  return (lib ||= import(/* @vite-ignore */ heicToUrl).catch((e) => {
    lib = null; // let the next photo try again
    throw new DecoderLoadError(`Couldn't load the HEIC decoder: ${e?.message || e}`);
  }));
}

/**
 * Decodes a HEIC/HEIF file to an ImageBitmap with libheif (rotation/mirroring from the file
 * applied). Multi-image files (bursts, edited photos): only the primary image is decoded;
 * markPrimaryOnly() hides the others because heic-to would otherwise take the first one.
 */
export async function decodeHeic(file) {
  const [{ heicTo }, buf] = await Promise.all([loadHeicDecoder(), file.arrayBuffer()]);
  const bytes = new Uint8Array(buf);
  markPrimaryOnly(bytes); // our copy of the bytes; the user's file is untouched
  try {
    return await heicTo({ blob: new Blob([bytes]), type: 'bitmap' });
  } catch (e) {
    // heic-to rejects with plain strings / ErrorEvents; normalize.
    throw Object.assign(new Error(typeof e === 'string' ? e : e?.message || 'HEIC decode failed'), { heic: true });
  }
}
