/*
 * Grasp — terminal weekly report. Module-level aggregates only: no individual scores.
 */
'use strict';

function wrap(text, indent) {
  return text.replace(/(.{90,100}) /g, '$1\n' + indent);
}

function printReport(data, st, opts) {
  opts = opts || {};
  var out = opts.write || function (s) { process.stdout.write(s + '\n'); };
  var modName = {};
  data.modules.forEach(function (m) { modName[m.id] = m.name; });
  var nameWidth = Math.max(15, Math.min(32, Math.max.apply(null, data.modules.map(function (m) { return m.name.length; })) + 2));

  out('\nGrasp — weekly report, ' + st.weeklyReport.label + (opts.replayed ? ' (replayed)' : ''));
  out('repo: ' + data.meta.repo + ' · ' + data.persons.length + ' engineers · ' + data.modules.length + ' modules\n');
  out('  ' + st.weeklyReport.headline + '\n');

  out('  Coverage (people with current understanding per module):');
  data.modules.forEach(function (m) {
    var ms = st.moduleStats[m.id];
    var bar = '';
    for (var i = 0; i < Math.min(ms.coverage, 5); i++) bar += '█';
    if (ms.coverage > 5) bar += ' ' + ms.coverage;
    var flag = ms.coverage === 0 ? '  ← ORPHANED' : ms.coverage === 1 ? '  ← fragile' : '';
    out('    ' + m.name.padEnd(nameWidth) + (bar || '·') + flag);
  });

  out('\n  Alerts:');
  if (!st.alerts.length) out('    none');
  st.alerts.forEach(function (a) {
    out('    [' + a.severity.toUpperCase() + '] ' + a.title);
    out('        ' + wrap(a.body, '        '));
  });

  out('\n  Suggested actions:');
  if (!st.weeklyReport.actions.length) out('    none');
  st.weeklyReport.actions.forEach(function (a) {
    out('    · [' + (modName[a.module] || a.module) + '] ' + a.text);
  });

  out('\n  KPIs: orphans=' + st.kpis.orphans +
    ' · fragile=' + st.kpis.fragile +
    ' · rubber-stamped(30d)=' + Math.round(st.kpis.shallowShare30d * 100) + '%' +
    ' · agent-written(90d)=' + Math.round(st.kpis.agentShare90d * 100) + '%' +
    ' · coverage-trend(3mo)=' + st.kpis.coverageTrend3mo);

  var s = data.meta.stats;
  if (s) {
    out('\n  Data: ' + s.prs + ' merged PRs (' + s.agentPrs + ' with agent markers) · ' +
      s.incidents + ' incidents mapped' + (s.unmappedIncidents ? ', ' + s.unmappedIncidents + ' without a closing PR' : '') +
      (s.skippedBots ? ' · ' + s.skippedBots + ' dependency-bot PRs skipped' : ''));
    if (data.meta.truncated) {
      out('  ! PR limit reached: history starts at ' + String(data.meta.oldestMerged).slice(0, 10) +
        ', not ' + data.meta.since + '. Raise --max-prs for a fuller warm-up.');
    }
    out('  Signals are proxies: agent detection is a lower bound, and review read-time is not visible via GitHub.');
  }
  out('');
}

module.exports = { printReport: printReport };
