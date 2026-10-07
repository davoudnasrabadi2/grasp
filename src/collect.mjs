/*
 * Grasp — collector. Pulls the raw facts the mapper needs from GitHub and caches
 * merged PRs on disk (a merged PR doesn't change, so reruns only fetch new ones).
 *
 * Raw shape:
 * {
 *   repo, defaultBranch, viewer, fetchedAt, since, truncated,
 *   tree:      [{ path, size }]                       (blobs on the default branch)
 *   pulls:     [{ number, title, author, authorType, createdAt, mergedAt, headRef, body,
 *                 files: [{ f, a, d }], reviews: [{ user, type, state, at, body }],
 *                 inlineComments: { login: count }, commitMessages: [] }]
 *   incidents: [{ number, title, user, createdAt, closedAt }]
 * }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mapLimit } from './github.mjs';

const CACHE_VERSION = 1;

function cachePath(dir, repo) {
  return join(dir, repo.replace('/', '__') + '.json');
}

function loadCache(dir, repo) {
  const p = cachePath(dir, repo);
  if (!existsSync(p)) return {};
  try {
    const c = JSON.parse(readFileSync(p, 'utf8'));
    return c.version === CACHE_VERSION ? c.pulls || {} : {};
  } catch { return {}; }
}

function saveCache(dir, repo, pulls) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath(dir, repo), JSON.stringify({ version: CACHE_VERSION, repo, pulls }));
}

async function fetchPull(client, repo, pr) {
  const base = `/repos/${repo}/pulls/${pr.number}`;
  const [files, reviews, comments, commits] = await Promise.all([
    client.paginate(`${base}/files`, { maxItems: 3000 }).catch(() => []),
    client.paginate(`${base}/reviews`, { maxItems: 300 }).catch(() => []),
    client.paginate(`${base}/comments`, { maxItems: 500 }).catch(() => []),
    client.paginate(`${base}/commits`, { maxItems: 250 }).catch(() => [])
  ]);
  const inlineComments = {};
  for (const c of comments) {
    const login = c.user && c.user.login;
    if (login) inlineComments[login] = (inlineComments[login] || 0) + 1;
  }
  return {
    number: pr.number,
    title: (pr.title || '').slice(0, 140),
    author: pr.user ? pr.user.login : null,
    authorType: pr.user ? pr.user.type : null,
    createdAt: pr.created_at,
    mergedAt: pr.merged_at,
    headRef: (pr.head && pr.head.ref) || '',
    body: (pr.body || '').slice(0, 6000),
    files: files.map(f => ({ f: f.filename, a: f.additions || 0, d: f.deletions || 0 })),
    reviews: reviews
      .filter(r => r.user && r.submitted_at)
      .map(r => ({ user: r.user.login, type: r.user.type, state: r.state, at: r.submitted_at, body: !!(r.body && r.body.trim()) })),
    inlineComments,
    commitMessages: commits.map(c => ((c.commit && c.commit.message) || '').slice(0, 2000))
  };
}

export async function collect({ client, repo, since, maxPrs = 500, incidentLabels = ['incident'], cacheDir, useCache = true, log = () => {} }) {
  const info = await client.gh(`/repos/${repo}`);
  const defaultBranch = info.default_branch;

  let viewer = null;
  if (client.hasToken) {
    try { viewer = (await client.gh('/user')).login; } catch { /* fine-grained tokens may not read /user */ }
  }

  log('Fetching merged PRs since ' + since + '…');
  const closed = await client.paginate(
    `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`,
    { stopWhen: r => r.updated_at && r.updated_at.slice(0, 10) < since, maxItems: maxPrs * 3 }
  );
  const merged = closed
    .filter(r => r.merged_at && r.merged_at.slice(0, 10) >= since)
    .sort((a, b) => new Date(b.merged_at) - new Date(a.merged_at));
  const truncated = merged.length > maxPrs;
  const candidates = merged.slice(0, maxPrs);

  const cache = useCache && cacheDir ? loadCache(cacheDir, repo) : {};
  const todo = candidates.filter(pr => !cache[pr.number]);
  log(`${candidates.length} merged PRs in window · ${candidates.length - todo.length} cached · fetching ${todo.length}`);

  let done = 0;
  await mapLimit(todo, 6, async pr => {
    cache[pr.number] = await fetchPull(client, repo, pr);
    done++;
    if (done % 10 === 0 || done === todo.length) log(`  PR details ${done}/${todo.length}`, true);
    if (cacheDir && useCache && done % 50 === 0) saveCache(cacheDir, repo, cache);
  });
  if (cacheDir && useCache) saveCache(cacheDir, repo, cache);

  const pulls = candidates.map(pr => cache[pr.number]);

  const incidents = [];
  for (const label of incidentLabels) {
    const issues = await client.paginate(
      `/repos/${repo}/issues?state=all&labels=${encodeURIComponent(label)}&since=${since}T00:00:00Z`,
      { maxItems: 1000 }
    ).catch(() => []);
    for (const i of issues) {
      if (i.pull_request || incidents.some(x => x.number === i.number)) continue;
      incidents.push({
        number: i.number, title: (i.title || '').slice(0, 140),
        user: i.user ? i.user.login : null, createdAt: i.created_at, closedAt: i.closed_at
      });
    }
  }

  let tree = [];
  try {
    const t = await client.gh(`/repos/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
    tree = (t.tree || []).filter(e => e.type === 'blob').map(e => ({ path: e.path, size: e.size || 0 }));
  } catch { /* module sizes unknown: rewrite erosion is skipped */ }

  return {
    repo, defaultBranch, viewer, since, truncated,
    fetchedAt: new Date().toISOString(),
    oldestMerged: candidates.length ? candidates[candidates.length - 1].merged_at : null,
    tree, pulls, incidents
  };
}
