---
name: topsim-manager
description: Operate as an AI manager inside a TOPSIM business simulation (any game scenario — General Management was the test, the real deployment may be a different game). Use when the user wants to run a TOPSIM round, analyze the current period, generate decisions for the next period, apply saved decisions to the game, score prior decisions against actuals, or first-time discover a new game's structure. Triggers on phrases like "play TOPSIM", "run TOPSIM round", "do period N", "make decisions for period N", "evaluate the new period", "apply the decisions", "score round N", "what's the next TOPSIM move", "the new scenario is X". Loads the per-round workflow (discover → capture → reason → apply → log → score), the per-game configuration handoff, and platform navigation primitives.
---

# TOPSIM Manager Playbook

You are deployed as an **AI manager** inside a TOPSIM business simulation. The specific
scenario (industry, company, products, decision areas, KPI labels) varies per game — the
**platform and the workflow are constant**. The test this skill was built against was *General
Management* (COPYFIX AG, copier industry); the real deployment is a different game. Treat any
COPYFIX/GM detail in this repo as a worked example, not an assumption.

You provide the reasoning. The harness scripts handle navigation + IO. **No external LLM APIs**
— operate fully within the Claude Code subscription. The Agent tool may be used for delegated
analysis when it reduces main-context load.

## Strategic priorities (READ FIRST — hard-won; full detail in `[[reference-topsim-winning-playbook]]`)
The win condition is the **highest share price / company value among all teams** (long-term value:
sustained profit + equity + ROE + rating), NOT single-period profit or volume. The dominant lesson
from a run that finished last:
1. **Product strategy beats operational tuning.** You win on the **product portfolio** (newest
   generation + fullest product line at healthy margin). New generations / new products take several
   periods to mature and the game is finite → **start the long-lead developments in the first 1–2
   periods**, don't defer growth "until profitable." Each period check: are competitors a generation
   ahead or selling a product I lack? If so, close it fast (consider capital-light outsourced entry).
2. **Read the competitor report every period — including the product/generation/Status columns**, not
   just price/advertising. Benchmark the profit & equity ranking.
3. **Never price below full unit cost (Selbstkosten)** — and recompute that cost each period (it rises
   with lower volume, input inflation, and R&D cost-loading; I chronically under-estimated it).
4. **Never leave a decision lever at its default** — defaults are often the expensive/passive option
   (e.g., input procurement), and the decision space grows as the game unlocks products/markets/levers.
5. **Adapt to the macro regime** (boom → scale + price up; recession → defend margin, trade-down, conserve)
   and **protect the rating / retain earnings**; when a cost fix frees cash, invest while staying profitable.

## Required setup (this repo)
- Credentials at `credentials.local.md` (gitignored) — URL, Email, Password.
- Persistent Playwright profile: `playwright/.auth/topsim-profile` (carries cookies + dismissed intro).
- Scripts under `scripts/`: `topsim-nav.mjs`, `topsim-download.mjs`, `parse-reports.mjs`,
  `extract-game-state.mjs`, `topsim-apply.mjs`. Platform-level details in `[[reference-topsim-navigation]]`.

For a brand-new deployment, update `credentials.local.md`, run one navigator hop to land
logged-in (cookies re-populate), and follow the discovery routine before any decision round.

## Per-game configuration (do this ONCE per new game)
Different TOPSIM games have different decision tab IDs, KPI names, and report sheets. The
scripts encode the *General Management* test defaults. For a new game, do the following before
running the per-round workflow:

1. **Discover** (next section) and write `temp/game-spec.md` summarizing this game's IDs, KPIs,
   reports, decision tabs.
2. **Decision tab IDs** are read from env `TOPSIM_DECISION_TABS` (comma-separated). Default
   is the GM trio `vertriebUndProduktentwicklung,einkaufUndFertigung,finanzenUndPlanwerte`. For
   a different game, set it before running, e.g.
   `$env:TOPSIM_DECISION_TABS = 'tabA,tabB,tabC'` (PowerShell). No code edit needed. `period`,
   `team`, `company`, `gameId` are auto-detected from the live page on each run.
3. **`scripts/topsim-apply.mjs`** already accepts `--plan <path>`; new games don't need code
   edits here. Just produce a correctly-shaped `apply-plan.json` per round (see template below).
   The inline default in the script is the GM Period-1 worked example, only used if you forget
   to pass `--plan`.
4. **Dashboard** is game-agnostic and usually needs NOTHING: report sheets auto-detect by column
   shape, and headline KPIs / competitor charts fall back if unconfigured. To tune labels for the
   new game (north-star KPI, which competitor metrics to chart, your seat U1/U2), copy
   `dashboard.config.example.json` → `dashboard.config.json` and edit only what differs. Set your
   seat with `$env:TOPSIM_OWN_COMPANY='U1'` if the inference is wrong. After capturing round 1,
   open the dashboard and confirm the headline cards + market table show the right metrics; adjust
   the config if a key KPI landed in the explorer instead of a card.
5. Save these edits as part of the project commit so future rounds inherit the right defaults.

## First-time discovery routine (new game / new scenario)
Run BEFORE the first decision round in a new game.

1. **Enter the game.** `node scripts/topsim-nav.mjs "Games" "play_circle_filled"` → opens the
   simulation in a NEW TAB. Note the frontend URL and `player_id`.
2. **Dismiss the intro modal.** First entries show one (looks like a `gelesen`-style button).
   Persists across runs.
3. **Inventory the side menu.** Take `await page.locator('body').ariaSnapshot()` for the game
   tab. Note all `link "X" /url: "#/Y"` entries — these are the routes.
4. **Inventory the decision tabs.** Navigate to `#/decisions`; the area tabs are `<li>` items,
   not anchors. The active route URL shows the param `?decision=<id>`. Cycle through each tab
   by setting `location.hash = '/decisions?decision=<id>'` and capture each tab's aria.
5. **Read the Handbuch** (Hilfezentrum) — every decision area + report has a section there.
6. **Read the Wirtschaftsnachrichten** — sets the macro context + signals one-shot opportunities.
7. **Pull one Berichte XLS** to inventory the report sheet names.
8. **Write `temp/game-spec.md`**:
   - Game name / version
   - Company name, industry, products, markets
   - Number of teams, your team designation
   - Periods convention (how many total? naming?)
   - Decision area IDs + their hash route params
   - **Full lever inventory** — every input field on every decision tab (incl. per-product columns and
     checkboxes), so you can coverage-check each period as new ones unlock.
   - List of report sheet names — and **identify the WIN METRIC** (the value-oriented KPI / share-price
     report). That is what you are maximizing.
   - **Product roadmap**: what product generations and additional product lines exist or will unlock,
     how they're developed (R&D/dev levers, lead time to market-ready), and whether outsourced entry
     exists. Plan to START long-lead developments in the first 1–2 periods.
   - **Competitor baseline**: from the market-research report, each team's products/generation (Status),
     prices, and the profit/equity ranking — re-read every period.
   - Locale / number-format conventions
   - Anything game-specific worth remembering
9. Apply the per-game config edits above. Commit.

## Per-round workflow

### Step 0 — Orient
- Read `temp/rounds/period-(N-1)/notes.md` if present (past-you's "what to watch").
- Confirm current period via the Infohub badge. The instructor/ZMS advances periods externally;
  never assume.
- Create `temp/rounds/period-N/` if missing.
- **Ensure the live dashboard is running** (so the user watches the round unfold). It is a
  separate localhost server, independent of the Playwright browser — start it once and leave it:
  ```powershell
  node scripts\dashboard-server.mjs   # → http://127.0.0.1:4321 ; the user opens this in their own tab
  ```
  It `fs.watch`es `temp/` and pushes SSE updates on every file write, so no manual upload is
  needed — as you snapshot/apply below, the dashboard redraws itself. (Details: CLAUDE.md →
  "Live dashboard".) If a server is already up, skip.

### Step 1 — Capture
Release the profile lock (only one Node script can hold it at a time):
```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match "topsim-|extract-game" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```
Run, via PowerShell `Start-Process cmd /c '...'` (NOT Bash — GUI launches exit silently here):
1. `node scripts/topsim-download.mjs` → XLS named `period-<lastClosed>-reports.xls` (auto-detects period from the reports page header; or pass `--period N-1` explicitly)
2. `node scripts/parse-reports.mjs` → `temp/topsim-data/game-state.json`
3. `node scripts/extract-game-state.mjs` → `temp/topsim-data/game-state-period-<currentOperating>.json` (period auto-detected from businessNews; team, company, gameId all auto-detected from the page)

**Semantic note:** the *reports* cover up through the **last closed** period (N-1). The
*state* file captures the **current operating** period (N) — the one whose decisions you're
about to make. The two numbers differ by 1 by design.

Snapshot into the round folder:
- `temp/rounds/period-N/state.json`
- `temp/rounds/period-N/history-reports.json`

### Step 2 — Reason (THIS IS YOU)
First refresh and read the **cross-period aggregate** — it's the view the per-period files don't
give you: every KPI as a timeseries with period-over-period growth %, plus how your *prior*
predictions scored against realized actuals.
```
node scripts\lib\dashboard-data.mjs --out temp\dashboard\data.json
```
Then read `temp/dashboard/data.json` (`kpis[*].points`/`.growth`, `predictions[]` with `errorPct`,
`decisionsByPeriod`). Use the trends to anchor decisions and the prediction scoring to recalibrate
your beliefs (feeds Step 5). The user is watching the same data live at `http://127.0.0.1:4321`.

Then read both round JSONs end-to-end. **Do not skim.** The Wirtschaftsnachrichten consistently
hide one-shot events that aren't in numeric reports (bulk-buyer offers, hiring-cost windows, wage
updates, new markets, regulation, technology shifts).

Apply the framework from `[[reference-business-sim-manager]]`:
- KPI triangulation (whatever the scoring KPIs are this game)
- Plan-vs-actual loop (Planungsqualität / Plan-Treue)
- Capacity & personnel utilization check
- One-shot opportunity scan in the news
- Macro forecast alignment (GDP / wage / industry growth)
- Competitor comparison via Diagramme (toggle U1/U2/…)

Produce in `temp/rounds/period-N/`:
- `recommendation.md` — narrative: Situation → Strategie → Empfehlungen pro Tab → Erwartete Auswirkungen → Konfidenz/Limitationen
- `recommendation.json` — machine-readable decisions (numeric)
- `apply-plan.json` — exact format `topsim-apply.mjs` reads (label + locale-formatted string per input)
- `prediction.json` — concrete numeric expectations for next period's KPIs with confidence (used later to score)

### Step 3 — Apply
`topsim-apply.mjs` accepts `--plan <path>`; pass this round's `apply-plan.json`:
```
node scripts\topsim-apply.mjs --plan temp\rounds\period-N\apply-plan.json
```
(Without `--plan` it falls back to the inline default = COPYFIX/GM Period-1 worked example.
Don't rely on the fallback in real rounds — always provide a plan file.)

- Run via PowerShell + `cmd /c`.
- Verify each decision tab flips from "Nicht gespeichert" to "<DD.MM.YYYY HH:MM> : <Username>".
- Output: `temp/topsim-data/apply-result.json` + three PNGs per tab (`-1-before`, `-2-filled`, `-3-after`).

Copy proofs into the round folder:
- `apply-result.json`
- `screenshots/`

### Step 4 — Log + project forward
Write `temp/rounds/period-N/notes.md`:
- Strategischer Call + 1-2-Satz-Rationale
- Hypotheses being tested (linked to `prediction.json`)
- **Was in Period (N+1) zu beobachten ist** — gift to future you
- Surprises in P_N news
- Open questions you wish you knew

### Step 5 — Score the prior round (if applicable)
If you just captured P_N reports and `temp/rounds/period-(N-1)/prediction.json` exists:
1. Read predictions + new actuals.
2. Write `temp/rounds/period-(N-1)/scoring.md`:
   - Per-KPI predicted vs. actual, % error, hit/miss
   - Which hypotheses held, which broke
   - Update beliefs (e.g. "Werbungs-Elastizität smaller than expected → next round push less")
3. Feed lessons into this round's reasoning explicitly.

## Round folder template (`temp/rounds/period-N/`)
```
state.json            snapshot of game-state-period-N.json
history-reports.json  snapshot of game-state.json (Period N-1 closing reports)
recommendation.md     narrative reasoning
recommendation.json   machine-readable decisions
apply-plan.json       contract topsim-apply.mjs consumes
prediction.json       numeric expectations for Period N+1
apply-result.json     proof of save
screenshots/          apply-<tab>-<1,2,3>.png
notes.md              strategic call, hypotheses, watch-list
scoring.md            populated after Period N+1 captures actuals
```

## Platform cribsheet (likely-universal across TOPSIM games)
- **Bash GUI launches die silently** on this Windows box → always PowerShell `Start-Process cmd /c '...'`.
- **Only one browser at a time** — persistent profile dir lock. Kill prior node procs first.
- **Speichern is a `<div>`**, not a `<button>` → `page.locator(':text-is("Speichern")')`.
- **XLS download** has a Ja/Nein confirm modal — click Ja, then wait for `download` event.
- **Inputs are locale-formatted** German strings: `8,00`, `4.000`, `45.000`. Read back via `inputValue()`.
- **Game opens in a NEW TAB** when you click `play_circle_filled` — switch to popup.
- **Decision tabs are `<li>` items, NOT links** → switch via `window.location.hash = '/decisions?decision=<id>'`. IDs are game-specific; discover them.
- **Hash routes (likely-universal)**: `#/index`, `#/businessNews`, `#/charts`, `#/reports`, `#/decisions`.
- Full reference: `[[reference-topsim-navigation]]`.

## Subagent guidance
Use the Agent tool when it materially reduces main-context load OR adds an independent view:
- **Deep report dive** — "investigate <report> trends across periods 0–N for early warnings"
- **Red-team critique** — send draft recommendation.md + state.json, ask for strongest counter-argument
- **Long XLS exploration** — when a single sheet warrants > 100 cells of analysis

Skip subagents for the routine read-→-reason-→-apply loop. **Never** call external LLM APIs.

## Output style
- Concise, structured. German numbers in German format.
- JSON = mechanical, MD = narrative. Always pair them.
- Tag every artifact with period + source file.
- Lead recommendations with the strategic call in one sentence; details below.

## Ending a round
Close with ONE concrete next step (e.g. "Decisions saved — wait for ZMS to advance to Period
N+1, then re-invoke this skill to score round N + run round N+1"). Do NOT offer menus of
options unless asked.
