// Result-matched affiliate offers. An offer appears only after a tool has produced a
// result that makes it relevant, and only if its affiliate URL is set in site.json.
// Nothing about the user's data is sent anywhere: the link is a plain affiliate URL.

const https = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : '');
const pct = (n) => `${Math.round(n * 10) / 10}%`;
const usd = (n) => (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/**
 * Decide which offer (if any) fits a result. Pure: no DOM, easy to test.
 * @returns {{key, url, title, body, cta} | null}
 */
export function pickOffer(tool, r, affiliates = {}) {
  const url = (k) => https(affiliates[k]?.url);
  const make = (key, title, body, cta) => (url(key) ? { key, url: url(key), title, body, cta } : null);
  if (!r) return null;

  if (tool === 'refinance') {
    // Only when refinancing actually pays off within the owner's horizon.
    if (r.breakEven == null || r.breakEven > r.stay || !(r.savingsAtStay > 0)) return null;
    return make('REFI', 'Your numbers say refinancing could pay off',
      `You'd break even in about ${Math.ceil(r.breakEven / 12 * 10) / 10} years. Compare actual rate offers to see if a lender can match the rate you entered.`,
      'Compare refinance offers');
  }

  if (tool === 'debt') {
    if (!r.ok || !r.debts?.length) return null;
    const top = Math.max(...r.debts.map((d) => d.apr || 0));
    if (top >= 15) {
      return make('BALANCE_TRANSFER', `Your highest rate is ${pct(top)}`,
        'A 0% balance transfer card can pause interest on card debt for a promotional period. Watch for transfer fees and the rate after the promo ends.',
        'Compare balance transfer cards')
        || make('DEBT_CONSOLIDATION', `Your highest rate is ${pct(top)}`, 'A consolidation loan at a lower fixed rate can cut interest and combine payments into one.', 'Compare consolidation loans');
    }
    if (r.debts.length >= 2) {
      return make('DEBT_CONSOLIDATION', `You're juggling ${r.debts.length} debts`,
        'A consolidation loan can combine them into one payment. It only helps if the new rate is lower than your current blended rate.',
        'Compare consolidation loans');
    }
    return null;
  }

  if (tool === 'subscriptions') {
    if (!r.found?.length) return null;
    if (r.saving > 0) {
      return make('HIGH_YIELD_SAVINGS', `Put the ${usd(r.saving)} a year to work`,
        'Moving the money you free up into a high-yield savings account lets it earn interest instead of disappearing into new charges.',
        'Compare high-yield savings')
        || make('BILL_NEGOTIATION', 'Want help cancelling?', 'A bill-cutting service can cancel subscriptions and negotiate other bills for you.', 'See bill-cutting services');
    }
    return make('BILL_NEGOTIATION', `${r.found.length} recurring charge${r.found.length > 1 ? 's' : ''} found`,
      'If cancelling them one by one sounds tedious, a bill-cutting service can do it — and negotiate bills like phone and internet.',
      'See bill-cutting services');
  }
  return null;
}

/** Render (or clear) an offer card inside `el`. Uses textContent only — no HTML injection. */
export function renderOffer(el, offer) {
  if (!el) return;
  el.replaceChildren();
  el.hidden = !offer;
  if (!offer) return;
  const h = document.createElement('b'); h.textContent = offer.title;
  const p = document.createElement('p'); p.textContent = offer.body;
  const a = document.createElement('a');
  Object.assign(a, { href: offer.url, target: '_blank', rel: 'sponsored nofollow noopener', className: 'btn sm', textContent: `${offer.cta} →` });
  const s = document.createElement('small'); s.textContent = 'Affiliate link: we may earn a commission at no cost to you. Not financial advice.';
  el.append(h, p, a, s);
}
