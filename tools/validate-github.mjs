#!/usr/bin/env node
/*
 * Grasp — step-zero validation script.
 *
 * Measures one passive signal on a real GitHub repository:
 *   "large PRs approved suspiciously fast" — the fingerprint of code merging
 *   without anyone meaningfully reading it.
 *
 * Usage:
 *   node tools/validate-github.mjs owner/repo [--since=YYYY-MM-DD] [--min-lines=800]
 *        [--max-minutes=60] [--max-prs=200] [--json=out.json] [--selftest]
 *
 * GITHUB_TOKEN (optional) raises the rate limit from 60 to 5000 requests/hour.
 * Node 18+ (uses global fetch). No dependencies.
 */

import { writeFileSync } from 'node:fs';
import { createClient } from '../src/github.mjs';
import { detectAgent } from '../src/agents.mjs';

/* ---------------- args ---------------- */

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const hit = argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}
const repoArg = argv.find(a => !a.startsWith('--'));
const SINCE = arg('since', new Date(Date.now() - 182 * 86400000).toISOString().slice(0, 10));
const MIN_LINES = parseInt(arg('min-lines', '800'), 10);
const MAX_MINUTES = parseInt(arg('max-minutes', '60'), 10);
const MAX_PRS = parseInt(arg('max-prs', '200'), 10);
const JSON_OUT = arg('json', null);
const TOKEN = arg('token', process.env.GITHUB_TOKEN || '');

/* ---------------- github api & agent detection (shared with the grasp CLI) ---------------- */

const client = createClient({ token: TOKEN, userAgent: 'grasp-validation-script', log: m => console.error('\n' + m) });
const gh = client.gh;
const paginate = client.paginate;
const agentMarkers = pr => detectAgent(pr).markers;

/* ---------------- core aggregation (pure, testable) ---------------- */

export function analyze(rows, { minLines, maxMinutes }) {
  const merged = rows.filter(r => r.merged);
  const totalLines = merged.reduce((a, r) => a + (r.added || 0), 0);
  const big = merged.filter(r => (r.added || 0) >= minLines);
  const bigFast = big.filter(r => r.decisionMin != null && r.decisionMin <= maxMinutes);
  const noApproval = merged.filter(r => r.decisionMin == null);
  const agentPRs = merged.filter(r => r.agentMarkers && r.agentMarkers.length > 0);
  const agentLines = agentPRs.reduce((a, r) => a + (r.added || 0), 0);
  const bigFastLines = bigFast.reduce((a, r) => a + (r.added || 0), 0);
  const med = xs => {
    if (!xs.length) return null;
    const s = xs.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };
  return {
    mergedCount: merged.length,
    totalLines,
    bigCount: big.length,
    bigFastCount: bigFast.length,
    bigFastLines,
    bigFastLineShare: totalLines ? bigFastLines / totalLines : 0,
    bigFastShareOfBig: big.length ? bigFast.length / big.length : 0,
    medianBigDecisionMin: med(big.map(r => r.decisionMin).filter(x => x != null)),
    medianAllDecisionMin: med(merged.map(r => r.decisionMin).filter(x => x != null)),
    agentPrCount: agentPRs.length,
    agentLineShare: totalLines ? agentLines / totalLines : 0,
    mergedWithoutApproval: noApproval.length,
    topOffenders: bigFast
      .slice()
      .sort((a, b) => b.added / Math.max(1, b.decisionMin) - a.added / Math.max(1, a.decisionMin))
      .slice(0, 15)
  };
}

/* ---------------- selftest ---------------- */

function selftest() {
  const rows = [
    { merged: true, added: 2000, decisionMin: 5, agentMarkers: ['trailer-in-body'], number: 1, title: 'huge fast agent' },
    { merged: true, added: 1500, decisionMin: 240, agentMarkers: [], number: 2, title: 'big but read' },
    { merged: true, added: 100, decisionMin: 3, agentMarkers: [], number: 3, title: 'small fast (ignored)' },
    { merged: true, added: 900, decisionMin: null, agentMarkers: ['bot-account'], number: 4, title: 'no approval' },
    { merged: false, added: 5000, decisionMin: 1, agentMarkers: ['branch:copilot'], number: 5, title: 'never merged' }
  ];
  const a = analyze(rows, { minLines: 800, maxMinutes: 60 });
  const ok =
    a.mergedCount === 4 &&
    a.bigCount === 3 &&
    a.bigFastCount === 1 &&
    a.bigFastLines === 2000 &&
    a.agentPrCount === 2 &&
    a.mergedWithoutApproval === 1 &&
    a.medianBigDecisionMin === 123 &&
    Math.abs(a.bigFastLineShare - 2000 / 4500) < 1e-9;
  console.log(ok ? 'selftest: PASS' : 'selftest: FAIL\n' + JSON.stringify(a, null, 2));
  process.exit(ok ? 0 : 1);
}

if (argv.includes('--selftest')) selftest();

/* ---------------- main ---------------- */

if (!argv.includes('--selftest')) {
  if (!repoArg || !/^[^\/]+\/[^\/]+$/.test(repoArg)) {
    console.error('Usage: node tools/validate-github.mjs owner/repo [--since=YYYY-MM-DD] [--min-lines=800] [--max-minutes=60] [--max-prs=200] [--json=out.json]\n       (or --selftest to verify the aggregation logic offline)');
    process.exit(1);
  }

  const pct = x => Math.round(x * 100) + '%';
  const fmtInt = x => x.toLocaleString('en-US');
  const MIN = 60000;

  try {
    console.log(`\nGrasp validation — ${repoArg}`);
    console.log(`window: PRs merged since ${SINCE} · "big" = +${MIN_LINES} lines · "fast" = approved in ≤ ${MAX_MINUTES} min`);
    if (!TOKEN) console.log('! No GITHUB_TOKEN set — unauthenticated limit is 60 req/hour; keep --max-prs small.\n');

    process.stdout.write('Fetching closed PRs… ');
    const pulls = await paginate(
      `/repos/${repoArg}/pulls?state=closed&sort=updated&direction=desc`,
      {
        stopWhen: r => r.updated_at && r.updated_at.slice(0, 10) < SINCE,
        maxItems: Math.max(MAX_PRS * 3, 300)
      }
    );
    console.log(`${pulls.length} closed PRs scanned`);

    const candidates = pulls
      .filter(r => r.merged_at && r.merged_at.slice(0, 10) >= SINCE)
      .sort((a, b) => new Date(b.merged_at) - new Date(a.merged_at))
      .slice(0, MAX_PRS);

    const rows = [];
    let i = 0;
    for (const pr of candidates) {
      i++;
      process.stdout.write(`\r  analyzing PR ${i}/${candidates.length} (#${pr.number})   `);

      let detail = pr;
      if (pr.additions == null) {
        try { detail = await gh(`/repos/${repoArg}/pulls/${pr.number}`); }
        catch { /* private diffusion or deleted fork — skip details */ }
      }
      const added = detail.added ?? detail.additions ?? 0;

      let decisionMin = null;
      let reviewComments = 0;
      try {
        const reviews = await gh(`/repos/${repoArg}/pulls/${pr.number}/reviews?per_page=100`);
        const real = reviews.filter(r => r.user && !/\[bot\]$/.test(r.user.login));
        reviewComments = real.filter(r => r.body && r.body.trim()).length;
        const approval = real.find(r => r.state === 'APPROVED' && r.submitted_at && new Date(r.submitted_at) >= new Date(pr.created_at));
        if (approval) decisionMin = Math.max(0, Math.round((new Date(approval.submitted_at) - new Date(pr.created_at)) / MIN));
      } catch { /* reviews unavailable — treat as no-approval */ }

      rows.push({
        number: pr.number,
        title: (pr.title || '').slice(0, 60),
        merged: true,
        added,
        deleted: detail.deletions ?? 0,
        decisionMin,
        reviewComments,
        author: pr.user ? pr.user.login : '?',
        mergedAt: pr.merged_at,
        agentMarkers: agentMarkers(pr)
      });
    }
    console.log('');

    const a = analyze(rows, { minLines: MIN_LINES, maxMinutes: MAX_MINUTES });

    console.log('\n──────────────────────────────────────────────────────────');
    console.log(`Merged PRs analyzed:            ${a.mergedCount}`);
    console.log(`Merged lines changed:           ${fmtInt(a.totalLines)}`);
    console.log(`PRs ≥ +${MIN_LINES} lines:              ${a.bigCount}  (${pct(a.mergedCount ? a.bigCount / a.mergedCount : 0)} of merges)`);
    console.log(`…approved in ≤ ${MAX_MINUTES} min:        ${a.bigFastCount}  (${pct(a.bigFastShareOfBig)} of the big ones)`);
    console.log(`Lines merged via "big + fast":  ${fmtInt(a.bigFastLines)}  (${pct(a.bigFastLineShare)} of all merged lines)`);
    console.log(`Median approve time (big PRs):  ${a.medianBigDecisionMin ?? '—'} min`);
    console.log(`PRs with agent markers:         ${a.agentPrCount}  (${pct(a.agentLineShare)} of merged lines)`);
    console.log(`Merged with no human approval:  ${a.mergedWithoutApproval}`);
    console.log('──────────────────────────────────────────────────────────');

    if (a.topOffenders.length) {
      console.log('\nTop offenders (size ÷ approve-speed):');
      for (const r of a.topOffenders) {
        console.log(
          `  #${String(r.number).padEnd(6)} +${String(fmtInt(r.added)).padEnd(7)} ${String(r.decisionMin).padStart(5)} min  ${r.agentMarkers.length ? '🤖 ' + r.agentMarkers.join(',') + ' ' : ''}${r.title}`
        );
      }
    }

    const verdict =
      `${pct(a.bigFastLineShare)} of the lines merged into ${repoArg} since ${SINCE} landed through PRs of +${MIN_LINES}+ lines ` +
      `approved in under ${MAX_MINUTES} minutes.`;
    console.log('\n──────────────────────────────────────────────────────────');
    console.log('The sentence to show an engineering leader:');
    console.log(`  "${verdict}"`);
    console.log('  …then ask: "Does this number worry you?"');
    console.log('──────────────────────────────────────────────────────────');
    console.log('\nNote: approve-time uses the first human APPROVED review. PRs merged with no approval at all are counted separately.');
    console.log('Agent detection is heuristic (trailers in body, branch prefixes, bot accounts) — treat as a lower bound.');

    if (JSON_OUT) {
      writeFileSync(JSON_OUT, JSON.stringify({ repo: repoArg, since: SINCE, minLines: MIN_LINES, maxMinutes: MAX_MINUTES, aggregate: a, rows }, null, 2));
      console.log(`\nFull data written to ${JSON_OUT}`);
    }
  } catch (err) {
    console.error('\nError: ' + err.message);
    console.error('If your network blocks api.github.com, run the offline check: node tools/validate-github.mjs --selftest');
    process.exit(1);
  }
}
