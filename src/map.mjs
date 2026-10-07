/*
 * Grasp — mapper. Turns raw GitHub facts (see collect.mjs) into the event log the
 * engine consumes: { meta, persons, modules, events }. Pure and deterministic.
 *
 * What each engine event means on a real repo:
 *   pr        a merged PR, split per module it touched (≥10% of its changed lines)
 *   review    one per human reviewer per PR: time to their verdict + comments they left
 *   edit      a human PR that changes lines an agent PR touched in the last 120 days
 *   incident  an issue labelled as an incident, attributed to the module of the PR that closed it
 * No baseline events: history before the display window (the warm-up) builds credit instead.
 */

import { detectAgent, isBotLogin, DEPENDENCY_BOTS } from './agents.mjs';

export const DEFAULT_IGNORE = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'poetry.lock',
  'Gemfile.lock', 'composer.lock', 'uv.lock', '*.min.js', '*.map', '*.snap',
  'dist/', 'build/', 'vendor/', 'node_modules/', '__snapshots__/',
  '.github/', '.changeset/', '.vscode/', '.husky/', '.devcontainer/'
];

const CONTAINERS = new Set(['src', 'lib', 'libs', 'packages', 'apps', 'services', 'modules',
  'internal', 'pkg', 'cmd', 'crates', 'components', 'plugins']);

const DAY = 86400000;
const EDIT_WINDOW_DAYS = 120;
const MEANINGFUL_EDIT_LINES = 20;
const MODULE_SHARE = 0.1;
const MIN_REWRITE = 0.05;
const BYTES_PER_LINE = 40;

export function makeIgnore(patterns) {
  return path => patterns.some(p => {
    if (p.endsWith('/')) return ('/' + path).includes('/' + p);
    if (p.startsWith('*.')) return path.endsWith(p.slice(1));
    return path === p || path.slice(path.lastIndexOf('/') + 1) === p;
  });
}

/* Default module for a path: top-level dir, or two levels under a container like src/ or packages/. */
export function autoKey(path) {
  const segs = path.split('/');
  if (segs.length === 1) return '(root)';
  if (CONTAINERS.has(segs[0]) && segs.length > 2) return segs[0] + '/' + segs[1];
  return segs[0];
}

export function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';
}

function hue(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function day(iso) { return iso.slice(0, 10); }

export function buildMonths(now, n) {
  const d = new Date(now + 'T00:00:00Z');
  const months = [];
  for (let i = n; i >= 1; i--) {
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i + 1, 0));
    months.push({
      label: end.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      end: end.toISOString().slice(0, 10)
    });
  }
  months.push({ label: 'Now', end: now });
  return months;
}

/* Configured modules (longest path prefix wins), else the most active auto-detected directories. */
function buildModules(config, pulls, ignored) {
  const configured = (config.modules || []).map(m => ({
    id: m.id || slug(m.name),
    name: m.name || m.id,
    paths: (m.paths || (m.path != null ? [m.path] : [])).map(p => p.replace(/^\/|\/$/g, '')),
    criticality: m.criticality || 'normal',
    desc: m.desc || ''
  }));

  let resolve;
  let modules;
  if (configured.length) {
    const prefixes = configured
      .flatMap(m => m.paths.map(p => ({ p, id: m.id })))
      .sort((a, b) => b.p.length - a.p.length);
    resolve = path => {
      const hit = prefixes.find(x => x.p === '' || path === x.p || path.startsWith(x.p + '/'));
      return hit ? hit.id : 'other';
    };
    modules = configured.map(m => ({ id: m.id, name: m.name, path: m.paths.join(', '), criticality: m.criticality, desc: m.desc }));
  } else {
    const activity = new Map();
    for (const pr of pulls) {
      for (const f of pr.files) {
        if (ignored(f.f)) continue;
        const k = autoKey(f.f);
        activity.set(k, (activity.get(k) || 0) + f.a + f.d);
      }
    }
    const top = [...activity].sort((a, b) => b[1] - a[1]).slice(0, config.maxModules || 12).map(x => x[0]);
    const ids = new Map(top.map(k => [k, slug(k)]));
    resolve = path => ids.get(autoKey(path)) || 'other';
    modules = top.map(k => ({ id: slug(k), name: k, path: k === '(root)' ? '(repo root files)' : k + '/', criticality: 'normal', desc: '' }));
  }
  return { resolve, modules };
}

export function buildDataset(raw, config = {}, opts = {}) {
  const now = opts.now || day(raw.fetchedAt || new Date().toISOString());
  const months = buildMonths(now, opts.months || config.months || 6);
  const ignored = makeIgnore([...DEFAULT_IGNORE, ...(config.ignore || [])]);
  const repoName = raw.repo.split('/')[1];
  const exclude = new Set((config.excludePeople || []).map(s => s.toLowerCase()));

  const stats = { prs: 0, agentPrs: 0, skippedBots: 0, skippedEmpty: 0, incidents: 0, unmappedIncidents: 0 };

  const pulls = raw.pulls
    .filter(Boolean)
    .filter(pr => {
      if (pr.author && DEPENDENCY_BOTS.test(pr.author)) { stats.skippedBots++; return false; }
      if (!pr.files.some(f => !ignored(f.f))) { stats.skippedEmpty++; return false; }
      return true;
    })
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));

  const { resolve, modules } = buildModules(config, pulls, ignored);

  /* ---- people: humans who authored a PR or reviewed at least twice ---- */
  const activity = new Map();
  const bump = (login, key) => {
    if (!login || exclude.has(login.toLowerCase())) return;
    const a = activity.get(login) || { prs: 0, reviews: 0 };
    a[key]++;
    activity.set(login, a);
  };
  for (const pr of pulls) {
    if (!isBotLogin(pr.author, pr.authorType)) bump(pr.author, 'prs');
    const seen = new Set();
    for (const r of pr.reviews) {
      if (isBotLogin(r.user, r.type) || r.user === pr.author || seen.has(r.user)) continue;
      seen.add(r.user);
      bump(r.user, 'reviews');
    }
  }
  const persons = [...activity]
    .filter(([, a]) => a.prs >= 1 || a.reviews >= 2)
    .sort((a, b) => (b[1].prs * 3 + b[1].reviews) - (a[1].prs * 3 + a[1].reviews))
    .map(([login, a]) => ({
      id: login.toLowerCase(), name: login, login,
      role: `${a.prs} PR${a.prs === 1 ? '' : 's'} · ${a.reviews} review${a.reviews === 1 ? '' : 's'}`,
      hue: hue(login)
    }));
  const known = new Set(persons.map(p => p.id));
  const pid = login => (login && known.has(login.toLowerCase()) ? login.toLowerCase() : null);

  /* ---- module sizes, for rewrite erosion ---- */
  const moduleLines = {};
  for (const f of raw.tree || []) {
    if (ignored(f.path)) continue;
    const m = resolve(f.path);
    moduleLines[m] = (moduleLines[m] || 0) + f.size / BYTES_PER_LINE;
  }

  /* ---- events ---- */
  const events = [];
  const agentTouched = new Map();   // file -> last agent merge time
  const closers = new Map();        // issue number -> { author, module }
  let usesOther = false;

  for (const pr of pulls) {
    const mergedT = Date.parse(pr.mergedAt);
    const createdT = Date.parse(pr.createdAt);
    const t = day(pr.mergedAt);
    const agent = detectAgent(pr, config.agentMarkers || []);
    const isAgent = agent.markers.length > 0;
    stats.prs++;
    if (isAgent) stats.agentPrs++;

    const byMod = new Map();
    for (const f of pr.files) {
      if (ignored(f.f)) continue;
      const m = resolve(f.f);
      const g = byMod.get(m) || { a: 0, d: 0, n: 0, editLines: 0 };
      g.a += f.a; g.d += f.d; g.n++;
      const touched = agentTouched.get(f.f);
      if (touched != null && mergedT - touched <= EDIT_WINDOW_DAYS * DAY) g.editLines += f.a + f.d;
      byMod.set(m, g);
    }
    const total = [...byMod.values()].reduce((s, g) => s + g.a + g.d, 0);
    const ranked = [...byMod].sort((a, b) => (b[1].a + b[1].d) - (a[1].a + a[1].d));
    const mods = ranked.filter(([, g], i) => i === 0 || g.a + g.d >= MODULE_SHARE * total);
    if (mods.some(([m]) => m === 'other')) usesOther = true;

    const humanReviews = pr.reviews
      .filter(r => !isBotLogin(r.user, r.type) && r.user !== pr.author)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const firstApproval = humanReviews.find(r => r.state === 'APPROVED' && Date.parse(r.at) >= createdT);
    const decisionMin = firstApproval ? Math.max(0, Math.round((Date.parse(firstApproval.at) - createdT) / 60000)) : null;
    const commentsBy = login =>
      humanReviews.filter(r => r.user === login && r.body).length + ((pr.inlineComments || {})[login] || 0);
    const commenters = new Set([...humanReviews.map(r => r.user), ...Object.keys(pr.inlineComments || {})]);
    commenters.delete(pr.author);
    const comments = [...commenters].filter(l => !isBotLogin(l)).reduce((s, l) => s + commentsBy(l), 0);

    const author = pid(pr.author) || pr.author;
    for (const [m, g] of mods) {
      const ev = {
        type: 'pr', id: `${repoName}#${pr.number}`, t, module: m, author,
        agent: isAgent ? agent.name || 'agent' : null, title: pr.title,
        added: g.a, deleted: g.d, files: g.n, decisionMin, comments
      };
      if (isAgent && moduleLines[m] > 0) {
        const f = g.d / moduleLines[m];
        if (f >= MIN_REWRITE) ev.rewriteFraction = Math.min(1, Math.round(f * 100) / 100);
      }
      events.push(ev);

      const reviewers = new Map();
      for (const r of humanReviews) {
        if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(r.state)) continue;
        const prev = reviewers.get(r.user);
        // verdict time: their approval if they gave one, otherwise their last review
        if (!prev || r.state === 'APPROVED' || prev.state !== 'APPROVED') reviewers.set(r.user, r);
      }
      for (const [login, r] of reviewers) {
        const person = pid(login);
        if (!person) continue;
        events.push({
          type: 'review', t: day(r.at), module: m, prId: ev.id, person, added: g.a,
          decisionMin: Math.max(0, Math.round((Date.parse(r.at) - createdT) / 60000)),
          comments: commentsBy(login)
        });
      }

      if (!isAgent && pid(pr.author) && g.editLines > 0) {
        events.push({
          type: 'edit', t, module: m, person: pid(pr.author),
          size: g.editLines >= MEANINGFUL_EDIT_LINES ? 'meaningful' : 'small'
        });
      }
    }

    if (isAgent) for (const f of pr.files) agentTouched.set(f.f, mergedT);

    const refText = [pr.title, pr.body, ...(pr.commitMessages || [])].join('\n');
    for (const m of refText.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi)) {
      closers.set(Number(m[1]), { author: pid(pr.author), module: mods[0][0] });
    }
  }

  for (const inc of raw.incidents || []) {
    const link = closers.get(inc.number);
    if (!link) { stats.unmappedIncidents++; continue; }
    if (link.module === 'other') usesOther = true;
    stats.incidents++;
    events.push({
      type: 'incident', t: day(inc.createdAt), module: link.module, id: '#' + inc.number, title: inc.title,
      detectedBy: pid(inc.user), fixedBy: link.author ? [link.author] : [],
      durationH: inc.closedAt ? Math.round((Date.parse(inc.closedAt) - Date.parse(inc.createdAt)) / 3600000) : null
    });
  }

  if (usesOther) modules.push({ id: 'other', name: 'Other', path: '(everything else)', criticality: 'normal', desc: '' });

  const viewer = pid(raw.viewer);
  return {
    meta: {
      mode: 'live',
      repo: raw.repo,
      org: '',
      now,
      periodStart: months[0].end.slice(0, 8) + '01',
      months,
      viewer,
      viewerLogin: raw.viewer || null,
      generatedAt: raw.fetchedAt,
      since: raw.since,
      truncated: !!raw.truncated,
      oldestMerged: raw.oldestMerged || null,
      stats
    },
    persons,
    modules,
    events
  };
}
