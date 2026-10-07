# Grasp

**Who actually understands your code?** — a concept product for the age of agent-written code, implemented as a landing site + a working MVP dashboard + the step-zero validation script.

> "Grasp" is a working title. The product thesis: when agents write the code, `git blame` only shows who pressed the button. Grasp separates **understanding** from **authorship** and maps the team's *current* understanding across the codebase — flagging modules that nobody understands anymore, before production finds out.

---

## Quick start

```bash
npx @davoudnsr/grasp-cli analyze owner/repo --open
```

That fetches the repo's merged PRs, reviews and incident issues from GitHub, runs the scoring engine on your machine, prints the weekly report, and opens the dashboard on `localhost`. Nothing is sent anywhere except GitHub's own API.

Requires Node 18+. A token is picked up from `GITHUB_TOKEN`, `GH_TOKEN`, or your `gh auth login`; without one GitHub allows only 60 requests/hour, which covers a handful of PRs. Private repos need a token with read access.

| Command | What it does |
|---|---|
| `grasp analyze <owner/repo>` | Map current understanding per module and print the weekly report |
| `grasp demo` | Same engine on the built-in simulated team (no network) |
| `grasp init [owner/repo]` | Write `grasp.config.json` with modules guessed from the repo tree |
| `grasp validate <owner/repo>` | Step-zero check: share of lines merged via big, fast-approved PRs |

Useful `analyze` options: `--open` (dashboard), `--months=6` (heatmap width), `--warmup=6` (extra history fetched first so credit can build up), `--max-prs=500`, `--at=YYYY-MM-DD` (replay), `--json=out.json`. Merged PRs are cached in `./.grasp/`, so reruns only fetch new ones. Run `grasp help` for the full list.

### How GitHub history becomes signals

| Engine signal | Taken from |
|---|---|
| PR merged (agent or human) | Merged PRs, split across the modules holding ≥10% of their changed lines. Agent markers: `Co-Authored-By` trailers in the body or commits, agent branch prefixes (`claude/`, `copilot/`, …), bot accounts. Dependency bots are skipped. |
| Agent rewrite (erosion) | Lines an agent PR deleted in a module ÷ the module's current size |
| Review | Each human reviewer's verdict time and the comments they left |
| Hands-on edit | A human PR changing files an agent PR touched in the last 120 days (≥20 lines = meaningful) |
| Incident | Issues labelled `incident`, attributed to the module of the PR that closed them (`Fixes #123`) |

What GitHub can't show: review read time, on-call schedules, and incidents tracked outside GitHub. Agent detection is a lower bound.

### Configuration

`grasp init owner/repo` writes a starting `grasp.config.json`:

```json
{
  "repo": "owner/repo",
  "months": 6,
  "warmupMonths": 6,
  "maxPrs": 500,
  "modules": [
    { "id": "payments", "name": "Payments", "paths": ["services/payments"], "criticality": "critical" }
  ],
  "ignore": ["generated/", "*.pb.go"],
  "incidentLabels": ["incident", "sev1"],
  "agentMarkers": ["^bot-branch/"],
  "excludePeople": ["release-manager"]
}
```

Without `modules`, Grasp uses the 12 most active directories (two levels deep under `src/`, `packages/`, `services/` and similar). Paths match by longest prefix; anything unmatched goes to *Other*. Lockfiles, build output, vendored code and `.github/` are ignored by default.

## What's in this repo

```
grasp/
├── bin/grasp.mjs                  CLI entry point
├── src/
│   ├── github.mjs                 GitHub REST client
│   ├── collect.mjs                Fetch + cache merged PRs, reviews, incidents, repo tree
│   ├── map.mjs                    ★ GitHub facts → engine event log
│   ├── agents.mjs                 Agent detection heuristics
│   ├── report.cjs                 Terminal weekly report
│   └── serve.mjs                  Local dashboard server
├── index.html                     Landing site (not part of the npm package)
├── demo.html                      Dashboard — demo data, or your repo via `grasp analyze --open`
├── assets/
│   ├── css/style.css              Shared design system
│   ├── css/dashboard.css          Dashboard styles
│   ├── js/signals.js              ★ The engine: passive signals → understanding model → alerts
│   ├── js/demo.js                 Dashboard app (rendering, time replay, tour preview)
│   └── data/demo-data.js          Generated event log (12 months of a fictional team)
├── test/                          `npm test`
└── tools/
    ├── generate-demo-data.cjs     Deterministic demo-data generator (seeded)
    ├── validate-github.mjs        ★ Step-zero validation: measure the signal on a REAL repo
    └── report.cjs                 Weekly report on the demo data
```

## Run the site locally

```bash
python3 -m http.server 8000
# → http://localhost:8000            (landing)
# → http://localhost:8000/demo.html  (demo dashboard)
```

The dashboard computes everything in your browser from the raw event log — nothing pre-scored, nothing sent anywhere.

## The demo in 60 seconds

1. **Manager view** — coverage heatmap (9 modules × 13 months), KPIs, ranked alerts, weekly report. Drag the *replay* slider to watch understanding collapse as agents adopt.
2. **My view** — one engineer's private profile. Try **Tom** (on-call tonight: two stale modules in his zone) and **Maya** (thinks she still knows Payments; the model disagrees — her score faded after two agent rewrites and six months of decay). The guided-tour preview is interactive.
3. **Signal feed** — every event the engine consumed, with derived flags (rubber-stamp, agent-authored, rewrite, big+fast). No black box.
4. **How it works** — the full weight table. The scoring model ships in the open.

The story baked into the data: a healthy six-person team; agents arrive in month 6; three agent rewrites erase what people knew; reviews collapse into rubber stamps; **Payments ends up orphaned** (coverage 0, two incidents in six months) while Auth — where one engineer kept making meaningful edits — stays green.

## The model (the short version)

For every (person, module) pair the engine accumulates weighted credit from passive signals:

| Signal | Weight |
|---|---|
| Meaningful manual edit after merge | +18 |
| Diagnosed a production incident | +22 |
| Fixed a production incident | +14 |
| Merged a substantial PR yourself (non-agent) | +14 |
| Substantive review (content or proportionate read time) | +10 |
| Merged a small PR yourself | +8 |
| Prompted an agent PR ("button-presser") | +2 |
| Rubber-stamp approve | +1 |

Two properties make it honest:

- **Half-life** — all credit decays with a 150-day half-life. Knowledge is a memory, not a badge.
- **Erosion** — when an agent rewrites a fraction *f* of a module, *everyone's* score on it is multiplied by `(1 − 0.8·f)`. The version they knew is gone.

"Current understanding" = score ≥ 55. **Coverage** = how many people hold it, per module. Coverage 0 = **orphaned**. Derived alerts: orphaned × criticality × incident history, bus-factor-1, fading coverage, and "unread code is merging" (rubber-stamped line share).

Rubber-stamp rule: a PR of +300 lines approved in <15 minutes with zero review comments.

## Step zero: validate the thesis on a real repo

Before building anything, measure the one signal the whole thesis rests on:

```bash
export GITHUB_TOKEN=ghp_…        # optional, raises 60 → 5000 req/hour
npx @davoudnsr/grasp-cli validate owner/repo --since=2026-04-01 --min-lines=800 --max-minutes=60 --json=report.json
```

You get: the share of recently merged lines that landed via big, fast-approved PRs; agent-marker share (trailers, branch prefixes, bot accounts); median approve times; a top-offenders table; and one sentence to show an engineering leader:

> "31% of the lines merged into this repo since April landed through PRs of +800 lines approved in under 60 minutes."

…then ask: **"Does this number worry you?"** Their reaction is worth more than any market analysis.

Offline logic check: `npx @davoudnsr/grasp-cli validate --selftest`

Weekly report on the demo data: `node tools/report.cjs` (add `--at=2026-06-30` to replay the past).

## Privacy model (the red line)

- **Individual scores are visible only to the individual.** Not to managers, not in exports, not via the API.
- **Managers see module-level aggregates only**: coverage counts, trends, orphan flags. A manager sees *"Payments is orphaned"* — never *"Maya doesn't understand Payments."*
- In the CLI, *My view* shows only the person whose GitHub token ran the analysis, and `--json` exports contain module aggregates only. A hosted product would enforce this server-side. Same principle, and it's also the go-to-market: teams accept a tool that cannot be used against them.

## Deliberately not counted

Lines of code, commit counts, commit streaks, review volume. Anything farmable without comprehension incentivizes the wrong behavior.

## Honest limitations

Understanding cannot be measured directly — every signal here is a proxy. Grasp is a **risk indicator**, not a mind reader; the copy says so on the box. Approve-time detection in the validation script uses the first human `APPROVED` review and treats agent detection as a lower bound. The demo's team and history are simulated; the engine and its rules are the actual deliverable.

## Roadmap

- **Phase 1 (MVP — this demo):** passive signals, coverage heatmap, weekly report. Zero interaction demanded from engineers.
- **Phase 2:** interactive review tours after heavy agent PRs (prediction questions, never scored), on-call readiness briefings, auto-generated tours for orphaned modules, "explain in your own words" checks, GitLab + incident-tool integrations.
