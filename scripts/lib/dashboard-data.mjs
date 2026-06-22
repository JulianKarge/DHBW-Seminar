// Aggregator: turns the per-period TOPSIM artifacts (round folders + parsed
// reports) into ONE normalized, cross-period structure that both the live
// dashboard and the AI manager consume to reason over trends.
//
// Sources (all best-effort — missing files are skipped, never fatal):
//   temp/topsim-data/game-state.json            parsed XLSX reports (period columns)
//   temp/rounds/period-*/history-reports.json   per-round snapshot of the above
//   temp/rounds/period-*/state.json             live infohub + decisions per period
//   temp/rounds/period-*/recommendation.json    AI decisions taken that period
//   temp/rounds/period-*/prediction.json        AI numeric forecast (for scoring)
//
// Output shape: see buildDashboardData() return. Stable contract — the HTML
// dashboard and `--out` JSON both depend on it.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const readJSON = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

// ---- Multi-run registry ----------------------------------------------------
// Each simulation RUN (a full game, period 0..N) is preserved separately so the
// thesis keeps EVERY run's data for the scientific comparison. The ACTIVE run is
// written live to temp/rounds + temp/topsim-data (capture/apply scripts are
// unchanged — they always target the live location). Finished runs are frozen
// under temp/runs/run-N/{rounds,topsim-data} by scripts/dashboard-runs.mjs.
// temp/runs/runs.json is the registry. No registry → one implicit active run
// (full back-compat with single-run checkouts).
const runsDirOf = (root) => join(root, 'temp', 'runs');
const manifestOf = (root) => join(runsDirOf(root), 'runs.json');

// The registry (creates a synthetic single-run view when no manifest exists).
export function listRuns(root = process.cwd()) {
  const m = readJSON(manifestOf(root));
  if (m && Array.isArray(m.runs) && m.runs.length) return m;
  return { version: 1, activeId: 1, runs: [{ id: 1, label: 'Run 1', location: 'active', status: 'active' }] };
}

// Resolve the data dirs for a run selector (id, 'active', or null=default active).
// location === 'active'  → the live temp/rounds + temp/topsim-data
// location === 'run-N'   → the frozen temp/runs/run-N/{rounds,topsim-data}
function resolveRunDirs(root, run) {
  const m = listRuns(root);
  const id = run == null || run === 'active' ? m.activeId : Number(run);
  const entry = m.runs.find((r) => r.id === id)
    || m.runs.find((r) => r.location === 'active') || m.runs[0];
  const loc = entry?.location || 'active';
  if (loc === 'active') {
    return { dataDir: join(root, 'temp', 'topsim-data'), roundsDir: join(root, 'temp', 'rounds'), run: entry, registry: m };
  }
  const base = join(runsDirOf(root), loc);
  return { dataDir: join(base, 'topsim-data'), roundsDir: join(base, 'rounds'), run: entry, registry: m };
}

// "Aktienkurs" stays "Aktienkurs"; "Aktienkurs_EUR" -> "Aktienkurs".
const stripUnitSuffix = (k) =>
  k.replace(/_(EUR|MEUR|TEUR|pct|Index|Stueck|Stück|%)$/i, '').replace(/_/g, ' ').trim();

// ---- Per-game config -------------------------------------------------------
// EVERYTHING game-specific lives here. Defaults target the General Management
// test (COPYFIX); a different TOPSIM game (other company, products, KPIs) is
// adapted by dropping a `dashboard.config.json` at the project root — only the
// keys you want to override. Anything not listed auto-detects or falls back, so
// the dashboard still renders for an unconfigured new game.
const DEFAULT_CONFIG = {
  // Sheet resolution: case-insensitive substring HINT. If the hint doesn't
  // match, the sheet is found STRUCTURALLY (by column shape) — so renamed/
  // re-numbered sheets in another game still work.
  executiveSheetHint: 'Executive Summary',   // your company, periods as columns
  marketSheetHint: 'Marktforschungsbericht',  // rivals as columns (U1/U2/…)
  // Column patterns inside the market sheet (regex source strings).
  companyPattern: '^U\\d+$',                   // a competitor column header
  aggregatePattern: 'ø|Durchschnitt|Summe|Mittel|Average', // the avg/sum column
  // Headline KPI cards (substring match vs KPI labels). Empty/no-match → the
  // first 8 KPIs (Executive-Summary order) are used automatically.
  headlineKpis: [
    'Aktienkurs', 'Marktanteil', 'Umsatzrendite', 'Periodenüberschuss',
    'Bekanntheit', 'Kundenzufriedenheit', 'Auslastung Mitarbeiter', 'Fremdkapitalquote',
  ],
  // Which market metrics get an own-vs-rival chart. No-match → first 6 present.
  marketChartMetrics: [
    'Marktanteil', 'Preis', 'Werbung', 'Bekanntheit', 'Kundenzufriedenheit', 'Tatsächlicher Absatz',
  ],
  // Plan-vs-actual cross-check (KPI label substrings). Skipped if not found.
  plannedKpi: 'Geplanter Absatz',
  actualKpi: 'Tatsächlicher Absatz',
};

function loadConfig(root) {
  const cfg = { ...DEFAULT_CONFIG };
  const f = join(root, 'dashboard.config.json');
  if (existsSync(f)) {
    const user = readJSON(f);
    if (user && typeof user === 'object') Object.assign(cfg, user);
  }
  return cfg;
}

// Resolve a sheet by name hint, else by a structural predicate (other games
// may rename or renumber sheets — match on shape, not just the label).
function resolveSheet(sheets, hint, structuralTest) {
  if (!sheets) return null;
  const names = Object.keys(sheets);
  const byHint = hint && names.find((n) => n.toLowerCase().includes(hint.toLowerCase()));
  if (byHint && Array.isArray(sheets[byHint])) return sheets[byHint];
  const byShape = names.find((n) => Array.isArray(sheets[n]) && structuralTest(sheets[n]));
  return byShape ? sheets[byShape] : null;
}
const hasPeriodColumns = (rows) =>
  rows.some((r) => Array.isArray(r) && r.some((c) => typeof c === 'string' && /Periode\s+\d+/i.test(c)));
const hasCompanyColumns = (rows, companyRe) =>
  rows.some((r) => Array.isArray(r) && r.filter((c) => typeof c === 'string' && companyRe.test(c.trim())).length >= 1);

// ---- Reports (XLSX → 2D arrays) -------------------------------------------
// Executive Summary rows look like ["Aktienkurs","EUR",186.44] preceded by
// header rows [" "," ","Periode 0"]. As the game advances, TOPSIM adds more
// period columns (Periode 0, Periode 1, ...). We detect every period column
// and pull each KPI value per period.
function kpisFromReports(reportsJson, cfg) {
  const out = {}; // label -> { unit, byPeriod: {p: value} }
  if (!reportsJson?.sheets) return out;
  const sheet = resolveSheet(reportsJson.sheets, cfg.executiveSheetHint, hasPeriodColumns);
  if (!Array.isArray(sheet)) return out;

  // Find which column index maps to which period from any header row.
  // Default assumption: value column is index 2 = first period seen.
  let periodCols = []; // [{col, period}]
  for (const row of sheet) {
    if (!Array.isArray(row)) continue;
    const found = [];
    row.forEach((cell, i) => {
      const m = typeof cell === 'string' && cell.match(/Periode\s+(\d+)/i);
      if (m) found.push({ col: i, period: Number(m[1]) });
    });
    if (found.length) { periodCols = found; break; }
  }
  if (!periodCols.length) periodCols = [{ col: 2, period: 0 }];

  // A sheet can repeat the SAME label across sections (e.g. once Markt 2 opens,
  // Executive Summary carries two "Tatsächlicher Absatz" rows — Markt 1 then
  // Markt 2). Keying by label alone makes the 2nd row clobber the 1st. Suffix
  // duplicates by occurrence ("X", "X (2)", …) — order is stable across report
  // snapshots, so the same logical row keeps the same key when merged.
  const seen = {};
  for (const row of sheet) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const label = typeof row[0] === 'string' ? row[0].trim() : '';
    if (!label || /Periode\s+\d+/i.test(label)) continue;
    const unit = typeof row[1] === 'string' ? row[1].trim() : '';
    const vals = periodCols
      .map(({ col, period }) => ({ period, v: row[col] }))
      .filter((x) => typeof x.v === 'number');
    if (!vals.length) continue; // section title / blank row — not a metric
    const key = seen[label] ? `${label} (${(seen[label] += 1)})` : (seen[label] = 1, label);
    out[key] = { unit, byPeriod: {} };
    for (const { period, v } of vals) out[key].byPeriod[period] = v;
  }
  return out;
}

// Which single period does a reports file describe? (max "Periode N" header).
function reportPeriodOf(reportsJson, cfg) {
  const sheet = resolveSheet(reportsJson?.sheets, cfg.executiveSheetHint, hasPeriodColumns);
  let max = null;
  if (Array.isArray(sheet)) {
    for (const row of sheet) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const m = typeof cell === 'string' && cell.match(/Periode\s+(\d+)/i);
        if (m) max = Math.max(max ?? -1, Number(m[1]));
      }
    }
  }
  return max;
}

// ---- Marktforschungsbericht (competitor view) -------------------------------
// Unlike Executive Summary (periods as columns, your company only), this sheet
// has COMPANIES as columns: [" "," ","U1","U2","ø-Wert / Summe"]. It holds the
// market-/competitor-level levers an AI manager most needs: Preis, Werbung,
// Technologie, Vertriebsmitarbeiter, Bekanntheit, Kundenzufriedenheit,
// (potentieller/tatsächlicher) Absatz, Umsatz Markt, Marktanteil — per rival.
function marketFromReports(reportsJson, cfg) {
  const metrics = {}; // label -> { unit, byCompany:{U1,U2,...}, avg }
  const companyRe = new RegExp(cfg.companyPattern, 'i');
  const aggRe = new RegExp(cfg.aggregatePattern, 'i');
  const sheet = resolveSheet(reportsJson?.sheets, cfg.marketSheetHint, (rows) => hasCompanyColumns(rows, companyRe));
  if (!Array.isArray(sheet)) return metrics;

  // Header row: find company columns (U1, U2, ...) and the avg/sum column.
  let companyCols = []; // [{col,label}]
  let avgCol = null;
  for (const row of sheet) {
    if (!Array.isArray(row)) continue;
    const comps = [];
    row.forEach((cell, i) => {
      const s = typeof cell === 'string' ? cell.trim() : '';
      if (companyRe.test(s)) comps.push({ col: i, label: s.toUpperCase() });
      else if (aggRe.test(s)) avgCol = i;
    });
    if (comps.length) { companyCols = comps; break; }
  }
  if (!companyCols.length) return metrics;

  // Track section context so repeated metric labels across multiple
  // markets/products (other games) don't collide — only prefixed on collision.
  let section = '';
  for (const row of sheet) {
    if (!Array.isArray(row)) continue;
    const label = typeof row[0] === 'string' ? row[0].trim() : '';
    if (!label || /Back to/i.test(label)) continue;
    const byCompany = {};
    for (const { col, label: cl } of companyCols) {
      if (typeof row[col] === 'number') byCompany[cl] = row[col];
    }
    if (!Object.keys(byCompany).length) {
      // a text-only row with no company numbers = a section/market header
      if (!/^U\d+$/i.test(label) && !aggRe.test(label)) section = label;
      continue;
    }
    const unit = typeof row[1] === 'string' ? row[1].trim() : '';
    const key = metrics[label] && section ? `${section} · ${label}` : label;
    metrics[key] = { unit, byCompany, avg: typeof row[avgCol] === 'number' ? row[avgCol] : null, section: section || null };
  }
  return metrics;
}

// Which company column is YOURS. Env override wins (set TOPSIM_OWN_COMPANY=U1
// for the real game if you're seat 1); otherwise inferred from team/company
// meta ("Team 2" -> "U2"). The dashboard shows ALL companies regardless, so a
// wrong guess only mis-highlights — never hides data.
function ownCompanyKey(meta) {
  const env = (process.env.TOPSIM_OWN_COMPANY || '').trim().toUpperCase();
  if (/^U\d+$/.test(env)) return env;
  const s = `${meta.team || ''} ${meta.company || ''}`;
  const m = s.match(/(\d+)/);
  return m ? `U${m[1]}` : null;
}

// ---- Live infohub (state.json sections.infohub) ----------------------------
function kpisFromInfohub(stateJson) {
  const out = {};
  const hub = stateJson?.sections?.infohub;
  if (!hub) return out;
  for (const [label, v] of Object.entries(hub)) {
    if (v && typeof v.number === 'number') out[label] = { unit: v.unit || '', value: v.number };
  }
  return out;
}

// ---- Decisions (recommendation.json) ---------------------------------------
function decisionsFromRecommendation(recJson) {
  const rows = [];
  const dec = recJson?.decisions;
  if (!dec) return rows;
  for (const [tab, fields] of Object.entries(dec)) {
    for (const [field, value] of Object.entries(fields)) {
      rows.push({ tab, field, value });
    }
  }
  return rows;
}

function listRoundPeriods(roundsDir) {
  if (!existsSync(roundsDir)) return [];
  return readdirSync(roundsDir)
    .map((n) => n.match(/^period-(\d+)$/))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

/**
 * Build the cross-period dashboard structure.
 * @param {string} root project root (defaults to cwd)
 */
export function buildDashboardData(root = process.cwd(), opts = {}) {
  const { dataDir, roundsDir, run, registry } = resolveRunDirs(root, opts.run);
  const cfg = loadConfig(root);

  // KPI timeseries: label -> { unit, series: {period:value} }
  const kpis = {};
  const meta = {
    game: null, gameId: null, team: null, company: null, currentPeriod: null,
    runId: run?.id ?? null, runLabel: run?.label ?? null, runStatus: run?.status ?? null,
  };
  const addKpi = (label, unit, period, value, fillOnly = false) => {
    if (value == null || Number.isNaN(value)) return;
    kpis[label] ??= { unit: unit || '', series: {} };
    if (unit && !kpis[label].unit) kpis[label].unit = unit;
    if (fillOnly && kpis[label].series[period] != null) return; // don't clobber report actuals
    kpis[label].series[period] = value;
  };

  // 1) Reports: merge KPIs (Executive Summary) AND the competitor market view
  //    (Marktforschungsbericht) from EVERY available report snapshot. Each
  //    snapshot describes one period; merging them yields the full timeseries.
  const reportCandidates = [join(dataDir, 'game-state.json')];
  for (const p of listRoundPeriods(roundsDir)) {
    reportCandidates.push(join(roundsDir, `period-${p}`, 'history-reports.json'));
  }
  const marketByPeriod = {}; // period -> { label -> {unit, byCompany, avg} }
  for (const path of reportCandidates) {
    if (!existsSync(path)) continue;
    const j = readJSON(path);
    if (!j) continue;
    // KPIs (Executive Summary period columns)
    for (const [label, { unit, byPeriod }] of Object.entries(kpisFromReports(j, cfg))) {
      for (const [p, v] of Object.entries(byPeriod)) addKpi(label, unit, Number(p), v);
    }
    // Market / competitor view (companies as columns, one period per file)
    const rp = reportPeriodOf(j, cfg);
    const market = marketFromReports(j, cfg);
    if (rp != null && Object.keys(market).length) marketByPeriod[rp] = market;
  }
  // Highest CLOSED period (reports = actuals). The operating period is one past
  // this and has no results yet, so the live Infohub must NOT add a point there.
  const maxReportPeriod = Math.max(-1, ...Object.values(kpis).flatMap((k) => Object.keys(k.series).map(Number)));

  // 2) Live infohub per round (current operating period snapshot).
  const decisionsByPeriod = {};
  const predictions = [];
  const rounds = [];
  for (const p of listRoundPeriods(roundsDir)) {
    const dir = join(roundsDir, `period-${p}`);
    const state = readJSON(join(dir, 'state.json'));
    if (state?.meta) {
      meta.gameId ||= state.meta.gameId;
      meta.team ||= state.meta.team;
      meta.company ||= state.meta.company;
      meta.currentPeriod = Math.max(meta.currentPeriod ?? -1, state.meta.period ?? p);
    }
    // NOTE: the live Infohub is NOT fed into the KPI timeseries. Observed: it
    // displays the period-0 baseline even after later periods close (a stale
    // pre-results snapshot of the operating period), which would overwrite the
    // authoritative report actuals. Reports (closed-period actuals) are the
    // single source of truth for the KPI timeseries. Infohub stays in state.json
    // for reference only. Fill-only fallback for KPIs reports never carry:
    if (p <= maxReportPeriod) {
      const hub = kpisFromInfohub(state);
      for (const [label, { unit, value }] of Object.entries(hub)) addKpi(label, unit, p, value, true);
    }

    const rec = readJSON(join(dir, 'recommendation.json'));
    if (rec) {
      meta.game ||= rec.meta?.game;
      decisionsByPeriod[p] = decisionsFromRecommendation(rec);
    }

    const pred = readJSON(join(dir, 'prediction.json'));
    if (pred?.predictions) {
      for (const [rawKpi, body] of Object.entries(pred.predictions)) {
        predictions.push({
          period: p,
          kpi: stripUnitSuffix(rawKpi),
          rawKpi,
          predicted: body.p1End_approx ?? body.predicted ?? null,
          current: body.current ?? null,
          confidence: body.confidence ?? null,
          rationale: body.rationale || '',
        });
      }
    }

    rounds.push({
      period: p,
      hasState: !!state, hasRecommendation: !!rec, hasPrediction: !!pred,
      hasApply: existsSync(join(dir, 'apply-result.json')),
      forecast: state?.sections?.businessNews?.forecast || null,
    });
  }

  // 3) Finalize KPI series → sorted arrays + period-over-period growth %.
  const kpiOut = {};
  const allPeriods = new Set();
  for (const [label, { unit, series }] of Object.entries(kpis)) {
    const points = Object.entries(series)
      .map(([p, v]) => ({ period: Number(p), value: v }))
      .sort((a, b) => a.period - b.period);
    points.forEach((pt) => allPeriods.add(pt.period));
    const growth = points.map((pt, i) => {
      if (i === 0) return { period: pt.period, pct: null };
      const prev = points[i - 1].value;
      return { period: pt.period, pct: prev ? ((pt.value - prev) / Math.abs(prev)) * 100 : null };
    });
    kpiOut[label] = {
      unit,
      points,
      growth,
      latest: points.at(-1) ?? null,
      latestGrowthPct: growth.at(-1)?.pct ?? null,
      headline: false, // set below from config (with fallback)
    };
  }

  // Headline selection: config substrings → present KPIs (order preserved).
  // No match → first 8 KPIs in Executive-Summary insertion order. Always
  // yields cards even for an unconfigured new game.
  const kpiNames = Object.keys(kpiOut);
  const pickBySubstrings = (subs, pool) => {
    const picked = [];
    for (const sub of subs) {
      const hit = pool.find((n) => n.toLowerCase().includes(String(sub).toLowerCase()) && !picked.includes(n));
      if (hit) picked.push(hit);
    }
    return picked;
  };
  let headlineKpis = pickBySubstrings(cfg.headlineKpis || [], kpiNames);
  if (!headlineKpis.length) headlineKpis = kpiNames.slice(0, 8);
  headlineKpis.forEach((n) => { kpiOut[n].headline = true; });

  // 4) Market / competitor module → per-metric timeseries with own vs rivals.
  //    (Built BEFORE scoring so per-company KPIs like Bekanntheit are scored
  //    against the authoritative own-company report value, not a stale Infohub fill.)
  meta.ownCompany = ownCompanyKey(meta);
  const marketMetrics = {}; // label -> { unit, companies:Set, series:{period:{byCompany,avg}} }
  const marketPeriods = new Set();
  for (const [p, metrics] of Object.entries(marketByPeriod)) {
    const period = Number(p);
    marketPeriods.add(period);
    for (const [label, { unit, byCompany, avg }] of Object.entries(metrics)) {
      marketMetrics[label] ??= { unit, companies: new Set(), series: {} };
      if (unit && !marketMetrics[label].unit) marketMetrics[label].unit = unit;
      Object.keys(byCompany).forEach((c) => marketMetrics[label].companies.add(c));
      marketMetrics[label].series[period] = { byCompany, avg };
    }
  }
  const marketOut = {};
  for (const [label, { unit, companies, series }] of Object.entries(marketMetrics)) {
    const periods = Object.keys(series).map(Number).sort((a, b) => a - b);
    const comps = [...companies].sort();
    // own vs (best) competitor at the latest period — for quick cards
    const last = periods.at(-1);
    const lastVals = last != null ? series[last].byCompany : {};
    marketOut[label] = {
      unit,
      companies: comps,
      points: periods.map((per) => ({ period: per, byCompany: series[per].byCompany, avg: series[per].avg })),
      own: meta.ownCompany && lastVals[meta.ownCompany] != null ? lastVals[meta.ownCompany] : null,
      latestByCompany: lastVals,
    };
  }

  // 5) Score predictions against realized actuals. Prefer the authoritative
  //    market value for OUR company (Marktforschungsbericht) when the predicted
  //    KPI is a per-company one; else fall back to the KPI timeseries (reports).
  const marketActual = (kpiName, period) => {
    const name = Object.keys(marketOut).find((n) => n.toLowerCase() === kpiName.toLowerCase()
      || n.toLowerCase().includes(kpiName.toLowerCase()));
    if (!name || !meta.ownCompany) return null;
    const pt = marketOut[name].points.find((x) => x.period === period);
    const v = pt?.byCompany?.[meta.ownCompany];
    return typeof v === 'number' ? v : null;
  };
  for (const pr of predictions) {
    const mk = marketActual(pr.kpi, pr.period);
    const kpiPt = kpiOut[pr.kpi]?.points.find((pt) => pt.period === pr.period);
    pr.actual = mk != null ? mk : (kpiPt ? kpiPt.value : null);
    pr.actualSource = mk != null ? 'market' : (kpiPt ? 'report' : null);
    pr.errorPct = (pr.actual != null && pr.predicted)
      ? ((pr.actual - pr.predicted) / Math.abs(pr.predicted)) * 100
      : null;
  }

  // 6) Derived cross-checks the AI should always see.
  const derived = {};
  const findKpiPoints = (sub) => {
    const name = Object.keys(kpiOut).find((n) => n.toLowerCase().includes(String(sub).toLowerCase()));
    if (name) return kpiOut[name].points;
    const mName = Object.keys(marketOut).find((n) => n.toLowerCase().includes(String(sub).toLowerCase()));
    return mName ? marketOut[mName].points.map((pt) => ({ period: pt.period, value: pt.byCompany[meta.ownCompany] })) : [];
  };
  const geplant = findKpiPoints(cfg.plannedKpi);
  const tats = findKpiPoints(cfg.actualKpi);
  if (geplant.length && tats.length) {
    derived.planTreueAbsatz = geplant.map((g) => {
      const a = tats.find((t) => t.period === g.period);
      const actual = a?.value ?? null;
      return {
        period: g.period, geplant: g.value, tatsaechlich: actual,
        erfuellungPct: actual != null && g.value ? (actual / g.value) * 100 : null,
      };
    });
  }

  // Market chart metrics for the UI: config substrings → present market
  // metrics; no match → first 6. So the competitor charts populate for any game.
  const marketNames = Object.keys(marketOut);
  let marketChartMetrics = pickBySubstrings(cfg.marketChartMetrics || [], marketNames);
  if (!marketChartMetrics.length) marketChartMetrics = marketNames.slice(0, 6);

  return {
    generatedAt: new Date().toISOString(),
    meta,
    // Run registry so the dashboard can switch between runs (active + frozen).
    run: run ? { id: run.id, label: run.label, status: run.status } : null,
    runs: (registry?.runs || []).map((r) => ({ id: r.id, label: r.label, status: r.status, activeNow: r.id === registry.activeId })),
    periods: [...allPeriods].sort((a, b) => a - b),
    kpis: kpiOut,
    market: marketOut,
    marketPeriods: [...marketPeriods].sort((a, b) => a - b),
    derived,
    decisionsByPeriod,
    predictions,
    rounds,
    // UI hints — the HTML reads these instead of hardcoding game-specific names.
    ui: { headlineKpis, marketChartMetrics },
  };
}

// ---- Cross-RUN comparison (thesis: AI-manager performance, run vs run) ------
// Builds ONE structure that puts every run side by side: for each headline KPI
// the per-period series of every run (for overlay charts), per-run summary stats
// (start/final/peak/trough/avg/total-growth), and per-run prediction accuracy
// (how well the AI forecast matched reality). This is the scientific comparison
// the dashboard's "Modell-Vergleich" section + PNG export consume. Pure derived
// data — it just re-aggregates each run via buildDashboardData(); never reads new
// files or mutates anything.
export function buildComparison(root = process.cwd()) {
  const reg = listRuns(root);
  const runsMeta = [];
  const perRun = {}; // id -> full dashboard data

  for (const r of reg.runs) {
    let d;
    try { d = buildDashboardData(root, { run: r.id }); } catch { continue; }
    perRun[r.id] = d;
    runsMeta.push({
      id: r.id, label: r.label, status: r.status, activeNow: r.id === reg.activeId,
      periods: d.periods, ownCompany: d.meta.ownCompany,
      game: d.meta.game, company: d.meta.company, team: d.meta.team,
    });
  }

  // Union of headline KPIs across runs, in first-seen order, Aktienkurs first.
  const headlineKpis = [];
  for (const id of Object.keys(perRun)) {
    for (const [n, k] of Object.entries(perRun[id].kpis)) {
      if (k.headline && !headlineKpis.includes(n)) headlineKpis.push(n);
    }
  }
  headlineKpis.sort((a, b) => (/Aktienkurs/i.test(b) ? 1 : 0) - (/Aktienkurs/i.test(a) ? 1 : 0));

  // Own-company series from the Marktforschungsbericht for a per-company KPI.
  // TOPSIM's Executive Summary is a rolling 4-period window and does not always
  // carry per-company metrics (e.g. Bekanntheit) — but the competitor sheet does,
  // for the full game. Match the metric label exactly (ignoring any "Section · "
  // prefix on duplicates) and pull our own column.
  const ownMarketSeries = (d, name) => {
    const own = d.meta?.ownCompany;
    if (!own || !d.market) return [];
    const ln = name.toLowerCase();
    let key = Object.keys(d.market).find((n) => n.toLowerCase() === ln);
    if (!key) key = Object.keys(d.market).find((n) => n.split(' · ').pop().toLowerCase() === ln);
    if (!key) return [];
    return d.market[key].points
      .map((p) => ({ period: p.period, value: p.byCompany[own] }))
      .filter((x) => typeof x.value === 'number');
  };
  // For a run + KPI, pick the MOST COMPLETE own series: Executive-Summary
  // timeseries, or (when sparser/missing) the Marktforschungsbericht own column.
  // The same rule is applied to every run, so a given KPI uses one consistent
  // source across runs and stays comparable.
  const seriesFor = (d, name) => {
    const exec = d.kpis?.[name]?.points || [];
    const mkt = ownMarketSeries(d, name);
    return mkt.length > exec.length ? mkt : exec;
  };
  const unitFor = (name) => {
    for (const id of Object.keys(perRun)) { const u = perRun[id].kpis?.[name]?.unit; if (u) return u; }
    for (const id of Object.keys(perRun)) {
      const d = perRun[id];
      const key = Object.keys(d.market || {}).find((n) => n.toLowerCase() === name.toLowerCase());
      if (key && d.market[key].unit) return d.market[key].unit;
    }
    return '';
  };

  // Per-KPI: each run's most-complete point series (for overlay charts) + unit.
  const kpis = {};
  const chosen = {}; // name -> id -> points (reused for summary stats)
  for (const name of headlineKpis) {
    const byRun = {};
    chosen[name] = {};
    for (const id of Object.keys(perRun)) {
      const pts = seriesFor(perRun[id], name);
      if (pts.length) { byRun[id] = pts; chosen[name][id] = pts; }
    }
    kpis[name] = { unit: unitFor(name), byRun };
  }

  // Summary stats for a KPI point series.
  const stat = (points) => {
    if (!points || !points.length) return null;
    const vals = points.map((p) => p.value);
    const start = points[0].value, final = points.at(-1).value;
    let peak = points[0], trough = points[0];
    for (const p of points) { if (p.value > peak.value) peak = p; if (p.value < trough.value) trough = p; }
    return {
      start, final, n: points.length,
      peak: peak.value, peakPeriod: peak.period,
      trough: trough.value, troughPeriod: trough.period,
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      totalGrowthPct: start ? ((final - start) / Math.abs(start)) * 100 : null,
    };
  };

  const summary = {};
  for (const id of Object.keys(perRun)) {
    const kpiStats = {};
    for (const name of headlineKpis) kpiStats[name] = stat(chosen[name]?.[id]);
    // Prediction accuracy: MAE and ±10% hit-rate over scored forecasts.
    const scored = perRun[id].predictions.filter((p) => p.errorPct != null);
    const maePct = scored.length ? scored.reduce((a, p) => a + Math.abs(p.errorPct), 0) / scored.length : null;
    const hitRate10Pct = scored.length ? (scored.filter((p) => Math.abs(p.errorPct) <= 10).length / scored.length) * 100 : null;
    summary[id] = {
      kpiStats,
      prediction: { scored: scored.length, total: perRun[id].predictions.length, maePct, hitRate10Pct },
    };
  }

  return { generatedAt: new Date().toISOString(), runs: runsMeta, headlineKpis, kpis, summary };
}

// CLI: `node scripts/lib/dashboard-data.mjs [--out path] [--root path]`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('dashboard-data.mjs')) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const root = get('--root') || process.cwd();
  if (args.includes('--list-runs')) {
    const reg = listRuns(root);
    console.log(`active run: ${reg.activeId}`);
    for (const r of reg.runs) console.log(`  ${r.id === reg.activeId ? '*' : ' '} #${r.id} [${r.status}] ${r.label}  (${r.location})`);
    process.exit(0);
  }
  if (args.includes('--compare')) {
    const cmp = buildComparison(root);
    const out = get('--out');
    if (out) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(cmp, null, 2));
      console.log(`comparison → ${out}  (runs: ${cmp.runs.length}, KPIs: ${cmp.headlineKpis.length})`);
    } else {
      console.log(JSON.stringify(cmp, null, 2));
    }
    process.exit(0);
  }
  const data = buildDashboardData(root, { run: get('--run') });
  const out = get('--out');
  if (out) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(data, null, 2));
    console.log(`dashboard data → ${out}`);
    console.log(`  periods: [${data.periods.join(', ')}]  KPIs: ${Object.keys(data.kpis).length}  predictions: ${data.predictions.length}`);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
