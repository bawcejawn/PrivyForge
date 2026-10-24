// Runtime settings come from src/data/site.json (edit in /admin/ → Settings).
// Unconfigured ad slots are hidden in production (no gaps, no requests).
import site from '../data/site.json';

export const MONETIZATION = {
  ADSENSE_CLIENT: site.ads?.adsenseClient || '', // e.g. 'ca-pub-1234567890123456'
  SLOTS: site.ads?.slots || {},
  SHOW_PLACEHOLDERS_IN_DEV: true,
};

// Support page (/support/). Empty entries are hidden. Crypto is optional and chain-agnostic:
// addresses are shown as text + a locally generated QR code; no wallet SDK is loaded.
export const SUPPORT = {
  links: site.support?.links || [],
  crypto: site.support?.crypto || [],
};

export const PRO = site.pro || {};
