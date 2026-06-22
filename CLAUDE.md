# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A DHBW seminar project: **"KI als Manager"** (AI as Manager). The goal is to evaluate how
well AI performs as a *manager* inside business management simulations ("Planspiele"), run in
cooperation with the **ZMS** (Zentrum für Managementsimulation). Experiments compare AI vs. AI
and AI vs. human players on decision quality, consistency, and short/long-term success.

The simulation platform is **TOPSIM** (`https://app.topsim.com`). The folder name
`KIMehragenten` ("AI multi-agents") reflects the intended approach: drive multiple AI agents
through the simulation. The full assignment text is in `KIMehragenten/StartingTask.md` (German).

There is no application source code to build here yet — this repo is the **automation harness**
used to log into TOPSIM, navigate it, and (later) drive agents through the simulation. It is a
Playwright project, not the simulation itself.

## Commands

Run from the project root (`c:\Users\Administrator\Desktop\DHBW Seminar`).

- `npx playwright test` — run all tests across chromium, firefox, webkit
- `npx playwright test --project=chromium` — single browser engine
- `npx playwright test tests/example.spec.ts` — run one spec file
- `npx playwright test -g "has title"` — run tests matching a title
- `npx playwright test --ui` — interactive UI runner
- `npx playwright test --debug` — step-through debugger
- `npx playwright codegen <url>` — open a browser and record clicks into TypeScript
- `npx playwright open <url>` — open a plain headed browser to drive manually
- `npx playwright show-report` — open the HTML report from the last run

## Launching a headed browser on this machine (IMPORTANT)

This is Windows Server in a desktop session. Launching a headed/GUI browser **from the Bash
tool fails silently** — the process exits with code 0 but no window attaches to the interactive
desktop. **Launch GUI browsers via PowerShell instead**, which runs in the logged-in session:

```powershell
Start-Process -FilePath "cmd.exe" `
  -ArgumentList '/c','npx playwright open https://app.topsim.com/en/info' `
  -WorkingDirectory "c:\Users\Administrator\Desktop\DHBW Seminar"
```

Verify the window actually opened by checking for the Playwright-bundled Chromium (its path is
under `...\ms-playwright\chromium-*\`), not the user's regular Chrome:

```powershell
Get-Process chrome | Where-Object { $_.Path -match "ms-playwright" } |
  Select-Object Id, MainWindowTitle, Path
```

Headless runs (`npx playwright test`) work fine from any shell.

## Live dashboard (thesis visualization)

A local, always-on dashboard visualizes the data the harness collects (KPIs, growth %, decisions,
prediction-vs-actual scoring) and **updates live** as a round is captured/applied. It is the
thesis's visual record of how the AI's information and decisions evolve period by period.

**Architecture — two browsers, never colliding:**
- The **dashboard** is a plain localhost web page you open in **your own browser tab**.
- **Playwright** drives TOPSIM in its **own** bundled Chromium + persistent profile.
- The dashboard server only *reads* the JSON/MD files under `temp/` — it never touches the
  automated browser. They are fully independent.

**Pieces:**
- `scripts/lib/dashboard-data.mjs` — aggregator. Scans `temp/rounds/period-*/` (state, decisions,
  predictions) + parsed reports and emits one cross-period structure: KPI timeseries (Executive
  Summary, periods-as-columns), the **competitor market view** (Marktforschungsbericht, companies
  U1/U2/… as columns — Preis, Werbung, Technologie, Vertriebsmitarbeiter, Bekanntheit,
  Kundenzufriedenheit, Absatz, Umsatz Markt, Marktanteil per rival), P/P growth %, the
  Plan-vs-Ist-Absatz cross-check, decisions per period, and scored predictions. Importable + CLI
  (`--out <path>`). Your seat is inferred from team meta; override with `$env:TOPSIM_OWN_COMPANY='U1'`.
- `scripts/dashboard-server.mjs` — zero-dependency Node HTTP server (built-ins only). Serves the
  page, `GET /api/data` (fresh aggregate), and `GET /api/stream` (SSE). It `fs.watch`es `temp/`
  and **pushes an update over SSE on every file change** — so the page redraws mid-run with no
  manual upload step. Chart.js is served locally from `node_modules` (offline-safe).
- `scripts/dashboard/index.html` — the page: headline KPI cards w/ growth badges, a line chart per
  headline KPI, a KPI explorer, a **Markt & Wettbewerb** section (own-vs-rival charts + full
  market table), the Plan-Treue (Gepl./Tats. Absatz) table, the Prognose-vs-Ist scoring table, and
  a decisions table.

**Data completeness:** the XLS download (`parse-reports.mjs`) captures **all 19 report sheets**
verbatim into `game-state.json` — nothing is lost at capture. The aggregator surfaces the
decision-relevant ones (Executive Summary + Marktforschungsbericht + derived); the deeper sheets
(GuV, Bilanz, Kostenrechnungen, …) remain in `game-state.json` for ad-hoc analysis. When reasoning,
if a needed figure isn't in `data.json`, grep the full `game-state.json` rather than assuming it
wasn't collected.

**Run it (start ONCE, before a round; leave running):**
```powershell
# from project root — runs headless, no GUI, any shell is fine:
node scripts\dashboard-server.mjs           # → http://127.0.0.1:4321  (set $env:DASH_PORT to change)
```
Then open `http://127.0.0.1:4321` in your browser. As the capture/apply scripts write files, the
page live-updates. `npm run dashboard` is the shortcut; `npm run dashboard:data` dumps the current
aggregate to `temp/dashboard/data.json`.

**Multiple runs (one game = one run; NEVER delete data):** the thesis compares several full runs,
so every run is preserved and the dashboard switches between them with a **run selector** in the
header. The mechanism (`scripts/dashboard-runs.mjs` + a registry at `temp/runs/runs.json`):
- The **active** run is always written live to `temp/rounds` + `temp/topsim-data` — the capture/apply
  scripts are unchanged and never know about runs.
- **Finished** runs are *frozen* (moved, not copied/deleted) into `temp/runs/run-N/{rounds,topsim-data}`.
- To reset the dashboard for a NEW game: `node scripts/dashboard-runs.mjs archive [--label "..."] [--new-label "..."]`.
  This freezes the current run and recreates empty live dirs so the next game starts fresh from
  Period 0. List runs with `... list`; rename with `... relabel <id> "<label>"`.
- The server exposes `GET /api/runs` and accepts `?run=<id>` on `/api/data` and `/api/stream`; the
  aggregator's `buildDashboardData(root, {run})` resolves the right dirs. No manifest → one implicit
  active run (full back-compat). Run 1 (COPYFIX practice, U6) is archived at `temp/runs/run-1`; Run 2
  is live.

**The AI manager uses this data too:** before reasoning, read the aggregate (`temp/dashboard/data.json`
or `GET /api/data`) — it is the clean cross-period view (trends + growth + prior-prediction accuracy)
that per-period files don't give you on their own. See the `topsim-manager` skill, Step 2.

**Adapting to a different game/company (IMPORTANT):** the dashboard is game-agnostic. Everything
specific to the GM-test company lives in defaults inside `scripts/lib/dashboard-data.mjs` and is
overridable via an optional `dashboard.config.json` at the project root (see
`dashboard.config.example.json` for all keys + docs). You usually need to change little:
- **Report sheets** are resolved by name hint *and*, if the hint misses, **structurally** — the
  per-period KPI sheet is found by its `Periode N` column headers, the competitor sheet by its
  company columns. So a renamed/renumbered sheet in another game still works with zero config.
- **Headline KPI cards** and **competitor charts** come from config substring lists; if none match
  (new game, new KPI names) they **fall back** to the first 8 KPIs / first 6 market metrics, so the
  dashboard always renders. Tune `headlineKpis` / `marketChartMetrics` to the new game's KPIs.
- **Company labels** (default `U1`,`U2`,…) and the avg column are regex-configurable; your own seat
  via `$env:TOPSIM_OWN_COMPANY` or inferred from team meta.
- **Plan-vs-Ist** KPI labels (`plannedKpi`/`actualKpi`) are config; the panel skips silently if a
  game has no such metric. The deeper report sheets stay in `game-state.json` regardless.

## Running a TOPSIM round (deployment mode)

Invoke the **`topsim-manager`** skill (`.claude/skills/topsim-manager/SKILL.md`). It encodes the
per-round workflow: orient → capture (download + parse + extract) → reason → apply → log →
score. Each round produces a fresh folder under `temp/rounds/period-N/` containing the state
snapshot, the recommendation (`.md` + `.json`), the apply plan, screenshots, the prediction
file (scored next period), and notes. The skill is platform-bound to TOPSIM but
game-scenario-agnostic — for a new game (different from the GM test), follow its
"first-time discovery routine" before round 1 and update the decision-tab IDs in
`scripts/extract-game-state.mjs` + `scripts/topsim-apply.mjs`.

Decision-making framework is in long-term memory: `reference-business-sim-manager`. Platform
mechanics: `reference-topsim-navigation`. Credentials: `reference-topsim-credentials`.

## Driving the TOPSIM simulation

Use `scripts/topsim-nav.mjs` — a reusable navigator that lands logged-in (session persists in
`playwright/.auth/topsim-profile`) and clicks a sequence of targets, writing screenshot + `.json`
+ `.aria.txt` per step to `temp/topsim-explore/`. A target starting with `#/` clicks that SPA
route anchor; otherwise it's a name/text match. It has a DANGER blocklist (never auto-clicks
submit/confirm/logout/delete/buy). Set `NO_KEEP=1` to auto-close (chain runs); otherwise it stays
open ~45 min. Run it via the `cmd /c` PowerShell pattern (see launch note above), e.g.
`node scripts\topsim-nav.mjs "Games" "play_circle_filled" "#/reports"`.

TOPSIM is two layers: the **Cloud portal** (`app.topsim.com`, login → Games → play button
`play_circle_filled`) and the **game SPA** (`frontend.topsim.com/frontend/#/...`, opens in a NEW
TAB). SPA routes: `#/index` (Infohub/KPIs), `#/businessNews`, `#/charts`, `#/reports`,
`#/decisions`. The in-game sidebar collapses to icons, so navigate by `a[href="#/..."]`. Full
navigation know-how is in long-term memory (`reference-topsim-navigation`).

## Credentials

TOPSIM login (URL, email, password) lives in `credentials.local.md` at the project root. That
file and `*.local.md` / `.env*` are gitignored — **never** put credentials in committed files
(including this one) or in test source. For tests, prefer reading from `.env` (the dotenv import
is pre-stubbed in `playwright.config.ts`) or saved auth state under `playwright/.auth/`.

## Conventions for this repo

- Tests live in `tests/`. The default `tests/example.spec.ts` is the Playwright demo — replace
  or delete it once real TOPSIM flows exist.
- `tests-examples/` holds Playwright's generated demo (TodoMVC); not part of this project.
- When a login flow is built, save the authenticated session to `playwright/.auth/` and reuse it
  via a setup project rather than logging in per-test (TOPSIM is a real external account).
- The assignment and platform are German; UI text, labels, and report deliverables are in German.
