#!/usr/bin/env node
/*
 * Grasp CLI — who actually understands your code?
 * Run `grasp help` for usage. Node 18+, no dependencies.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { createClient } from '../src/github.mjs';
import { collect } from '../src/collect.mjs';
import { buildDataset, makeIgnore, autoKey, slug, DEFAULT_IGNORE } from '../src/map.mjs';
import { serveDashboard, openBrowser } from '../src/serve.mjs';

const require = createRequire(import.meta.url);
const signals = require('../assets/js/signals.js');
const { printReport } = require('../src/report.cjs');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const HELP = `grasp ${PKG.version} — who actually understands your code?

Usage
  grasp analyze [owner/repo] [options]   Map current understanding from GitHub history
  grasp demo [--open]                    Run the engine on the built-in demo team
  grasp init [owner/repo]                Write grasp.config.json (modules, ignores, labels)
  grasp validate [owner/repo] [options]  Step-zero check: share of big PRs approved fast

Inside a clone, owner/repo can be omitted: it is read from the git "origin" remote.

Options for analyze
  --open              Open the dashboard in your browser (served on localhost only)
  --months=6          Months shown in the heatmap
  --warmup=6          Extra months of history fetched before that, to build up credit
  --since=YYYY-MM-DD  Fetch history from this date instead (overrides --warmup)
  --max-prs=500       Cap on merged PRs analyzed
  --at=YYYY-MM-DD     Replay: report as of a past date
  --json=out.json     Write the dataset and aggregate results (no individual scores)
  --config=path       Config file (default: ./grasp.config.json if present)
  --port=4517         Port for --open
  --no-cache          Refetch everything (cache lives in ./.grasp/)
  --token=…           GitHub token (default: $GITHUB_TOKEN, $GH_TOKEN, or \`gh auth token\`)

Privacy: individual scores appear only in "My view", for the person whose token ran
the analysis. Reports and JSON exports contain module-level aggregates only.
`;

/* ---------------- args ---------------- */

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (const a of argv) {
    if (a.startsWith('--no-')) flags[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      const i = a.indexOf('=');
      if (i < 0) flags[a.slice(2)] = true;
      else flags[a.slice(2, i)] = a.slice(i + 1);
    } else pos.push(a);
  }
  return { flags, pos };
}

function int(v, dflt, name) {
  if (v == null || v === true) return dflt;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number`);
  return n;
}

function fail(msg) {
  console.error('grasp: ' + msg);
  process.exit(1);
}

function log(msg, progress) {
  if (progress && process.stderr.isTTY) process.stderr.write('\r' + msg + '   ');
  else process.stderr.write(msg + '\n');
}

function resolveToken(flags) {
  if (typeof flags.token === 'string') return flags.token;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
  } catch { return ''; }
}

function loadConfig(flags) {
  const path = typeof flags.config === 'string' ? resolve(flags.config) : resolve('grasp.config.json');
  if (!existsSync(path)) {
    if (typeof flags.config === 'string') fail(`config not found: ${path}`);
    return { config: {}, path: null };
  }
  try { return { config: JSON.parse(readFileSync(path, 'utf8')), path }; }
  catch (e) { fail(`could not parse ${path}: ${e.message}`); }
}

/* owner/repo of the GitHub `origin` remote in the current directory, if any. */
function repoFromGit() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
    const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

function checkRepo(repo) {
  if (repo === 'owner/repo') fail('replace owner/repo with a real repository, e.g. `grasp analyze honojs/hono` — or run inside a clone and omit it');
  if (!repo) fail('no repository given and no GitHub `origin` remote here — pass one as owner/repo (see `grasp help`)');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`expected a repository as owner/repo, got "${repo}"`);
  return repo;
}

function monthsBefore(isoDay, n) {
  const d = new Date(isoDay + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1)).toISOString().slice(0, 10);
}

function isoDate(v, name) {
  if (v == null) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(`--${name} must be YYYY-MM-DD`);
  return v;
}

/* ---------------- shared: compute, report, serve ---------------- */

async function present(data, flags) {
  const at = isoDate(flags.at, 'at');
  const st = signals.computeState(data, at ? { at } : {});
  printReport(data, st, { replayed: !!at });

  if (typeof flags.json === 'string') {
    const aggregate = {
      at: new Date(st.at).toISOString().slice(0, 10),
      kpis: st.kpis, alerts: st.alerts, coverageNow: st.coverageNow,
      coverageHistory: st.coverageHistory, moduleStats: st.moduleStats, weeklyReport: st.weeklyReport
    };
    writeFileSync(flags.json, JSON.stringify({ dataset: data, aggregate }, null, 2));
    log(`Wrote ${flags.json}`);
  }

  if (flags.open) {
    const { url } = await serveDashboard(data, { port: int(flags.port, 4517, 'port') });
    log(`Dashboard: ${url}  (Ctrl+C to stop)`);
    openBrowser(url);
  }
}

/* ---------------- commands ---------------- */

async function cmdAnalyze(flags, pos) {
  const { config, path: configPath } = loadConfig(flags);
  const repo = checkRepo(pos[0] || config.repo || repoFromGit());
  const months = int(flags.months, config.months || 6, 'months');
  const warmup = int(flags.warmup, config.warmupMonths || 6, 'warmup');
  const today = new Date().toISOString().slice(0, 10);
  const since = isoDate(flags.since, 'since') || monthsBefore(today, months + warmup);
  const token = resolveToken(flags);

  log(`Grasp — analyzing ${repo}${configPath ? ' with ' + configPath : ''}`);
  if (!token) log('! No GitHub token found — unauthenticated limit is 60 req/hour. Set GITHUB_TOKEN or run `gh auth login`.');

  const client = createClient({ token, userAgent: 'grasp-cli/' + PKG.version, log });
  const raw = await collect({
    client, repo, since,
    maxPrs: int(flags['max-prs'], config.maxPrs || 500, 'max-prs'),
    incidentLabels: config.incidentLabels || ['incident'],
    cacheDir: resolve('.grasp'),
    useCache: flags.cache !== false,
    log
  });
  if (process.stderr.isTTY) process.stderr.write('\n');

  const data = buildDataset(raw, config, { now: today, months });
  if (!data.events.length) fail(`no merged PRs with code changes found in ${repo} since ${since}`);
  await present(data, flags);
}

function loadDemoData() {
  const src = readFileSync(join(ROOT, 'assets', 'data', 'demo-data.js'), 'utf8');
  return JSON.parse(src.slice(src.indexOf('=') + 1, src.lastIndexOf(';')));
}

async function cmdDemo(flags) {
  await present(loadDemoData(), flags);
}

async function cmdInit(flags, pos) {
  const target = resolve('grasp.config.json');
  if (existsSync(target) && !flags.force) fail('grasp.config.json already exists (use --force to overwrite)');

  const repo = pos[0] ? checkRepo(pos[0]) : 'owner/repo';
  let modules = [{ name: 'Payments', paths: ['services/payments'], criticality: 'critical' }];

  if (pos[0]) {
    const client = createClient({ token: resolveToken(flags), userAgent: 'grasp-cli/' + PKG.version, log });
    const info = await client.gh(`/repos/${repo}`);
    const tree = await client.gh(`/repos/${repo}/git/trees/${encodeURIComponent(info.default_branch)}?recursive=1`);
    const ignored = makeIgnore(DEFAULT_IGNORE);
    const size = new Map();
    for (const e of tree.tree || []) {
      if (e.type !== 'blob' || ignored(e.path)) continue;
      const k = autoKey(e.path);
      size.set(k, (size.get(k) || 0) + (e.size || 0));
    }
    modules = [...size].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .filter(([k]) => k !== '(root)')
      .map(([k]) => ({ id: slug(k), name: k, paths: [k], criticality: 'normal' }));
  }

  const config = {
    repo,
    months: 6,
    warmupMonths: 6,
    maxPrs: 500,
    modules,
    ignore: [],
    incidentLabels: ['incident'],
    agentMarkers: [],
    excludePeople: []
  };
  writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
  console.log(`Wrote ${target}`);
  console.log('Edit module names, paths and criticality (critical | high | normal), then run: grasp analyze');
  console.log('Tip: add .grasp/ to .gitignore — it holds the local PR cache.');
}

function cmdValidate(argv, flags, pos) {
  if (!flags.selftest) {
    const repo = checkRepo(pos[0] || repoFromGit());
    if (!pos[0]) argv = [repo, ...argv];
  }
  const env = { ...process.env, GRASP_CLI: '1' };
  if (!env.GITHUB_TOKEN) env.GITHUB_TOKEN = resolveToken(flags);
  const child = spawn(process.execPath, [join(ROOT, 'tools', 'validate-github.mjs'), ...argv], { stdio: 'inherit', env });
  child.on('exit', code => process.exit(code ?? 1));
}

/* ---------------- main ---------------- */

// `grasp demo | head` closes the pipe early; that's not an error.
process.stdout.on('error', err => { if (err.code === 'EPIPE') process.exit(0); throw err; });

const argv = process.argv.slice(2);
const cmd = argv[0];
const { flags, pos } = parseArgs(argv.slice(1));

try {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') console.log(HELP);
  else if (cmd === '--version' || cmd === '-v' || cmd === 'version') console.log(PKG.version);
  else if (cmd === 'analyze') await cmdAnalyze(flags, pos);
  else if (cmd === 'demo') await cmdDemo(flags);
  else if (cmd === 'init') await cmdInit(flags, pos);
  else if (cmd === 'validate') cmdValidate(argv.slice(1), flags, pos);
  else fail(`unknown command "${cmd}" (see \`grasp help\`)`);
} catch (err) {
  if (process.stderr.isTTY) process.stderr.write('\n');
  fail(err.message);
}
