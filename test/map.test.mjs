import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { buildDataset, buildMonths, makeIgnore, autoKey } from '../src/map.mjs';
import { detectAgent } from '../src/agents.mjs';
import { dataScript } from '../src/serve.mjs';

const require = createRequire(import.meta.url);
const signals = require('../assets/js/signals.js');

const at = (base, min) => new Date(Date.parse(base) + min * 60000).toISOString();

function pr(number, author, mergedAt, files, extra = {}) {
  const createdAt = at(mergedAt, -600);
  return {
    number, title: 'PR ' + number, author, authorType: /\[bot\]$/.test(author) ? 'Bot' : 'User',
    createdAt, mergedAt, headRef: 'feature/' + number, body: '', reviews: [], inlineComments: {},
    commitMessages: [], files: files.map(([f, a, d]) => ({ f, a, d })), ...extra,
    _created: createdAt
  };
}
function review(user, p, min, state = 'APPROVED', body = false) {
  return { user, type: 'User', state, at: at(p._created, min), body };
}

function fixture() {
  const p1 = pr(1, 'alice', '2026-05-01T10:00:00Z', [['src/payments/a.js', 50, 0]]);
  p1.reviews = [review('bob', p1, 120, 'APPROVED', true)];
  const p2 = pr(2, 'alice', '2026-06-01T10:00:00Z', [['src/payments/a.js', 500, 60]], { headRef: 'claude/rewrite' });
  p2.reviews = [review('bob', p2, 5)];
  const p3 = pr(3, 'carol', '2026-07-01T10:00:00Z', [['src/payments/a.js', 30, 10]], { body: 'Fixes #10' });
  const p4 = pr(4, 'dependabot[bot]', '2026-07-02T10:00:00Z', [['package-lock.json', 900, 800]]);
  const p5 = pr(5, 'alice', '2026-07-03T10:00:00Z', [['package-lock.json', 10, 2]]);
  const p6 = pr(6, 'dave', '2026-08-01T10:00:00Z', [['src/auth/b.js', 95, 0], ['src/payments/a.js', 5, 0]]);
  return {
    repo: 'acme/shop', fetchedAt: '2026-10-07T00:00:00Z', since: '2025-10-01', viewer: 'Carol',
    tree: [
      { path: 'src/payments/a.js', size: 4000 },
      { path: 'src/auth/b.js', size: 4000 },
      { path: 'package-lock.json', size: 900000 }
    ],
    pulls: [p6, p5, p4, p3, p2, p1],
    incidents: [
      { number: 10, title: 'Double charge', user: 'bob', createdAt: '2026-06-20T08:00:00Z', closedAt: '2026-06-20T13:00:00Z' },
      { number: 11, title: 'Unlinked', user: 'bob', createdAt: '2026-06-21T08:00:00Z', closedAt: null }
    ]
  };
}

test('maps PRs, reviews, edits and incidents into engine events', () => {
  const data = buildDataset(fixture(), {}, { now: '2026-10-07', months: 6 });
  const s = data.meta.stats;

  assert.deepEqual(data.modules.map(m => m.id), ['src-payments', 'src-auth']);
  assert.deepEqual(data.persons.map(p => p.id).sort(), ['alice', 'bob', 'carol', 'dave']);
  assert.equal(data.meta.viewer, 'carol');
  assert.deepEqual([s.prs, s.agentPrs, s.skippedBots, s.skippedEmpty, s.incidents, s.unmappedIncidents], [4, 1, 1, 1, 1, 1]);

  const agentPr = data.events.find(e => e.type === 'pr' && e.id === 'shop#2');
  assert.equal(agentPr.agent, 'claude');
  assert.equal(agentPr.rewriteFraction, 0.6);
  assert.equal(agentPr.decisionMin, 5);

  const reviews = data.events.filter(e => e.type === 'review');
  assert.deepEqual(reviews.map(r => [r.person, r.prId, r.decisionMin, r.comments]),
    [['bob', 'shop#1', 120, 1], ['bob', 'shop#2', 5, 0]]);

  const edits = data.events.filter(e => e.type === 'edit');
  assert.deepEqual(edits, [{ type: 'edit', t: '2026-07-01', module: 'src-payments', person: 'carol', size: 'meaningful' }]);

  const multi = data.events.filter(e => e.type === 'pr' && e.id === 'shop#6');
  assert.deepEqual(multi.map(e => e.module), ['src-auth'], 'a 5% slice of a PR does not count for that module');

  const inc = data.events.find(e => e.type === 'incident');
  assert.deepEqual([inc.module, inc.detectedBy, inc.fixedBy, inc.durationH], ['src-payments', 'bob', ['carol'], 5]);
});

test('the engine accepts the mapped dataset and flags the rubber stamp', () => {
  const data = buildDataset(fixture(), {}, { now: '2026-10-07', months: 6 });
  const st = signals.computeState(data);
  assert.equal(st.coverageHistory.length, 7);
  assert.ok(st.feed.some(f => f.kind === 'review' && f.flag === 'shallow' && f.prId === 'shop#2'));
  assert.ok(st.feed.some(f => f.kind === 'erosion' && f.module === 'src-payments'));
  assert.ok(st.personView.carol);
});

test('configured modules: longest prefix wins, the rest falls into Other', () => {
  const raw = fixture();
  raw.pulls.push(pr(7, 'alice', '2026-09-01T10:00:00Z', [['docs/readme.md', 40, 0]]));
  const data = buildDataset(raw, {
    modules: [
      { name: 'Source', paths: ['src'] },
      { id: 'pay', name: 'Payments', paths: ['src/payments/'], criticality: 'critical' }
    ]
  }, { now: '2026-10-07' });
  assert.deepEqual(data.modules.map(m => m.id), ['source', 'pay', 'other']);
  assert.equal(data.events.find(e => e.id === 'shop#2').module, 'pay');
  assert.equal(data.events.find(e => e.id === 'shop#6').module, 'source');
  assert.equal(data.events.find(e => e.id === 'shop#7').module, 'other');
});

test('buildMonths ends each month on its last day and closes with Now', () => {
  assert.deepEqual(buildMonths('2026-03-15', 3), [
    { label: 'Dec 2025', end: '2025-12-31' },
    { label: 'Jan 2026', end: '2026-01-31' },
    { label: 'Feb 2026', end: '2026-02-28' },
    { label: 'Now', end: '2026-03-15' }
  ]);
});

test('ignore patterns and auto module keys', () => {
  const ig = makeIgnore(['dist/', '*.min.js', 'yarn.lock']);
  assert.ok(ig('dist/app.js'));
  assert.ok(ig('web/dist/app.js'));
  assert.ok(ig('a/b/c.min.js'));
  assert.ok(ig('packages/x/yarn.lock'));
  assert.ok(!ig('distribution/app.js'));
  assert.equal(autoKey('README.md'), '(root)');
  assert.equal(autoKey('src/index.js'), 'src');
  assert.equal(autoKey('src/auth/login.js'), 'src/auth');
  assert.equal(autoKey('web/app/page.tsx'), 'web');
});

test('agent detection', () => {
  assert.equal(detectAgent({ author: 'x', commitMessages: ['feat\n\nCo-Authored-By: Claude <noreply@anthropic.com>'] }).name, 'claude');
  assert.equal(detectAgent({ author: 'Copilot', authorType: 'Bot' }).name, 'copilot');
  assert.deepEqual(detectAgent({ author: 'dependabot[bot]', authorType: 'Bot' }).markers, []);
  assert.deepEqual(detectAgent({ author: 'x', headRef: 'feature/copilot' }).markers, []);
  assert.deepEqual(detectAgent({ author: 'x', headRef: 'bot-123' }, ['^bot-']).markers, ['custom:^bot-']);
});

test('injected data cannot break out of the script tag', () => {
  assert.ok(!dataScript({ title: '</script><script>alert(1)</script>' }).includes('</script>'));
});
