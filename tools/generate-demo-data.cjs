#!/usr/bin/env node
/*
 * Grasp — deterministic demo-data generator.
 * Produces assets/data/demo-data.js (a classic script setting window.GRASP_DEMO)
 * so the dashboard also works from file:// without a server.
 *
 * The generated event log mimics 12 months of a fictional payments team:
 * healthy human era -> agent adoption ramp -> big agent rewrites, rubber-stamp
 * reviews, erosion, incidents. Baseline events encode prior history so the
 * team doesn't start from zero. The engine in assets/js/signals.js turns this
 * raw log into scores/coverage/alerts — nothing here is pre-scored.
 */
'use strict';
var path = require('path');
var fs = require('fs');

/* seeded RNG so every build is identical */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
var rand = mulberry32(1337);
function chance(p) { return rand() < p; }
function rint(a, b) { return a + Math.floor(rand() * (b - a + 1)); }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }

var data = {
  meta: {
    repo: 'paycore',
    org: 'Northwind Payments (fictional team for this demo)',
    now: '2026-10-07',
    periodStart: '2025-10-01',
    months: [
      { label: 'Oct 2025', end: '2025-10-31' },
      { label: 'Nov 2025', end: '2025-11-30' },
      { label: 'Dec 2025', end: '2025-12-31' },
      { label: 'Jan 2026', end: '2026-01-31' },
      { label: 'Feb 2026', end: '2026-02-28' },
      { label: 'Mar 2026', end: '2026-03-31' },
      { label: 'Apr 2026', end: '2026-04-30' },
      { label: 'May 2026', end: '2026-05-31' },
      { label: 'Jun 2026', end: '2026-06-30' },
      { label: 'Jul 2026', end: '2026-07-31' },
      { label: 'Aug 2026', end: '2026-08-31' },
      { label: 'Sep 2026', end: '2026-09-30' },
      { label: 'Now', end: '2026-10-07' }
    ]
  },
  persons: [
    { id: 'maya',  name: 'Maya Chen',   role: 'Senior Backend',        joined: '2024-03-01', hue: 210 },
    { id: 'jonas', name: 'Jonas Weber', role: 'Staff Engineer',        joined: '2023-06-01', hue: 160 },
    { id: 'priya', name: 'Priya Sharma', role: 'Senior Backend',       joined: '2024-09-01', hue: 280 },
    { id: 'tom',   name: 'Tom Aldridge', role: 'Backend Engineer',     joined: '2024-01-01', hue: 25 },
    { id: 'sara',  name: 'Sara Kim',    role: 'Mid-level Engineer',    joined: '2025-02-01', hue: 330 },
    { id: 'elena', name: 'Elena Rossi', role: 'Backend Engineer',      joined: '2026-01-12', hue: 195 }
  ],
  modules: [
    { id: 'payments',      name: 'Payments',      path: 'services/payments',    criticality: 'critical', desc: 'Charge orchestration, cart normalization, refunds' },
    { id: 'ledger',        name: 'Ledger',        path: 'services/ledger',      criticality: 'critical', desc: 'Double-entry postings, settlement batches' },
    { id: 'risk-engine',   name: 'Risk Engine',   path: 'services/risk',        criticality: 'critical', desc: 'Velocity rules, fraud scoring' },
    { id: 'auth',          name: 'Auth',          path: 'services/auth',        criticality: 'high',     desc: 'Sessions, tokens, step-up authentication' },
    { id: 'webhooks',      name: 'Webhooks',      path: 'services/webhooks',    criticality: 'high',     desc: 'Outbound delivery scheduler, retries, signing' },
    { id: 'ingest',        name: 'Ingest',        path: 'services/ingest',      criticality: 'high',     desc: 'Transaction stream parsing and partitioning' },
    { id: 'billing',       name: 'Billing',       path: 'services/billing',     criticality: 'medium',   desc: 'Invoices, proration, tax handling' },
    { id: 'admin-ui',      name: 'Admin UI',      path: 'apps/admin',           criticality: 'low',      desc: 'Internal operations console' },
    { id: 'notifications', name: 'Notifications', path: 'services/notify',      criticality: 'low',      desc: 'Email/SMS fan-out for product events' }
  ],
  oncall: { personId: 'tom', modules: ['webhooks', 'ingest', 'ledger'], startsAt: '2026-10-07T18:00:00' },
  events: []
};

var events = data.events;
var usedIds = {};
var nextId = 300;
function takeId(forced) {
  if (forced) { usedIds[forced] = 1; return forced; }
  while (usedIds[nextId]) nextId++;
  usedIds[nextId] = 1;
  return nextId;
}

var TITLES = {
  payments: ['Harden PSP timeout handling', 'Fix rounding on partial captures', 'Clean up charge builder flags', 'Add settlement cutoff guard', 'Refund reason codes'],
  ledger: ['Backfill posting gaps', 'Speed up settlement query', 'Tighten balance invariants', 'Archive cold postings'],
  'risk-engine': ['Tune velocity thresholds', 'New rule: BIN country mismatch', 'Cache score lookups', 'Prune stale rules'],
  auth: ['Rotate JWT signing keys', 'Session cleanup job', 'Tighten password policy', 'SSO metadata refresh'],
  webhooks: ['Dead endpoint backoff', 'Payload size guard', 'Queue depth metric', 'Signing key rotation'],
  ingest: ['Parser memory fix', 'DLQ reprocessor', 'Stream lag alerting', 'Schema registry bump'],
  billing: ['Invoice numbering fix', 'Proration on downgrade', 'Dunning email cadence', 'Tax rules refresh'],
  'admin-ui': ['Export to CSV', 'Keyboard shortcuts', 'Refund approval tweaks', 'Dark mode'],
  notifications: ['Template variable escaping', 'Unsubscribe handling', 'Provider failover', 'Batch digest emails']
};
var AGENT_TITLE_SUFFIX = [' (agent-assisted)', ' (agent-generated)', ''];

var FAST = { sara: 0.4, tom: 0.45, maya: 0.65 }; // rubber-stamp bias multiplier in the agent era

var AUTHORS = {
  payments:  { early: [['maya', .45], ['jonas', .35], ['elena', .20]], late: [['jonas', 1]] },
  ledger:    { early: [['jonas', .55], ['maya', .45]], late: [['elena', .30], ['jonas', .40], ['maya', .30]] },
  'risk-engine': { early: [['jonas', .70], ['maya', .30]], late: [['jonas', .65], ['maya', .35]] },
  auth:      { early: [['priya', .70], ['jonas', .30]], late: [['priya', .65], ['jonas', .35]] },
  webhooks:  { early: [['tom', .80], ['jonas', .20]], late: [['tom', .55], ['elena', .45]] },
  ingest:    { early: [['tom', .70], ['sara', .30]], late: [['tom', .50], ['sara', .50]] },
  billing:   { early: [['sara', .80], ['maya', .20]], late: [['elena', .60], ['sara', .40]] },
  'admin-ui': { early: [['sara', .70], ['priya', .30]], late: [['elena', .60], ['sara', .40]] },
  notifications: { early: [['tom', .50], ['priya', .50]], late: [['elena', .70], ['priya', .30]] }
};
var REVIEWERS = {
  payments: ['maya', 'jonas', 'elena'],
  ledger: ['maya', 'priya', 'jonas'],
  'risk-engine': ['jonas', 'priya', 'maya'],
  auth: ['priya', 'jonas', 'maya'],
  webhooks: ['tom', 'sara', 'jonas'],
  ingest: ['tom', 'sara', 'jonas'],
  billing: ['sara', 'maya', 'elena'],
  'admin-ui': ['sara', 'priya', 'elena'],
  notifications: ['sara', 'priya', 'tom']
};
var BACKEND = { payments: 1, ledger: 1, 'risk-engine': 1, auth: 1, webhooks: 1, ingest: 1, billing: 1 };
var RAMP = { '2026-03': .15, '2026-04': .25, '2026-05': .35, '2026-06': .45, '2026-07': .55, '2026-08': .60, '2026-09': .68 };
var RAMP_OVERRIDE = { 'risk-engine': 0.4, auth: 0.4 }; // keep the healthy contrast believable

/* Prior history: what each person already understood at period start (2025-10-01). */
var BASELINES = {
  payments:      { maya: 80, jonas: 55 },
  ledger:        { jonas: 78, maya: 58, priya: 25 },
  'risk-engine': { jonas: 82, maya: 40, priya: 25 },
  auth:          { priya: 80, jonas: 45, maya: 30 },
  webhooks:      { tom: 75, jonas: 35, sara: 25 },
  ingest:        { tom: 78, sara: 40, jonas: 30 },
  billing:       { sara: 76, maya: 35 },
  'admin-ui':    { sara: 65, priya: 45 },
  notifications: { tom: 60, priya: 55, sara: 20 }
};
Object.keys(BASELINES).forEach(function (m) {
  Object.keys(BASELINES[m]).forEach(function (p) {
    events.push({ type: 'baseline', t: '2025-10-01', person: p, module: m, score: BASELINES[m][p] });
  });
});

function weighted(pairs) {
  var r = rand(), acc = 0;
  for (var i = 0; i < pairs.length; i++) { acc += pairs[i][1]; if (r <= acc) return pairs[i][0]; }
  return pairs[pairs.length - 1][0];
}
function inAgentEra(t) { return t >= '2026-03-01'; }

function guessDecisionMin(added, agent, t, person) {
  if (!inAgentEra(t)) return Math.round((15 + added / 25) * (0.5 + rand() * 1.2));
  if (agent) {
    var base = 2 + added / 300;
    if (FAST[person]) base *= FAST[person];
    return Math.min(600, Math.max(1, Math.round(base * (0.5 + rand()))));
  }
  var b = Math.round((10 + added / 60) * (0.5 + rand()));
  if (FAST[person]) b = Math.round(b * FAST[person]);
  return Math.min(600, b);
}
function guessComments(added, agent, t, person) {
  if (!inAgentEra(t)) return Math.floor(Math.pow(rand(), 1.6) * 5);
  if (agent) return chance(0.85) ? 0 : 1;
  return chance(0.5) ? 0 : rint(1, 2);
}
function autoReviewers(module, author) {
  var pool = REVIEWERS[module].filter(function (p) { return p !== author; });
  for (var i = pool.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp; }
  var n = chance(0.7) ? 1 : 2;
  return pool.slice(0, Math.min(n, pool.length)).map(function (p) { return { person: p }; });
}

/* explicit story PR */
function S(module, author, t, added, agent, title, extra) {
  extra = extra || {};
  var pr = {
    type: 'pr', id: 'paycore#' + takeId(extra.id), t: t, module: module, author: author,
    agent: agent || null, title: title, added: added,
    deleted: extra.deleted != null ? extra.deleted : Math.round(added * 0.35 * rand()),
    files: extra.files != null ? extra.files : Math.max(2, Math.round(added / 55)),
    decisionMin: extra.decisionMin != null ? extra.decisionMin : guessDecisionMin(added, agent, t, author),
    comments: extra.comments != null ? extra.comments : guessComments(added, agent, t, author)
  };
  if (extra.rewriteFraction) pr.rewriteFraction = extra.rewriteFraction;
  events.push(pr);
  var revs = extra.reviewers || autoReviewers(module, author);
  revs.forEach(function (r) {
    events.push({
      type: 'review', t: t, module: module, prId: pr.id, person: r.person,
      added: added,
      decisionMin: r.decisionMin != null ? r.decisionMin : guessDecisionMin(added, agent, t, r.person),
      comments: r.comments != null ? r.comments : guessComments(added, agent, t, r.person)
    });
  });
  return pr;
}
function E(module, person, t, size) {
  events.push({ type: 'edit', t: t, module: module, person: person, size: size || 'meaningful' });
}
function INC(id, module, t, title, detectedBy, fixedBy, durationH) {
  events.push({ type: 'incident', t: t, module: module, id: id, title: title, detectedBy: detectedBy, fixedBy: fixedBy, durationH: durationH });
}

/* ------------------------------------------------------------------ */
/* Story beats (pinned ids keep the guided-tour and alert copy stable) */
/* ------------------------------------------------------------------ */

/* — payments: Maya's ownership decays, Elena rises, agents rewrite — */
S('payments', 'maya',  '2025-10-14', 640,  null,    'Idempotency keys for card charges', { reviewers: [{ person: 'jonas', decisionMin: 70, comments: 4 }, { person: 'elena', decisionMin: 40, comments: 1 }] });
S('payments', 'maya',  '2025-11-20', 380,  null,    'Retry policy for PSP timeouts', { reviewers: [{ person: 'jonas', decisionMin: 45, comments: 2 }] });
S('payments', 'jonas', '2025-12-09', 720,  null,    'Extract charge orchestrator', { reviewers: [{ person: 'maya', decisionMin: 90, comments: 3 }] });
E('payments', 'maya',  '2026-03-05', 'meaningful');
E('payments', 'elena', '2026-02-10', 'meaningful');
S('payments', 'elena', '2026-04-02', 310,  null,    'Move currency rounding to charge builder', { reviewers: [{ person: 'maya', decisionMin: 55, comments: 2 }] });
E('payments', 'elena', '2026-05-08', 'meaningful');
E('payments', 'elena', '2026-07-02', 'meaningful');
E('payments', 'elena', '2026-08-14', 'meaningful');
E('payments', 'elena', '2026-09-20', 'meaningful');
INC('INC-171', 'payments', '2026-04-20', 'Double charge during PSP network retry', 'elena', ['maya', 'elena'], 6.5);
INC('INC-243', 'payments', '2026-09-10', 'Card charged twice on idempotency miss', 'elena', [], 9.1);
S('payments', 'elena', '2026-09-24', 1840, 'claude', 'Rewrite cart normalization pipeline', { id: 502, rewriteFraction: 0.30, reviewers: [{ person: 'sara', decisionMin: 4, comments: 0 }] });
S('payments', 'maya',  '2026-09-29', 2340, 'claude', 'Consolidate duplicate charge paths', { id: 509, rewriteFraction: 0.28, reviewers: [{ person: 'sara', decisionMin: 4, comments: 0 }] });
S('payments', 'elena', '2026-10-03', 1470, 'claude', 'Refactor refund state machine', { id: 513, rewriteFraction: 0.10, reviewers: [{ person: 'tom', decisionMin: 3, comments: 0 }] });

/* — ledger: one big rewrite empties it — */
S('ledger', 'maya',  '2025-10-22', 450, null, 'Ledger entry schema v2', { reviewers: [{ person: 'jonas', decisionMin: 65, comments: 3 }] });
S('ledger', 'jonas', '2025-11-18', 900, null, 'Batch postings for settlement', { reviewers: [{ person: 'maya', decisionMin: 80, comments: 2 }] });
S('ledger', 'jonas', '2026-01-15', 520, null, 'Backfill job for missing postings', { reviewers: [{ person: 'maya', decisionMin: 50, comments: 1 }] });
S('ledger', 'jonas', '2026-05-14', 3900, 'claude', 'Rewrite posting pipeline', { id: 455, rewriteFraction: 0.40, reviewers: [{ person: 'maya', decisionMin: 12, comments: 0 }] });

/* — webhooks: rewrite -> incident -> Jonas rebuilds understanding — */
S('webhooks', 'tom', '2025-11-05', 540, null, 'Signed payload verification', { reviewers: [{ person: 'jonas', decisionMin: 55, comments: 2 }] });
S('webhooks', 'tom', '2026-01-22', 420, null, 'Endpoint health scoring', { reviewers: [{ person: 'sara', decisionMin: 40, comments: 1 }] });
S('webhooks', 'tom', '2026-06-20', 4100, 'claude', 'Rewrite delivery scheduler', { id: 472, rewriteFraction: 0.52, reviewers: [{ person: 'sara', decisionMin: 7, comments: 0 }] });
INC('INC-219', 'webhooks', '2026-07-14', 'Deliveries lagging 4 hours behind', 'tom', ['jonas'], 4.2);
E('webhooks', 'jonas', '2026-07-16', 'meaningful');
E('webhooks', 'jonas', '2026-08-05', 'small');
S('webhooks', 'tom', '2026-08-20', 420, 'claude', 'Add retry jitter', { reviewers: [{ person: 'jonas', decisionMin: 45, comments: 3 }] });
E('webhooks', 'jonas', '2026-09-12', 'meaningful');

/* — ingest: rubber-stamped agent rewrites, Tom races to keep up — */
S('ingest', 'tom', '2025-10-30', 800, null, 'Stream parser v2', { reviewers: [{ person: 'jonas', decisionMin: 85, comments: 3 }] });
S('ingest', 'tom', '2026-02-12', 350, null, 'Dead-letter queue alerts', { reviewers: [{ person: 'sara', decisionMin: 35, comments: 1 }] });
E('ingest', 'tom', '2026-02-18', 'meaningful');
S('ingest', 'tom', '2026-07-30', 2600, 'claude', 'Rewrite stream partitioner', { id: 486, rewriteFraction: 0.30, reviewers: [{ person: 'sara', decisionMin: 3, comments: 0 }] });
S('ingest', 'sara', '2026-09-18', 1900, 'claude', 'Rebalance consumer groups', { id: 505, rewriteFraction: 0.25, reviewers: [{ person: 'tom', decisionMin: 4, comments: 0 }] });
E('ingest', 'tom', '2026-09-28', 'meaningful');
E('ingest', 'tom', '2026-10-02', 'meaningful');
INC('INC-098', 'ingest', '2025-12-04', 'Transaction stream fell 2 hours behind', 'tom', ['tom'], 3.1);

/* — auth: Priya stays current (the healthy contrast) — */
S('auth', 'priya', '2025-11-12', 460, null, 'Refresh token rotation', { reviewers: [{ person: 'jonas', decisionMin: 55, comments: 2 }] });
E('auth', 'priya', '2025-11-25', 'meaningful');
S('auth', 'priya', '2026-02-15', 700, null, 'Migrate sessions to redis', { reviewers: [{ person: 'jonas', decisionMin: 75, comments: 3 }] });
E('auth', 'priya', '2026-02-20', 'meaningful');
S('auth', 'priya', '2026-05-10', 520, null, 'Device binding for step-up auth', { reviewers: [{ person: 'jonas', decisionMin: 60, comments: 2 }] });
E('auth', 'priya', '2026-05-15', 'meaningful');
S('auth', 'priya', '2026-08-18', 380, null, 'Rate limit per API key', { reviewers: [{ person: 'elena', decisionMin: 45, comments: 1 }] });
E('auth', 'priya', '2026-08-22', 'meaningful');
S('auth', 'jonas', '2026-06-09', 420, null, 'Audit log for token mint', { reviewers: [{ person: 'priya', decisionMin: 45, comments: 2 }] });
E('auth', 'jonas', '2026-07-10', 'meaningful');
E('auth', 'jonas', '2026-08-08', 'meaningful');

/* — risk-engine: Jonas is the only current mind — */
S('risk-engine', 'jonas', '2025-10-25', 600, null, 'Velocity rules v3', { reviewers: [{ person: 'maya', decisionMin: 70, comments: 2 }] });
E('risk-engine', 'jonas', '2026-03-12', 'meaningful');
S('risk-engine', 'jonas', '2026-06-11', 480, null, 'Add device fingerprint features', { reviewers: [{ person: 'maya', decisionMin: 50, comments: 1 }] });
E('risk-engine', 'jonas', '2026-06-16', 'meaningful');
E('risk-engine', 'jonas', '2026-09-05', 'meaningful');

/* — billing: Sara's attention drains into rubber-stamping — */
S('billing', 'sara',  '2025-10-18', 300, null, 'Proration edge cases', { reviewers: [{ person: 'maya', decisionMin: 40, comments: 1 }] });
S('billing', 'sara',  '2026-01-20', 550, null, 'Invoice PDF service', { reviewers: [{ person: 'maya', decisionMin: 60, comments: 2 }] });
E('billing', 'sara',  '2026-01-25', 'meaningful');
S('billing', 'sara',  '2026-04-14', 380, null, 'Tax id validation', { reviewers: [{ person: 'elena', decisionMin: 40, comments: 1 }] });
E('billing', 'sara',  '2026-04-20', 'meaningful');
S('billing', 'elena', '2026-06-20', 420, null, 'Usage-based line items', { reviewers: [{ person: 'sara', decisionMin: 8, comments: 0 }] });
S('billing', 'elena', '2026-08-22', 480, null, 'Credit note flow', { reviewers: [{ person: 'sara', decisionMin: 6, comments: 0 }] });
E('billing', 'elena', '2026-08-08', 'meaningful');
E('billing', 'elena', '2026-09-25', 'meaningful');

/* — admin-ui & notifications: Elena carries the newer work — */
S('admin-ui', 'sara',  '2025-11-08', 350, null, 'Refund approval flow', { reviewers: [{ person: 'priya', decisionMin: 35, comments: 1 }] });
S('admin-ui', 'elena', '2026-03-18', 280, null, 'Merchant search filters', { reviewers: [{ person: 'priya', decisionMin: 30, comments: 1 }] });
S('admin-ui', 'elena', '2026-08-28', 340, null, 'Audit trail page', { reviewers: [{ person: 'priya', decisionMin: 35, comments: 1 }] });
E('admin-ui', 'elena', '2026-08-10', 'meaningful');
E('admin-ui', 'elena', '2026-09-20', 'meaningful');
E('admin-ui', 'elena', '2026-09-28', 'meaningful');
S('notifications', 'elena', '2026-02-25', 240, null, 'SMS fallback provider', { reviewers: [{ person: 'priya', decisionMin: 35, comments: 1 }] });
S('notifications', 'elena', '2026-09-05', 260, null, 'Batch digest emails', { reviewers: [{ person: 'priya', decisionMin: 30, comments: 1 }] });
E('notifications', 'elena', '2026-07-08', 'meaningful');
E('notifications', 'elena', '2026-09-15', 'meaningful');

/* ------------------------------------------------------------------ */
/* Procedural filler: texture PRs with era-aware behavior             */
/* ------------------------------------------------------------------ */

var CADENCE = {
  payments:  { early: [2, 3], late: [1, 1] },
  ledger:    { early: [2, 3], late: [1, 2] },
  'risk-engine': { early: [1, 2], late: [1, 2] },
  auth:      { early: [1, 2], late: [1, 2] },
  webhooks:  { early: [1, 2], late: [0, 1] },
  ingest:    { early: [1, 2], late: [0, 1] },
  billing:   { early: [1, 2], late: [0, 1] },
  'admin-ui': { early: [0, 1], late: [0, 1] },
  notifications: { early: [0, 1], late: [0, 1] }
};

Object.keys(CADENCE).forEach(function (module) {
  var range = CADENCE[module];
  for (var mi = 0; mi < 12; mi++) {
    var n = rint(range[mi < 5 ? 'early' : 'late'][0], range[mi < 5 ? 'early' : 'late'][1]);
    for (var j = 0; j < n; j++) {
      var day = rint(2, 27);
      var t = new Date(Date.UTC(2025, 9 + mi, day)).toISOString().slice(0, 10);
      var era = inAgentEra(t) ? 'late' : 'early';
      var author = weighted(AUTHORS[module][era]);
      if (author === 'elena' && t < '2026-01-12') author = 'jonas';
      var agent = null;
      var ramp = RAMP[t.slice(0, 7)] || 0.2;
      if (RAMP_OVERRIDE[module]) ramp *= RAMP_OVERRIDE[module];
      if (inAgentEra(t) && chance(ramp)) agent = chance(0.6) ? 'claude' : 'copilot';
      var added = chance(0.12) ? rint(300, 700) : rint(40, 280);
      var title = pick(TITLES[module]) + (agent ? pick(AGENT_TITLE_SUFFIX) : '');
      var pr = {
        type: 'pr', id: 'paycore#' + takeId(), t: t, module: module, author: author,
        agent: agent, title: title, added: added, deleted: Math.round(added * 0.3 * rand()),
        files: Math.max(2, Math.round(added / 55)),
        decisionMin: guessDecisionMin(added, agent, t, author),
        comments: guessComments(added, agent, t, author)
      };
      events.push(pr);
      autoReviewers(module, author).forEach(function (r) {
        events.push({
          type: 'review', t: t, module: module, prId: pr.id, person: r.person,
          added: added, decisionMin: guessDecisionMin(added, agent, t, r.person),
          comments: guessComments(added, agent, t, r.person)
        });
      });
    }
  }
});

events.sort(function (a, b) { return new Date(a.t) - new Date(b.t); });

/* ------------------------------------------------------------------ */

var outPath = path.join(__dirname, '..', 'assets', 'data', 'demo-data.js');
var js = '/* Generated by tools/generate-demo-data.cjs — do not edit by hand. */\n' +
  'window.GRASP_DEMO = ' + JSON.stringify(data) + ';\n';
fs.writeFileSync(outPath, js);

var counts = {};
events.forEach(function (e) { counts[e.type] = (counts[e.type] || 0) + 1; });
console.log('Wrote ' + outPath);
console.log('Events: ' + events.length + ' (' + JSON.stringify(counts) + ')');

module.exports = { build: function () { return data; } };
