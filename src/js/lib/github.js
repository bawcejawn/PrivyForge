// Minimal GitHub REST client for the admin page. The token lives only in this browser
// (sessionStorage by default). Writes are restricted to an allow-list of paths.
const API = 'https://api.github.com';
export const WRITABLE = [/^src\/data\/site\.json$/, /^src\/data\/tools\.json$/, /^content\/guides\/[a-z0-9-]+\.md$/];

const enc = (s) => { const b = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(bin); };
const dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

export class GitHub {
  constructor({ repo, branch = 'main', token }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Repository must look like owner/name.');
    Object.assign(this, { repo, branch, token });
  }
  async req(path, opts = {}) {
    const res = await fetch(`${API}${path}`, {
      ...opts,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${this.token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (res.status === 204) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.message || res.statusText;
      const hint = res.status === 401 ? ' — the token is invalid or expired.'
        : res.status === 403 || res.status === 404 ? ' — check the token has "Contents: Read and write" on this repository.'
          : res.status === 409 ? ' — the file changed on GitHub since you loaded it. Reload and try again.' : '';
      const e = new Error(`GitHub ${res.status}: ${msg}${hint}`); e.status = res.status; throw e;
    }
    return body;
  }
  verify() { return this.req(`/repos/${this.repo}`); }
  async read(path) {
    const f = await this.req(`/repos/${this.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`);
    return { text: dec(f.content), sha: f.sha };
  }
  async list(dir) {
    try { return (await this.req(`/repos/${this.repo}/contents/${encodeURI(dir)}?ref=${encodeURIComponent(this.branch)}`)).filter((f) => f.type === 'file'); }
    catch (e) { if (e.status === 404) return []; throw e; }
  }
  assertWritable(path) { if (!WRITABLE.some((r) => r.test(path))) throw new Error(`Admin can't write to ${path}.`); }
  async write(path, text, message, sha) {
    this.assertWritable(path);
    return this.req(`/repos/${this.repo}/contents/${encodeURI(path)}`, { method: 'PUT', body: JSON.stringify({ message, content: enc(text), branch: this.branch, ...(sha ? { sha } : {}) }) });
  }
  async remove(path, message, sha) {
    this.assertWritable(path);
    return this.req(`/repos/${this.repo}/contents/${encodeURI(path)}`, { method: 'DELETE', body: JSON.stringify({ message, sha, branch: this.branch }) });
  }
  async runs() {
    try { return (await this.req(`/repos/${this.repo}/actions/runs?per_page=5&branch=${encodeURIComponent(this.branch)}`)).workflow_runs || []; }
    catch { return null; } // token may lack Actions:read — that's optional
  }
}
