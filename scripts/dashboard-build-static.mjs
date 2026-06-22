#!/usr/bin/env node
// Build a SELF-CONTAINED static dashboard for sharing (GitHub Pages / email / a
// double-clicked file). It bakes every run's aggregated data + the cross-run
// comparison + Chart.js INLINE into a single index.html — no Node server, no API
// calls, no external requests. The same scripts/dashboard/index.html drives both
// the live server and this snapshot: when window.__DASHBOARD_DATA__ is present the
// page reads from it instead of /api/* (see the STATIC branch in that file).
//
// Usage (from project root):
//   node scripts/dashboard-build-static.mjs
//   TOPSIM_OWN_COMPANY=U6 node scripts/dashboard-build-static.mjs   # force own seat
//
// Writes (so it works whether GitHub Pages serves from "main /(root)" OR "main /docs"):
//   index.html        + .nojekyll        (repo root)
//   docs/index.html   + docs/.nojekyll
// Both files are identical, fully self-contained snapshots.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboardData, buildComparison, listRuns } from './lib/dashboard-data.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TEMPLATE = join(__dirname, 'dashboard', 'index.html');
const CHARTJS = join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');
const SCRIPT_TAG = '<script src="/vendor/chart.js"></script>';

const nowISO = () => new Date().toISOString();

function build() {
  if (!existsSync(TEMPLATE)) throw new Error(`template missing: ${TEMPLATE}`);
  if (!existsSync(CHARTJS)) throw new Error(`chart.js missing (run: npm i): ${CHARTJS}`);

  // 1) Aggregate every run + the comparison into one embeddable blob.
  const reg = listRuns(ROOT);
  const byRun = {};
  for (const r of reg.runs) {
    try { byRun[String(r.id)] = buildDashboardData(ROOT, { run: r.id }); }
    catch (e) { console.warn(`! run ${r.id} skipped: ${e.message}`); }
  }
  const compare = buildComparison(ROOT);
  const embed = { activeId: reg.activeId, builtAt: nowISO(), byRun, compare };

  // 2) Compose the self-contained HTML: inline Chart.js + inject the data blob.
  let html = readFileSync(TEMPLATE, 'utf8');
  if (!html.includes(SCRIPT_TAG)) {
    throw new Error(`could not find Chart.js tag in template (looked for: ${SCRIPT_TAG})`);
  }
  const chartjs = readFileSync(CHARTJS, 'utf8');
  // Escape "<" so a "</script>" or "<!--" inside the JSON can't terminate the tag.
  const blobJson = JSON.stringify(embed).replace(/</g, '\\u003c');
  const dataBlob = `<script>window.__DASHBOARD_DATA__=${blobJson};</script>`;
  const inlineChart = `<script>/* Chart.js (UMD) inlined for offline/static use */\n${chartjs}\n</script>`;

  html = html.replace(SCRIPT_TAG, `${dataBlob}\n${inlineChart}`);
  const banner = `<!-- AUTO-GENERATED static snapshot — DO NOT EDIT.\n`
    + `     Source: scripts/dashboard/index.html + scripts/dashboard-build-static.mjs\n`
    + `     Built: ${embed.builtAt}  ·  Runs: ${Object.keys(byRun).join(', ')} -->\n`;
  html = html.replace('<!DOCTYPE html>', `<!DOCTYPE html>\n${banner}`);

  // 3) Emit to repo root AND docs/ (covers either GitHub Pages branch-folder source).
  const targets = [join(ROOT, 'index.html'), join(ROOT, 'docs', 'index.html')];
  for (const out of targets) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    // .nojekyll: serve files verbatim, skip Jekyll processing on GitHub Pages.
    writeFileSync(join(dirname(out), '.nojekyll'), '');
  }

  const kb = (p) => (statSync(p).size / 1024).toFixed(0);
  console.log(`Built self-contained dashboard snapshot (${nowISO()})`);
  console.log(`  runs embedded : ${Object.keys(byRun).map((id) => `#${id} [${byRun[id].periods.join('/')}]`).join('  ')}`);
  console.log(`  active run    : ${embed.activeId}`);
  console.log(`  comparison    : ${compare.runs.length} runs × ${compare.headlineKpis.length} KPIs`);
  for (const out of targets) console.log(`  → ${out}  (${kb(out)} KB)`);
  console.log(`\nCommit index.html + docs/ + .nojekyll, push to main, and GitHub Pages serves it.`);
}

build();
