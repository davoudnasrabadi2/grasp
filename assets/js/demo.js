/* Grasp — dashboard app. Renders the computed state of window.GRASP_DEMO
 * through the GRASP_SIGNALS engine. No framework, no build step. */
(function () {
  'use strict';

  var DATA = window.GRASP_DEMO;
  var S = window.GRASP_SIGNALS;
  var FULL = S.computeState(DATA);
  var LIVE = DATA.meta.mode === 'live';   // real repo via the CLI, not the simulated team
  var LAST = DATA.meta.months.length - 1;

  var personsById = {}; DATA.persons.forEach(function (p) { personsById[p.id] = p; });
  var modulesById = {}; DATA.modules.forEach(function (m) { modulesById[m.id] = m; });

  var HEAT_CLASS = ['c0', 'c1', 'c2', 'c3', 'c4'];
  var BUCKET_COLOR = { fresh: 'var(--green)', near: 'var(--amber)', faded: 'var(--red)' };

  /* ---------------- tiny dom helpers ---------------- */

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function byId(id) { return document.getElementById(id); }
  function fmtPct(x) { return Math.round(x * 100) + '%'; }
  function initials(name) {
    return name.split(' ').map(function (w) { return w[0]; }).slice(0, 2).join('');
  }
  function shortId(id) { return String(id).replace(/^[^#]*#/, '#'); }
  function personName(id) { return personsById[id] ? personsById[id].name : id; }
  function fmtDate(t) {
    var d = new Date(t);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function sparkline(values, color, w, h) {
    w = w || 240; h = h || 56;
    var max = Math.max.apply(null, values.concat([1]));
    var pts = values.map(function (v, i) {
      var x = 8 + i * ((w - 16) / Math.max(1, values.length - 1));
      var y = h - 8 - (v / max) * (h - 18);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    var last = pts[pts.length - 1].split(',');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + (color || 'var(--accent)') + '" stroke-width="2" stroke-linejoin="round"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="3" fill="' + (color || 'var(--accent)') + '"/></svg>';
  }

  /* ---------------- tabs ---------------- */

  byId('tabs').addEventListener('click', function (e) {
    var btn = e.target.closest('button'); if (!btn) return;
    var view = btn.getAttribute('data-view');
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('active', b === btn); });
    ['manager', 'person', 'feed', 'about'].forEach(function (v) {
      byId('view-' + v).style.display = v === view ? '' : 'none';
    });
  });

  /* ---------------- manager view ---------------- */

  function heatClass(c) { return HEAT_CLASS[Math.min(c, 4)]; }

  function renderHeatmap(scrubIdx) {
    var wrap = byId('heatmap');
    wrap.innerHTML = '';
    var hist = FULL.coverageHistory;
    var head = el('div', { class: 'hrow' });
    head.appendChild(el('span', { class: 'hlabel' }));
    hist.forEach(function (h) { head.appendChild(el('span', { class: 'hmonth', text: h.label.replace(' 20', ' ‘') })); });
    wrap.appendChild(head);

    DATA.modules.forEach(function (m) {
      var row = el('div', { class: 'hrow' });
      var dotClass = m.criticality === 'critical' ? 'critical' : m.criticality === 'high' ? 'high' : 'low';
      row.appendChild(el('span', {
        class: 'hlabel', onclick: function () { openModule(m.id); }
      }));
      row.lastChild.innerHTML = '<span class="crit-dot ' + dotClass + '"></span>' + esc(m.name);
      hist.forEach(function (h, i) {
        var c = h.coverage[m.id];
        row.appendChild(el('i', {
          class: 'hcell ' + heatClass(c) + (i > scrubIdx ? ' past' : ''),
          title: m.name + ' · ' + h.label + ' · coverage: ' + c + ' — click for module view',
          onclick: function () { openModule(m.id); }
        }));
      });
      wrap.appendChild(row);
    });
  }

  function renderKPIs(st) {
    var k = st.kpis;
    var trend = k.coverageTrend3mo;
    var cards = [
      { label: 'Orphaned modules', value: k.orphans, sub: 'coverage = 0', tone: k.orphans ? 'bad' : 'good' },
      { label: 'Fragile modules', value: k.fragile, sub: 'bus factor 1 / fading', tone: k.fragile ? 'warn' : 'good' },
      { label: 'Rubber-stamped merges', value: fmtPct(k.shallowShare30d), sub: 'share of lines, last 30 days', tone: 'warn' },
      { label: 'Agent-written lines', value: fmtPct(k.agentShare90d), sub: 'share of merged lines, 90 days', tone: 'neutral' },
      {
        label: 'Coverage trend (3 mo)', value: (trend > 0 ? '+' : '') + trend,
        sub: 'understanding slots vs 3 months ago', tone: trend < 0 ? 'bad' : trend > 0 ? 'good' : 'neutral'
      }
    ];
    var wrap = byId('kpis');
    wrap.innerHTML = '';
    cards.forEach(function (c) {
      wrap.appendChild(el('div', { class: 'kpi ' + c.tone },
        '<div class="k-label">' + esc(c.label) + '</div><div class="k-value">' + esc(String(c.value)) + '</div><div class="k-sub">' + esc(c.sub) + '</div>'));
    });
  }

  function renderAlerts(st) {
    var wrap = byId('alerts');
    wrap.innerHTML = '';
    if (!st.alerts.length) {
      wrap.appendChild(el('p', { class: 'panel-sub', text: 'No alerts — every module currently has coverage.' }));
      return;
    }
    st.alerts.forEach(function (a) {
      var item = el('div', { class: 'alert-item ' + a.severity });
      item.appendChild(el('div', { class: 'a-head' },
        '<span class="sev-dot ' + a.severity + '"></span><span class="a-title">' + esc(a.title) + '</span>' +
        '<button class="a-mod" style="margin-left:auto">' + esc(modulesById[a.module].name) + '</button>'));
      item.querySelector('.a-mod').addEventListener('click', function () { openModule(a.module); });
      item.appendChild(el('div', { class: 'a-body', text: a.body }));
      wrap.appendChild(item);
    });
  }

  function renderReport(st) {
    var r = st.weeklyReport;
    byId('reportTitle').textContent = 'Weekly report — ' + r.label;
    byId('reportHeadline').textContent = r.headline;
    var stats = byId('reportStats');
    stats.innerHTML = '';
    r.stats.forEach(function (s) {
      var tone = s.tone === 'bad' ? 'bad' : s.tone === 'warn' ? 'warn' : s.tone === 'good' ? 'good' : '';
      stats.appendChild(el('div', { class: 'm-stat' },
        '<div class="v" style="' + (tone ? 'color:var(--' + (tone === 'bad' ? 'red' : tone === 'warn' ? 'amber' : 'green') + ')' : '') + '">' + esc(String(s.value)) + '</div><div class="l">' + esc(s.label) + '</div>'));
    });
    var acts = byId('reportActions');
    acts.innerHTML = '';
    r.actions.forEach(function (a) {
      acts.appendChild(el('li', {},
        '<strong>' + esc(modulesById[a.module].name) + ':</strong> ' + esc(a.text)));
    });
    byId('reportSpark').innerHTML = sparkline(FULL.coverageHistory.map(function (h) { return h.total; }));
  }

  /* ---------------- time scrubber ---------------- */

  var slider = byId('timeSlider');
  slider.addEventListener('input', function () { scrub(parseInt(slider.value, 10)); });

  function scrub(idx) {
    var months = DATA.meta.months;
    var at = months[idx].end;
    byId('timeLabel').textContent = months[idx].label;
    var st = idx >= months.length - 1 ? FULL : S.computeState(DATA, { at: at });
    renderHeatmap(idx);
    renderKPIs(st);
    renderAlerts(st);
    renderReport(st);
  }

  /* ---------------- module modal ---------------- */

  function feedEventText(f) {
    if (f.kind === 'pr') {
      return 'PR ' + shortId(f.id) + ' — ' + esc(f.title) +
        ' <span class="t-dim">(+' + f.added.toLocaleString('en-US') + ' lines' +
        (f.agent ? ', agent-written' : '') +
        (f.decisionMin != null ? ', approved in ' + f.decisionMin + ' min' : '') + ')</span>';
    }
    if (f.kind === 'review') {
      return esc(personName(f.person)) + ' reviewed ' + esc(shortId(f.prId)) +
        ' <span class="t-dim">(' + f.decisionMin + ' min, ' + f.comments + ' comments — ' +
        (f.flag === 'shallow' ? 'rubber-stamp' : 'substantive') + ')</span>';
    }
    if (f.kind === 'incident') {
      return esc(f.id) + ' — ' + esc(f.title) +
        ' <span class="t-dim">(detected by ' + (f.detectedBy ? esc(personName(f.detectedBy)) : (LIVE ? 'someone outside the team' : 'support')) +
        (f.fixedBy && f.fixedBy.length ? ', fixed by ' + f.fixedBy.map(function (p) { return esc(personName(p)); }).join(', ') : ', no internal fixer') + ')</span>';
    }
    if (f.kind === 'erosion') {
      return 'Agent rewrite — ' + Math.round(f.fraction * 100) + '% of the module replaced <span class="t-dim">(everyone\'s score ×' + f.factor.toFixed(2) + ')</span>';
    }
    if (f.kind === 'edit') {
      return esc(personName(f.person)) + ' made a meaningful manual edit <span class="t-dim">(hands-on engagement signal)</span>';
    }
    return '';
  }
  function feedIcon(f) {
    if (f.kind === 'incident') return '🔥';
    if (f.kind === 'erosion') return '🌊';
    if (f.kind === 'edit') return '✍️';
    if (f.kind === 'review') return f.flag === 'shallow' ? '⏱️' : '💬';
    if (f.kind === 'pr') return f.agent ? '🤖' : '📦';
    return '•';
  }

  function openModule(mid) {
    var m = modulesById[mid];
    var ms = FULL.moduleStats[mid];
    var b = ms.buckets;
    var modAlerts = FULL.alerts.filter(function (a) { return a.module === mid; });
    var events = FULL.feed.filter(function (f) { return f.module === mid; }).slice(0, 8);

    var html = '<button class="m-close" id="mClose">×</button>' +
      '<h3>' + esc(m.name) + ' <span class="badge ' + (m.criticality === 'critical' ? 'red' : m.criticality === 'high' ? 'amber' : '') + '" style="vertical-align:3px">' + esc(m.criticality) + '</span></h3>' +
      '<div class="m-path">' + esc(m.path) + (m.desc ? ' · ' + esc(m.desc) : '') + '</div>' +
      '<div class="m-stats">' +
      '<div class="m-stat"><div class="v">' + ms.coverage + '</div><div class="l">coverage now (people with current understanding)</div></div>' +
      '<div class="m-stat"><div class="v">' + b.fresh + ' / ' + b.near + ' / ' + b.faded + '</div><div class="l">team: current / near / faded — aggregated, anonymized</div></div>' +
      '<div class="m-stat"><div class="v">' + ms.incidents6mo + '</div><div class="l">production incidents, 6 months</div></div>' +
      '</div>' +
      '<div style="margin:6px 0 14px">' +
      '<p style="font-size:12px;color:var(--faint);margin:0 0 4px">Coverage, ' + LAST + ' months</p>' +
      sparkline(ms.spark, 'var(--accent)', 600, 48) + '</div>' +
      '<p style="font-size:13.5px;color:var(--muted);margin:0 0 4px">' +
      'Last 30 days: <strong style="color:var(--text)">' + fmtPct(ms.shallowShare30d) + '</strong> of merged lines were rubber-stamped · ' +
      'last 90 days: <strong style="color:var(--text)">' + fmtPct(ms.agentShare90d) + '</strong> agent-written.</p>';

    if (modAlerts.length) {
      html += '<div style="margin:14px 0 4px;font-size:13px;color:var(--faint)">What Grasp recommends</div><ul class="report-actions">' +
        modAlerts.map(function (a) {
          return a.actions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
        }).join('') + '</ul>';
    }
    html += '<div style="margin:16px 0 4px;font-size:13px;color:var(--faint)">Recent signals for this module</div><div class="m-events">' +
      events.map(function (f) {
        return '<div class="m-event"><span>' + feedIcon(f) + '</span><span><span class="t-date">' + fmtDate(f.t) + '</span> — ' + feedEventText(f) + '</span></div>';
      }).join('') + '</div>' +
      '<div class="m-privacy">🔒 Individual understanding scores for this module are visible only to each person. This view shows aggregates only.</div>';

    byId('modalContent').innerHTML = html;
    byId('modalBackdrop').classList.add('open');
    byId('mClose').addEventListener('click', closeModal);
  }
  function closeModal() { byId('modalBackdrop').classList.remove('open'); }
  byId('modalBackdrop').addEventListener('click', function (e) {
    if (e.target === byId('modalBackdrop')) closeModal();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  /* ---------------- person view ---------------- */

  // Live mode honours the privacy rule for real: only the person who ran the analysis sees a profile.
  var currentPerson = LIVE ? DATA.meta.viewer : (DATA.oncall ? DATA.oncall.personId : DATA.persons[0].id);

  function renderPersonChips() {
    var wrap = byId('personChips');
    wrap.innerHTML = '';
    var people = LIVE ? DATA.persons.filter(function (p) { return p.id === currentPerson; }) : DATA.persons;
    people.forEach(function (p) {
      var chip = el('button', { class: 'person-chip' + (p.id === currentPerson ? ' active' : '') });
      chip.innerHTML = '<span class="avatar" style="background:hsl(' + p.hue + ',70%,62%)">' + esc(initials(p.name)) + '</span>' +
        '<span><span class="pc-name">' + esc(p.name) + '</span><br><span class="pc-role">' + esc(p.role) + '</span></span>';
      chip.addEventListener('click', function () { currentPerson = p.id; renderPersonView(); });
      wrap.appendChild(chip);
    });
  }

  function renderPersonBars() {
    var pv = FULL.personView[currentPerson];
    var wrap = byId('personBars');
    wrap.innerHTML = '';
    if (!pv) {
      wrap.appendChild(el('p', { class: 'panel-sub' },
        DATA.meta.viewerLogin
          ? 'No activity from <strong>@' + esc(DATA.meta.viewerLogin) + '</strong> in this repository\'s window, so there is no profile to show.'
          : 'Run <code>grasp analyze</code> with your own GitHub token to see your private profile. Grasp never shows anyone else\'s individual scores.'));
      return;
    }
    pv.modules.forEach(function (m) {
      var p = modulesById[m.id];
      var row = el('div', { class: 'score-row' });
      var lastTouch = m.lastTouchedDays != null ? m.lastTouchedDays + 'd ago' : 'never';
      row.innerHTML =
        '<div><div class="s-name">' + esc(m.name) + '</div><div class="s-path">' + esc(p.path) + '</div></div>' +
        '<div class="score-bar"><div class="fill" style="width:' + m.score + '%;background:' + BUCKET_COLOR[m.bucket] + '"></div>' +
        '<div class="tick" style="left:55%"></div></div>' +
        '<div class="s-side"><span class="v">' + m.score + '</span> · ' + esc(m.bucketLabel) + '<br>last hands-on: ' + lastTouch + '</div>';
      wrap.appendChild(row);
    });
  }

  function renderOncall() {
    var card = byId('oncallCard');
    var pv = FULL.personView[currentPerson];
    if (LIVE) { card.style.display = 'none'; return; }
    if (!pv.oncall) {
      card.innerHTML = '<span class="badge">on-call</span><h3 style="margin-top:10px">No shift scheduled</h3>' +
        '<p class="panel-sub">Before your next rotation, Grasp will brief you on the stale parts of your zone — rewritten modules you haven\'t seen, new failure modes, a 10-minute refresher.</p>';
      return;
    }
    var oc = pv.oncall;
    var html = '<span class="badge blue">on-call · starts ' + fmtDate(oc.startsAt) + ', 18:00</span>' +
      '<h3 style="margin-top:10px">Your zone, honestly assessed</h3>' +
      '<p class="panel-sub">Modules in tonight\'s rotation, and how current <em>your</em> understanding of each is.</p>';
    oc.modules.forEach(function (m) {
      var tone = m.bucket === 'fresh' ? 'green' : m.bucket === 'near' ? 'amber' : 'red';
      html += '<div class="oc-mod"><span>' + esc(m.name) + '</span><span class="badge ' + tone + '">' + m.score + ' · ' + esc(m.bucket) + '</span></div>';
    });
    if (oc.stale.length) {
      var names = oc.stale.map(function (m) { return m.name; }).join(' and ');
      html += '<p style="font-size:13.5px;color:var(--muted);margin:12px 0">' + esc(names) +
        ' ' + (oc.stale.length > 1 ? 'have' : 'has') + ' changed materially since you last worked on ' +
        (oc.stale.length > 1 ? 'them' : 'it') + ' — agent rewrites and review drift. A short refresher now beats a surprise at 3 a.m.</p>' +
        '<button class="btn small primary" id="ocTourBtn">Start 10-minute refresher</button>';
    }
    card.innerHTML = html;
    var btn = byId('ocTourBtn');
    if (btn) btn.addEventListener('click', function () {
      byId('tourCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  /* ---------------- guided tour widget (phase-2 preview) ---------------- */

  var TOUR = {
    pr: 'PR #509 — Consolidate duplicate charge paths',
    meta: '+2,340 lines · agent-authored · approved in 9 minutes · 0 comments',
    steps: [
      {
        head: 'Step 1 of 2 — what changed',
        body: 'The agent rewrote cart normalization: <code>normalizeCart</code> now dedupes line items and moves coupon validation earlier in the pipeline. Total charge calculation moved to a shared helper used by both checkout paths — the duplicate logic the diff deleted was genuinely duplicated before.',
        cta: 'Next: one prediction question'
      }
    ],
    question: 'A user hits Pay with an empty cart. What does normalizeCart return?',
    options: [
      { t: 'It throws PaymentValidationError', correct: false },
      { t: 'null — the "not payable" signal', correct: true },
      { t: 'An order object with amount 0', correct: false },
      { t: 'An HTTP 400 reaches the client directly', correct: false }
    ],
    explain: 'The early path survived the rewrite: <code>if (!cart || cart.items.length === 0) return null;</code> — null means "nothing to charge" and the checkout layer shows the empty-cart message. The subtle behavior change in this PR was negative-coupon handling, not the empty-cart path. If you got this wrong, that\'s exactly the kind of gap the tour exists to surface — before production does.'
  };

  var tourStep = 0;
  var tourAnswered = false;

  function renderTour() {
    var wrap = byId('tourBody');
    if (tourStep === 0) {
      wrap.innerHTML = '<div class="tour-step"><div class="mono" style="font-size:12px;color:var(--faint)">' + esc(TOUR.pr) + '</div>' +
        '<div style="font-size:13px;color:var(--muted);margin-top:4px">' + esc(TOUR.meta) + '</div>' +
        '<p style="font-size:13.5px;color:var(--text);margin:12px 0 12px">A 2-minute walkthrough of what actually changed — with one prediction question inside. Voluntary, unrecorded, no score.</p>' +
        '<button class="btn small primary" id="tourStart">Start the tour</button></div>';
      byId('tourStart').addEventListener('click', function () { tourStep = 1; renderTour(); });
    } else if (tourStep === 1) {
      var s = TOUR.steps[0];
      wrap.innerHTML = '<div class="tour-step"><div class="mono" style="font-size:12px;color:var(--accent)">' + esc(s.head) + '</div>' +
        '<p style="font-size:13.5px;color:var(--muted);margin:8px 0 12px">' + s.body + '</p>' +
        '<button class="btn small primary" id="tourNext">' + esc(s.cta) + '</button></div>';
      byId('tourNext').addEventListener('click', function () { tourStep = 2; renderTour(); });
    } else {
      var html = '<div class="tour-step"><p class="tour-q">' + esc(TOUR.question) + '</p>';
      TOUR.options.forEach(function (o, i) {
        var cls = 'tour-opt' + (tourAnswered ? (o.correct ? ' correct' : '') : '');
        html += '<button class="' + cls + '" data-i="' + i + '" ' + (tourAnswered ? 'disabled' : '') + '>' + esc(o.t) + '</button>';
      });
      if (tourAnswered) {
        html += '<div class="tour-explain">' + TOUR.explain + '</div>' +
          '<div class="tour-note">🔒 Nothing was recorded — tours never produce scores and never enter any report.</div>' +
          '<button class="btn small" id="tourRestart" style="margin-top:10px">Close tour</button>';
      }
      html += '</div>';
      wrap.innerHTML = html;
      if (!tourAnswered) {
        wrap.querySelectorAll('.tour-opt').forEach(function (b) {
          b.addEventListener('click', function () {
            tourAnswered = true;
            renderTour();
          });
        });
      } else {
        byId('tourRestart').addEventListener('click', function () { tourStep = 0; tourAnswered = false; renderTour(); });
      }
    }
  }

  function renderPersonView() {
    renderPersonChips();
    renderPersonBars();
    renderOncall();
  }

  /* ---------------- feed view ---------------- */

  var FILTERS = [
    { id: 'all', label: 'All signals', test: function () { return true; } },
    { id: 'shallow', label: '⏱️ Rubber-stamped approvals', test: function (f) {
        return (f.kind === 'pr' && f.flags.indexOf('shallow') >= 0) || (f.kind === 'review' && f.flag === 'shallow');
      } },
    { id: 'agent', label: '🤖 Agent-authored PRs', test: function (f) { return f.kind === 'pr' && f.agent; } },
    { id: 'rewrite', label: '🌊 Agent rewrites (erosion)', test: function (f) { return f.kind === 'erosion'; } },
    { id: 'incident', label: '🔥 Incidents', test: function (f) { return f.kind === 'incident'; } },
    { id: 'substantive', label: '💬 Substantive reviews', test: function (f) { return f.kind === 'review' && f.flag === 'substantive'; } },
    { id: 'edit', label: '✍️ Hands-on edits', test: function (f) { return f.kind === 'edit'; } }
  ];
  var currentFilter = LIVE ? 'all' : 'shallow';

  function renderFeedFilters() {
    var wrap = byId('feedFilters');
    wrap.innerHTML = '';
    FILTERS.forEach(function (f) {
      var c = el('button', { class: 'chip' + (f.id === currentFilter ? ' active' : ''), text: f.label });
      c.addEventListener('click', function () { currentFilter = f.id; renderFeedFilters(); renderFeed(); });
      wrap.appendChild(c);
    });
  }

  function renderFeed() {
    var f = FILTERS.filter(function (x) { return x.id === currentFilter; })[0];
    var rows = FULL.feed.filter(f.test);
    var CAP = 80;
    var shown = rows.slice(0, CAP);
    var body = byId('feedBody');
    body.innerHTML = '';
    shown.forEach(function (ev) {
      var tr = el('tr');
      var mod = modulesById[ev.module];
      tr.innerHTML =
        '<td class="t-date">' + esc(ev.t) + '</td>' +
        '<td>' + feedIcon(ev) + ' ' + esc(kindLabel(ev)) + '</td>' +
        '<td>' + esc(mod.name) + '</td>' +
        '<td>' + feedEventText(ev) + '</td>' +
        '<td class="mono t-dim">' + flagLabels(ev) + '</td>';
      body.appendChild(tr);
    });
    if (!rows.length) {
      var empty = el('tr');
      empty.innerHTML = '<td colspan="5" class="t-dim" style="text-align:center">No signals of this kind in the window.</td>';
      body.appendChild(empty);
    }
    if (rows.length > CAP) {
      var tr = el('tr');
      tr.innerHTML = '<td colspan="5" class="t-dim" style="text-align:center">… ' + (rows.length - CAP) + ' more signals in this filter</td>';
      body.appendChild(tr);
    }
  }
  function kindLabel(f) {
    return { pr: 'PR merged', review: 'Review', incident: 'Incident', erosion: 'Rewrite', edit: 'Manual edit' }[f.kind] || f.kind;
  }
  function flagLabels(f) {
    var out = [];
    if (f.kind === 'pr') {
      if (f.agent) out.push('agent:' + f.agent);
      (f.flags || []).forEach(function (fl) {
        if (fl === 'shallow') out.push('rubber-stamp');
        if (fl === 'fast-big') out.push('big+fast');
        if (fl === 'rewrite') out.push('rewrite:' + Math.round((f.fraction || 0) * 100) + '%');
      });
    }
    if (f.kind === 'review') out.push(f.flag);
    if (f.kind === 'erosion') out.push('coverage eroded ×' + f.factor.toFixed(2));
    if (f.kind === 'incident') out.push(f.durationH != null ? 'open ' + f.durationH + 'h' : 'incident');
    if (f.kind === 'edit') out.push('meaningful');
    return out.join(' · ') || '—';
  }

  /* ---------------- about view ---------------- */

  function renderWeights() {
    var LABELS = {
      humanAuthoredBig: 'Merged a substantial PR yourself (non-agent, +400 lines)',
      humanAuthoredSmall: 'Merged a small PR yourself',
      agentAuthored: 'Prompted an agent PR (button-presser credit)',
      meaningfulEdit: 'Meaningful manual edit after merge',
      smallEdit: 'Trivial manual edit',
      substantiveReview: 'Substantive review (content or proportionate read time)',
      middleReview: 'Real look, but light',
      shallowApprove: 'Rubber-stamp approve (big diff, minutes, zero comments)',
      incidentDiagnosis: 'Diagnosed a production incident in the module',
      incidentFix: 'Fixed a production incident in the module'
    };
    var W = S.WEIGHTS;
    var html = '';
    Object.keys(LABELS).forEach(function (k) {
      if (W[k] == null) return;
      html += '<tr><td>' + esc(LABELS[k]) + '</td><td>+' + W[k] + '</td></tr>';
    });
    byId('weightsTable').innerHTML = html;
  }

  /* ---------------- init ---------------- */

  if (LIVE) {
    document.title = 'Grasp — ' + DATA.meta.repo;
    byId('dashMeta').innerHTML = '<span class="badge accent">live</span><span class="repo">' + esc(DATA.meta.repo) + '</span>' +
      '<span>· ' + DATA.persons.length + ' engineers · ' + DATA.modules.length + ' modules</span>';
    byId('demoBanner').innerHTML = '<strong>Your repository, computed on your machine.</strong> ' +
      '<span>Built from merged PRs, reviews and incident issues on GitHub as of ' + esc(DATA.meta.now) +
      '. Every signal is a proxy: agent detection is a lower bound, and review read-time is not visible via GitHub.' +
      (DATA.meta.truncated ? ' History starts ' + esc(String(DATA.meta.oldestMerged).slice(0, 10)) +
        ' (PR limit reached), so earlier months read low — rerun with a higher --max-prs.' : '') + '</span>';
    byId('timeSliderLabel').textContent = '◀ Replay ' + LAST + ' months';
    byId('sparkCaption').textContent = LAST + ' months · month-end totals';
    byId('tourCard').style.display = 'none';
  }
  slider.max = LAST;
  slider.value = LAST;
  renderHeatmap(LAST);
  renderKPIs(FULL);
  renderAlerts(FULL);
  renderReport(FULL);
  renderPersonView();
  renderTour();
  renderFeedFilters();
  renderFeed();
  renderWeights();
})();
