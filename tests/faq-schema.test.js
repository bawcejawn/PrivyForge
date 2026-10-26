// Every FAQPage JSON-LD block must match the visible FAQ on the same page (built output).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const pages = [];
(function walk(d) { if (!existsSync(d)) return; for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== 'assets') walk(p); } else if (n === 'index.html') pages.push(p); } })(dist);
const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

test('FAQPage structured data matches the visible FAQ (run after npm run build)', { skip: !pages.length && 'no dist/ — run npm run build first' }, () => {
  let checked = 0;
  for (const p of pages) {
    const h = readFileSync(p, 'utf8');
    for (const block of h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || []) {
      const data = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/g, ''));
      for (const node of [data, ...(data['@graph'] || [])]) {
        if (node['@type'] !== 'FAQPage') continue;
        const visible = [...h.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((m) => text(m[1]));
        const schema = node.mainEntity.map((q) => text(q.name));
        assert.deepEqual(schema, visible, `FAQ mismatch in ${p.replace(dist, '/')}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 0);
});
