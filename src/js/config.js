// Monetization switches. Leave ADSENSE_CLIENT empty until you're approved:
// unconfigured slots are hidden in production (no gaps, no requests).

// Support page (/support/). Empty entries are hidden. Crypto is optional and chain-agnostic:
// addresses are shown as text + a locally generated QR code; no wallet SDK is loaded.
export const SUPPORT = {
  links: [
    { label: 'Buy us a coffee', url: '' },        // e.g. https://ko-fi.com/yourname
    { label: 'GitHub Sponsors', url: '' },        // e.g. https://github.com/sponsors/yourname
    { label: 'Go ad-free (Pro)', url: '' },       // e.g. a Lemon Squeezy / Stripe Payment Link
  ],
  crypto: [
    // { chain: 'Bitcoin', address: 'bc1...' },
    // { chain: 'Ethereum / USDC (Base)', address: '0x...' },
    // { chain: 'Koinos (KOIN)', address: '1...' },
  ],
};

export const MONETIZATION = {
  ADSENSE_CLIENT: '', // e.g. 'ca-pub-1234567890123456'
  // Map each named slot in the HTML (data-slot="...") to an AdSense ad unit id.
  SLOTS: {
    'top-banner': '',
    'tool-below': '',
    'content-mid': '',
    'sidebar': '',
  },
  SHOW_PLACEHOLDERS_IN_DEV: true,
};
