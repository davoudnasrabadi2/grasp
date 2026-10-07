/*
 * Grasp — passive-signal engine & understanding model.
 *
 * UMD: in the browser it exposes window.GRASP_SIGNALS; in Node it works via require().
 * Pure, dependency-free, deterministic.
 *
 * Input  (data): { meta, persons, modules, oncall, events }
 * Output (state): scores matrix, coverage history, alerts, KPIs, weekly report, signal feed.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GRASP_SIGNALS = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    halfLifeDays: 150,     // understanding decays like memory
    threshold: 55,         // "current understanding" cutoff
    nearFloor: 35,         // lower bound of the "near threshold" bucket
    erosionFactor: 0.8     // how hard a full agent rewrite erases prior understanding
  };

  var WEIGHTS = {
    humanAuthoredSmall: 8,   // merged a small PR themselves (non-agent)
    humanAuthoredBig: 14,    // merged a substantial PR themselves
    agentAuthored: 2,        // prompted an agent PR: barely counts — they pressed the button
    meaningfulEdit: 18,      // deliberate manual edit after merge: strongest engagement signal
    smallEdit: 5,
    substantiveReview: 10,   // review with real content / effort proportional to size
    middleReview: 2,         // a real look, but light
    shallowApprove: 1,       // rubber-stamp approve: almost no credit
    incidentDiagnosis: 22,   // found the root cause in production
    incidentFix: 14          // fixed it
  };

  var T = {
    BIG_PR_LINES: 400,     // authorship credit tier
    SHALLOW_LINES: 300,    // below this many added lines, a fast approve is not "shallow"
    SHALLOW_MIN: 15,       // minutes — <15min on a 300+ line PR with zero comments = rubber stamp
    FASTBIG_LINES: 800,    // "big & fast" flag
    FASTBIG_MIN: 60
  };

  function ts(x) { return new Date(x).getTime(); }
  function daysBetween(a, b) { return (ts(b) - ts(a)) / 86400000; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function merge(a, b) {
    var out = {}; var k;
    for (k in a) out[k] = a[k];
    for (k in b) out[k] = b[k];
    return out;
  }

  function flagPR(pr) {
    var flags = [];
    if (pr.agent) flags.push('agent');
    if (pr.added >= T.SHALLOW_LINES && pr.decisionMin != null &&
        pr.decisionMin < T.SHALLOW_MIN && !(pr.comments > 0)) flags.push('shallow');
    if (pr.added >= T.FASTBIG_LINES && pr.decisionMin != null && pr.decisionMin < T.FASTBIG_MIN) flags.push('fast-big');
    if (pr.rewriteFraction) flags.push('rewrite');
    return flags;
  }

  function bucketOf(score, cfg) {
    if (score >= cfg.threshold) return 'fresh';
    if (score >= cfg.nearFloor) return 'near';
    return 'faded';
  }
  var BUCKET_LABEL = { fresh: 'current', near: 'near threshold', faded: 'faded' };

  /* ------------------------------------------------------------------ */

  function computeState(data, opts) {
    opts = opts || {};
    var cfg = merge(DEFAULTS, opts.config || {});
    var maxT = 0;
    data.events.forEach(function (e) { maxT = Math.max(maxT, ts(e.t)); });
    var at = ts(opts.at || data.meta.now || maxT);

    var personsById = {}; data.persons.forEach(function (p) { personsById[p.id] = p; });
    var modulesById = {}; data.modules.forEach(function (m) { modulesById[m.id] = m; });

    var scores = {};          // "person|module" -> { score, lastT }
    var feed = [];            // chronological signal feed
    var erosions = [];
    var snapshots = [];       // per meta.months entry: { label, coverage:{}, total }

    function key(p, m) { return p + '|' + m; }
    function decayOne(s, toT) {
      var d = (toT - s.lastT) / 86400000;
      if (d > 0) s.score *= Math.pow(0.5, d / cfg.halfLifeDays);
      s.lastT = toT;
    }
    function decayAll(toT) {
      for (var k in scores) decayOne(scores[k], toT);
    }
    function add(p, m, t, w) {
      if (!personsById[p] || !modulesById[m]) return;
      var s = scores[key(p, m)] || (scores[key(p, m)] = { score: 0, lastT: t });
      decayOne(s, t);
      s.score = clamp(s.score + w, 0, 100);
      s.lastTouched = Math.max(s.lastTouched || 0, t);
    }
    function erode(moduleId, t, fraction, prId) {
      decayAll(t);
      var factor = 1 - cfg.erosionFactor * fraction;
      var touched = 0;
      for (var k in scores) {
        if (k.indexOf('|' + moduleId) === k.length - moduleId.length - 1 && scores[k].score > 0) {
          scores[k].score *= factor; touched++;
        }
      }
      erosions.push({ t: t, module: moduleId, prId: prId, fraction: fraction, factor: factor, peopleAffected: touched });
      feed.push({
        t: t, kind: 'erosion', module: moduleId, prId: prId, fraction: fraction, factor: factor
      });
    }
    function snapshot(label, endT) {
      decayAll(endT);
      var coverage = {}; var total = 0;
      data.modules.forEach(function (m) {
        var c = 0;
        for (var k in scores) {
          if (k.indexOf('|' + m.id) === k.length - m.id.length - 1 && scores[k].score >= cfg.threshold) c++;
        }
        coverage[m.id] = c; total += c;
      });
      snapshots.push({ label: label, endT: endT, coverage: coverage, total: total });
    }

    // monthly snapshot schedule
    var monthPoints = (data.meta.months || []).map(function (m) {
      return { label: m.label, endT: ts(m.end) };
    });
    var mpi = 0;

    var events = data.events.slice().sort(function (a, b) { return ts(a.t) - ts(b.t); });

    events.forEach(function (e) {
      var et = ts(e.t);
      // take any snapshots whose month ended before this event
      while (mpi < monthPoints.length && monthPoints[mpi].endT < et) {
        snapshot(monthPoints[mpi].label, Math.min(monthPoints[mpi].endT, at));
        mpi++;
      }
      if (et > at) return; // don't apply events beyond the queried moment

      if (e.type === 'baseline') {
        // prior-history credit: what this person already understood at period start
        add(e.person, e.module, et, e.score);
      } else if (e.type === 'pr') {
        var flags = flagPR(e);
        var w = e.agent ? WEIGHTS.agentAuthored
          : (e.added >= T.BIG_PR_LINES ? WEIGHTS.humanAuthoredBig : WEIGHTS.humanAuthoredSmall);
        add(e.author, e.module, et, w);
        feed.push({
          t: e.t, kind: 'pr', id: e.id, module: e.module, title: e.title,
          author: e.author, agent: e.agent || null, added: e.added, deleted: e.deleted || 0,
          files: e.files || null, decisionMin: e.decisionMin, comments: e.comments || 0, flags: flags
        });
        if (e.rewriteFraction) erode(e.module, et, e.rewriteFraction, e.id);
      } else if (e.type === 'review') {
        var shallow = e.added >= T.SHALLOW_LINES && e.decisionMin != null &&
          e.decisionMin < T.SHALLOW_MIN && !(e.comments > 0);
        var substantive = !shallow &&
          (e.comments >= 2 || e.decisionMin >= Math.max(20, e.added / 40));
        var wRev = shallow ? WEIGHTS.shallowApprove
          : substantive ? WEIGHTS.substantiveReview : WEIGHTS.middleReview;
        add(e.person, e.module, et, wRev);
        if (shallow || substantive) {
          feed.push({
            t: e.t, kind: 'review', module: e.module, prId: e.prId, person: e.person,
            added: e.added, decisionMin: e.decisionMin, comments: e.comments || 0,
            flag: shallow ? 'shallow' : 'substantive'
          });
        }
      } else if (e.type === 'edit') {
        var wEdit = e.size === 'meaningful' ? WEIGHTS.meaningfulEdit : WEIGHTS.smallEdit;
        add(e.person, e.module, et, wEdit);
        if (e.size === 'meaningful') {
          feed.push({ t: e.t, kind: 'edit', module: e.module, person: e.person });
        }
      } else if (e.type === 'incident') {
        if (e.detectedBy && personsById[e.detectedBy]) add(e.detectedBy, e.module, et, WEIGHTS.incidentDiagnosis);
        (e.fixedBy || []).forEach(function (p) { add(p, e.module, et, WEIGHTS.incidentFix); });
        feed.push({
          t: e.t, kind: 'incident', id: e.id, module: e.module, title: e.title,
          detectedBy: e.detectedBy || null, fixedBy: e.fixedBy || [], durationH: e.durationH || null
        });
      }
    });

    while (mpi < monthPoints.length && monthPoints[mpi].endT <= at) {
      snapshot(monthPoints[mpi].label, monthPoints[mpi].endT);
      mpi++;
    }
    decayAll(at);

    /* ---------------- aggregate outputs ---------------- */

    var matrix = {};   // person -> module -> score
    var lastTouched = {};
    data.persons.forEach(function (p) { matrix[p.id] = {}; });
    data.modules.forEach(function (m) {
      data.persons.forEach(function (p) {
        var s = scores[key(p.id, m.id)];
        matrix[p.id][m.id] = s ? Math.round(s.score) : 0;
        if (s && s.lastTouched) {
          var k = p.id + '|' + m.id;
          lastTouched[k] = Math.round(daysBetween(s.lastTouched, at));
        }
      });
    });

    var coverageNow = {}; var buckets = {}; var moduleStats = {};
    data.modules.forEach(function (m) {
      var c = 0; var fresh = 0, near = 0, faded = 0;
      data.persons.forEach(function (p) {
        var sc = matrix[p.id][m.id];
        if (sc >= cfg.threshold) c++;
        if (sc >= cfg.threshold) fresh++; else if (sc >= cfg.nearFloor) near++; else faded++;
      });
      coverageNow[m.id] = c;
      buckets[m.id] = { fresh: fresh, near: near, faded: faded };

      var modEvents = feed.filter(function (f) { return f.module === m.id; });
      var prs30 = modEvents.filter(function (f) { return f.kind === 'pr' && daysBetween(f.t, at) <= 30; });
      var lines30 = prs30.reduce(function (a, f) { return a + f.added; }, 0);
      var shallow30 = prs30.filter(function (f) { return f.flags.indexOf('shallow') >= 0; })
        .reduce(function (a, f) { return a + f.added; }, 0);
      var agent90 = modEvents.filter(function (f) { return f.kind === 'pr' && daysBetween(f.t, at) <= 90; });
      var agentLines90 = agent90.filter(function (f) { return f.agent; }).reduce(function (a, f) { return a + f.added; }, 0);
      var allLines90 = agent90.reduce(function (a, f) { return a + f.added; }, 0);
      var incidents6mo = modEvents.filter(function (f) { return f.kind === 'incident' && daysBetween(f.t, at) <= 180; });
      var bigAgent21 = modEvents.filter(function (f) {
        return f.kind === 'pr' && f.agent && f.added >= T.BIG_PR_LINES && daysBetween(f.t, at) <= 21;
      });
      var lastIncident = incidents6mo.length ? incidents6mo[incidents6mo.length - 1] : null;

      moduleStats[m.id] = {
        coverage: c,
        spark: snapshots.map(function (s) { return s.coverage[m.id]; }),
        buckets: buckets[m.id],
        shallowShare30d: lines30 ? shallow30 / lines30 : 0,
        agentShare90d: allLines90 ? agentLines90 / allLines90 : 0,
        incidents6mo: incidents6mo.length,
        lastIncident: lastIncident,
        bigAgent21d: bigAgent21.length,
        bigAgent21dLines: bigAgent21.reduce(function (a, f) { return a + f.added; }, 0),
        rewroteFractionRecent: erosions
          .filter(function (e) { return e.module === m.id && daysBetween(e.t, at) <= 60; })
          .reduce(function (a, e) { return a + e.fraction; }, 0)
      };
    });

    var allLines30 = feed.filter(function (f) { return f.kind === 'pr' && daysBetween(f.t, at) <= 30; });
    var totLines30 = allLines30.reduce(function (a, f) { return a + f.added; }, 0);
    var shallowLines30 = allLines30.filter(function (f) { return f.flags.indexOf('shallow') >= 0; })
      .reduce(function (a, f) { return a + f.added; }, 0);
    var allLines90 = feed.filter(function (f) { return f.kind === 'pr' && daysBetween(f.t, at) <= 90; });
    var totLines90 = allLines90.reduce(function (a, f) { return a + f.added; }, 0);
    var agentLines90 = allLines90.filter(function (f) { return f.agent; }).reduce(function (a, f) { return a + f.added; }, 0);

    var totalCoverageNow = snapshots.length ? snapshots[snapshots.length - 1].total : 0;
    var totalCoverage3moAgo = 0;
    if (snapshots.length) {
      var target = at - 92 * 86400000;
      var best = snapshots[0];
      snapshots.forEach(function (s) { if (Math.abs(s.endT - target) < Math.abs(best.endT - target)) best = s; });
      totalCoverage3moAgo = best.total;
    }

    /* ---------------- alerts ---------------- */

    var alerts = [];
    data.modules.forEach(function (m) {
      var st = moduleStats[m.id];
      var cov = st.coverage;
      var spark = st.spark;
      var hadCoverage = spark.some(function (c) { return c >= 1; });
      var prev = spark.length >= 2 ? spark[spark.length - 2] : cov;
      var modName = m.name;

      if (cov === 0 && hadCoverage) {
        var critical = st.incidents6mo > 0 || m.criticality === 'critical';
        var lines = [];
        if (st.bigAgent21d > 0) {
          lines.push(st.bigAgent21d + ' large agent-authored PRs (+' +
            st.bigAgent21dLines.toLocaleString('en-US') + ' lines) merged in the last 3 weeks' +
            (st.rewroteFractionRecent > 0
              ? ', rewriting ~' + Math.round(st.rewroteFractionRecent * 100) + '% of the module'
              : '') + '.');
        }
        lines.push('Understanding coverage is now 0 — no one on the team currently understands this module.');
        if (st.incidents6mo > 0) {
          lines.push(st.incidents6mo + ' production incident' + (st.incidents6mo > 1 ? 's' : '') +
            ' in the past 6 months' + (st.lastIncident ? ' (latest: ' + st.lastIncident.title + ')' : '') + '.');
        }
        alerts.push({
          id: 'orphan-' + m.id, severity: critical ? 'critical' : 'high', module: m.id,
          title: modName + ' is orphaned',
          body: lines.join(' '),
          actions: [
            'Assign a temporary owner and run a pairing session this week.',
            'Build a guided review tour for ' + modName + ' before the next on-call rotation.',
            'Freeze large agent-driven changes in ' + modName + ' until coverage is restored.'
          ]
        });
      } else if (prev === 0 && cov >= 1) {
        alerts.push({
          id: 'improving-' + m.id, severity: 'info', module: m.id,
          title: modName + ' is recovering',
          body: 'Coverage came back from 0 to ' + cov + '. The person rebuilding understanding got there through incident response and hands-on edits — protect that momentum.',
          actions: ['Keep agent rewrites out of ' + modName + ' for one more month to let understanding consolidate.']
        });
      } else if (cov === 1 && prev >= 2) {
        alerts.push({
          id: 'fading-' + m.id, severity: 'high', module: m.id,
          title: modName + ' is down to one person',
          body: 'Coverage dropped from ' + prev + ' to 1 recently. Erosion from agent rewrites and natural decay are outpacing engagement.',
          actions: ['Schedule a 30-minute knowledge-transfer session for ' + modName + '.']
        });
      } else if (cov === 1) {
        alerts.push({
          id: 'single-' + m.id, severity: 'medium', module: m.id,
          title: modName + ' has a bus factor of 1',
          body: 'Only one person currently understands this module. If they are unavailable, you are orphaned.',
          actions: ['Pair a second engineer on the next ' + modName + ' change.']
        });
      }
      if (st.shallowShare30d >= 0.5 && st.agentShare90d >= 0.4) {
        alerts.push({
          id: 'risky-merge-' + m.id, severity: 'high', module: m.id,
          title: 'Unread code is merging into ' + modName,
          body: Math.round(st.shallowShare30d * 100) + '% of lines merged into ' + modName +
            ' in the last 30 days came from rubber-stamped PRs (big diffs approved in minutes, no comments).',
          actions: ['Add a branch-protection rule: PRs of +800 lines or more in ' + modName +
            ' require a review with proportionate read time.']
        });
      }
    });
    var SEV = { critical: 0, high: 1, medium: 2, info: 3 };
    alerts.sort(function (a, b) { return SEV[a.severity] - SEV[b.severity]; });

    /* ---------------- weekly report ---------------- */

    var orphanCount = data.modules.filter(function (m) { return coverageNow[m.id] === 0; }).length;
    var fragileCount = alerts.filter(function (a) { return a.severity === 'high' || a.severity === 'medium'; }).length;
    var delta = totalCoverageNow - totalCoverage3moAgo;
    var weeklyReport = {
      label: 'Week of ' + new Date(at).toISOString().slice(0, 10),
      headline: delta < 0
        ? 'Understanding debt grew again: ' + Math.abs(delta) + ' fewer current-understanding slots than three months ago.'
        : (delta > 0 ? 'Coverage improved by ' + delta + ' slots over three months.' : 'Coverage is flat versus three months ago.'),
      stats: [
        { label: 'Orphaned modules', value: orphanCount, tone: orphanCount ? 'bad' : 'good' },
        { label: 'Fragile modules', value: fragileCount, tone: fragileCount ? 'warn' : 'good' },
        { label: 'Rubber-stamped merge share (30d)', value: pct(totLines30 ? shallowLines30 / totLines30 : 0), tone: 'warn' },
        { label: 'Agent-authored lines (90d)', value: pct(totLines90 ? agentLines90 / totLines90 : 0), tone: 'neutral' }
      ],
      alerts: alerts.slice(0, 4),
      actions: (function () {
        var seen = {}; var out = [];
        alerts.forEach(function (a) {
          if (out.length >= 4) return;
          (a.actions || []).forEach(function (act) {
            if (out.length < 4 && !seen[act]) { seen[act] = 1; out.push({ module: a.module, text: act }); }
          });
        });
        return out;
      })()
    };

    /* ---------------- per-person view (private data) ---------------- */

    var personView = {};
    data.persons.forEach(function (p) {
      var mods = data.modules.map(function (m) {
        var sc = matrix[p.id][m.id];
        return {
          id: m.id, name: m.name, score: sc, bucket: bucketOf(sc, cfg),
          bucketLabel: BUCKET_LABEL[bucketOf(sc, cfg)],
          lastTouchedDays: lastTouched[p.id + '|' + m.id] != null ? lastTouched[p.id + '|' + m.id] : null
        };
      }).sort(function (a, b) { return b.score - a.score; });
      personView[p.id] = { modules: mods };
    });
    if (data.oncall) {
      var oc = data.oncall;
      var prep = (oc.modules || []).map(function (mid) {
        var sc = matrix[oc.personId] ? matrix[oc.personId][mid] : 0;
        return { id: mid, name: modulesById[mid] ? modulesById[mid].name : mid, score: sc, bucket: bucketOf(sc, cfg) };
      });
      personView[oc.personId] = personView[oc.personId] || { modules: [] };
      personView[oc.personId].oncall = {
        startsAt: oc.startsAt, modules: prep,
        stale: prep.filter(function (x) { return x.bucket !== 'fresh'; })
      };
    }

    return {
      config: cfg,
      at: at,
      matrix: matrix,
      coverageNow: coverageNow,
      buckets: buckets,
      moduleStats: moduleStats,
      snapshots: snapshots,
      coverageHistory: snapshots.map(function (s) { return { label: s.label, coverage: s.coverage, total: s.total }; }),
      alerts: alerts,
      kpis: {
        orphans: orphanCount,
        fragile: fragileCount,
        shallowShare30d: totLines30 ? shallowLines30 / totLines30 : 0,
        agentShare90d: totLines90 ? agentLines90 / totLines90 : 0,
        coverageTrend3mo: delta,
        totalCoverageNow: totalCoverageNow
      },
      weeklyReport: weeklyReport,
      feed: feed.sort(function (a, b) { return ts(b.t) - ts(a.t); }),
      erosions: erosions,
      personView: personView
    };
  }

  return {
    WEIGHTS: WEIGHTS,
    THRESHOLDS: T,
    DEFAULTS: DEFAULTS,
    computeState: computeState,
    flagPR: flagPR,
    bucketOf: bucketOf,
    BUCKET_LABEL: BUCKET_LABEL
  };
});
