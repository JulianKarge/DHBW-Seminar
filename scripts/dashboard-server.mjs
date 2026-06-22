// Local TOPSIM dashboard server.
//
// A tiny zero-framework HTTP server (Node built-ins only) that the USER opens
// in their OWN browser tab. It is completely independent of Playwright: it
// never touches the browser the automation drives — it only READS the JSON/MD
// artifacts the capture/apply scripts write under temp/, re-aggregates them
// (scripts/lib/dashboard-data.mjs), and pushes live updates over SSE whenever
// those files change. Start it ONCE before a round; leave it running.
//
//   node scripts/dashboard-server.mjs            # http://127.0.0.1:4321
//   $env:DASH_PORT=5000; node scripts/dashboard-server.mjs   # custom port
//
// Routes:
//   GET /                 dashboard HTML
//   GET /api/data         current aggregated cross-period JSON (fresh read)
//   GET /api/stream       Server-Sent Events; emits `data` on every file change
//   GET /vendor/chart.js  Chart.js UMD (served from node_modules, offline-safe)

import { createServer } from 'node:http';
import { readFileSync, existsSync, watch, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboardData, listRuns, buildComparison } from './lib/dashboard-data.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.DASH_PORT) || 4321;
const HOST = process.env.DASH_HOST || '127.0.0.1';

const HTML_PATH = join(__dirname, 'dashboard', 'index.html');
const CHART_PATH = join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');

// Ensure watched dirs exist so fs.watch doesn't throw on a fresh checkout.
// temp/runs is watched too so archiving a run (registry change + frozen folders)
// pushes a live update to any open dashboard.
const WATCH_DIRS = [
  join(ROOT, 'temp', 'rounds'), join(ROOT, 'temp', 'topsim-data'),
  join(ROOT, 'temp', 'dashboard'), join(ROOT, 'temp', 'runs'),
];
for (const d of WATCH_DIRS) { try { mkdirSync(d, { recursive: true }); } catch {} }

// Each SSE client remembers which run it is viewing so a file change only
// re-renders the run that client selected (default = active run).
const clients = new Map(); // res -> { run }

function currentData(run) {
  try {
    return JSON.stringify(buildDashboardData(ROOT, { run }));
  } catch (e) {
    return JSON.stringify({ error: String(e), generatedAt: new Date().toISOString() });
  }
}

function broadcast() {
  for (const [res, ctx] of clients) {
    try { res.write(`event: update\ndata: ${currentData(ctx.run)}\n\n`); } catch {}
  }
  console.log(`[${new Date().toISOString()}] pushed update to ${clients.size} client(s)`);
}

// Parse ?run= from a request URL (id, 'active', or null=default active).
function runParam(reqUrl) {
  const q = reqUrl.split('?')[1];
  if (!q) return null;
  const v = new URLSearchParams(q).get('run');
  return v == null || v === '' ? null : v;
}

// Debounced recursive watch (one editor save can fire several events).
let debounce = null;
for (const dir of WATCH_DIRS) {
  if (!existsSync(dir)) continue;
  try {
    watch(dir, { recursive: true }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(broadcast, 400);
    });
  } catch (e) {
    console.warn(`watch failed for ${dir}: ${e.message}`);
  }
}

const send = (res, code, type, body) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
};

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    if (!existsSync(HTML_PATH)) return send(res, 500, 'text/plain', 'dashboard/index.html missing');
    return send(res, 200, 'text/html; charset=utf-8', readFileSync(HTML_PATH));
  }

  if (url === '/api/data') {
    return send(res, 200, 'application/json; charset=utf-8', currentData(runParam(req.url)));
  }

  if (url === '/api/runs') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(listRuns(ROOT)));
  }

  if (url === '/api/compare') {
    try {
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(buildComparison(ROOT)));
    } catch (e) {
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ error: String(e), runs: [] }));
    }
  }

  if (url === '/vendor/chart.js') {
    if (!existsSync(CHART_PATH)) return send(res, 500, 'text/plain', 'chart.js not installed (npm i chart.js)');
    return send(res, 200, 'application/javascript; charset=utf-8', readFileSync(CHART_PATH));
  }

  if (url === '/api/stream') {
    const run = runParam(req.url);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: update\ndata: ${currentData(run)}\n\n`);
    clients.set(res, { run });
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  send(res, 404, 'text/plain', 'not found');
});

server.listen(PORT, HOST, () => {
  console.log(`\n  TOPSIM dashboard  →  http://${HOST}:${PORT}`);
  console.log(`  open that in YOUR browser; it live-updates as rounds are captured/applied.`);
  console.log(`  (independent of the Playwright browser — leave this running.)\n`);
});
