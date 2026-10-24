// Guide file format shared by the build (scripts/guides.mjs) and the admin editor.
// A guide is Markdown with a simple "key: value" front matter block.
export const GUIDE_KEYS = ['title', 'description', 'date', 'updated', 'tool', 'draft'];

export function parseGuide(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) {
      let v = line.slice(i + 1).trim();
      if (v.length > 1 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1); // only fully-quoted values
      meta[line.slice(0, i).trim()] = v;
    }
  }
  return { meta, body: m ? m[2] : String(text) };
}

export function serializeGuide(meta, body) {
  const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
  const lines = GUIDE_KEYS.filter((k) => meta[k] !== undefined && meta[k] !== '' && !(k === 'draft' && !meta[k]))
    .map((k) => `${k}: ${k === 'draft' ? 'true' : clean(meta[k])}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body).trim()}\n`;
}

export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
  .replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

export const wordCount = (s) => (String(s).match(/\b[\w'’-]+\b/g) || []).length;
