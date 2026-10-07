/*
 * Grasp — minimal GitHub REST client. Node 18+ global fetch, no dependencies.
 */

const API = 'https://api.github.com';

export function createClient({ token = '', userAgent = 'grasp-cli', log = () => {} } = {}) {
  let rateWarned = false;

  function headers() {
    const h = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': userAgent,
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  async function gh(path) {
    const res = await fetch(API + path, { headers: headers() });
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0' && !rateWarned) {
      rateWarned = true;
      log('! GitHub rate limit exhausted. Set GITHUB_TOKEN to raise it from 60 to 5000 req/hour.');
    }
    if (res.status === 429 || (res.status === 403 && remaining === '0')) {
      const reset = res.headers.get('x-ratelimit-reset');
      const wait = reset ? Math.max(1, (reset * 1000 - Date.now()) / 1000) : 60;
      throw new Error(`Rate limited by GitHub. Retry in ~${Math.ceil(wait)}s (or set GITHUB_TOKEN).`);
    }
    if (res.status === 401) throw new Error('GitHub rejected the token (401). Check GITHUB_TOKEN.');
    if (res.status === 403) throw new Error(`Forbidden: ${path} — your token may lack access to this repository.`);
    if (res.status === 404) throw new Error(`Not found: ${path} — check owner/repo and (for private repos) your token scope.`);
    if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async function paginate(path, { stopWhen, maxItems = Infinity } = {}) {
    const out = [];
    for (let page = 1; ; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const items = await gh(`${path}${sep}per_page=100&page=${page}`);
      if (!Array.isArray(items) || items.length === 0) break;
      out.push(...items);
      if (stopWhen && items.some(stopWhen)) break;
      if (out.length >= maxItems) break;
      if (items.length < 100) break;
    }
    return out;
  }

  return { gh, paginate, hasToken: !!token };
}

/* Run fn over items with at most `limit` in flight; preserves order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
