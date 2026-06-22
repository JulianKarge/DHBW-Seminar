#!/usr/bin/env node
// Manage TOPSIM simulation RUNS for the dashboard — WITHOUT EVER DELETING DATA.
//
// The dashboard reads the ACTIVE run live from temp/rounds + temp/topsim-data
// (the capture/apply scripts always write there — they are never touched). When
// a game finishes and you want to start a NEW run with a clean slate, this
// script FREEZES the current active run into temp/runs/run-N/ and recreates
// empty live dirs so the next game starts fresh from Period 0. Both runs stay on
// disk forever; the dashboard's run selector switches between them. This is the
// thesis's permanent record of every run for the scientific comparison.
//
// Usage (run from project root):
//   node scripts/dashboard-runs.mjs list
//   node scripts/dashboard-runs.mjs archive [--label "Run 1 — ..."] [--new-label "Run 2"]
//   node scripts/dashboard-runs.mjs relabel <id> "<new label>"
//
// `archive` is the "reset the dashboard for a new run" action: nothing is lost,
// a fresh empty active run is created, and you can still pick the old run in the
// dashboard.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
  renameSync, cpSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TEMP = join(ROOT, 'temp');
const LIVE_ROUNDS = join(TEMP, 'rounds');
const LIVE_DATA = join(TEMP, 'topsim-data');
const RUNS_DIR = join(TEMP, 'runs');
const MANIFEST = join(RUNS_DIR, 'runs.json');

const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const nowISO = () => new Date().toISOString();

// Move a directory; fall back to copy+remove across volumes / when locked.
function moveDir(src, dst) {
  if (!existsSync(src)) return false;
  mkdirSync(dirname(dst), { recursive: true });
  try {
    renameSync(src, dst);
  } catch {
    cpSync(src, dst, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
  return true;
}

function loadManifest() {
  const m = readJSON(MANIFEST);
  if (m && Array.isArray(m.runs) && m.runs.length) return m;
  // Bootstrap: the data sitting at the live location IS run 1 (until archived).
  return { version: 1, activeId: 1, runs: [{ id: 1, label: 'Run 1', location: 'active', status: 'active' }] };
}

function saveManifest(m) {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

// Best-effort: pull a human label hint (game + company) from the live run so the
// frozen run is recognizable in the selector even if no --label is given.
function detectRunMeta(roundsDir) {
  const out = { game: null, company: null, team: null, periods: [] };
  if (!existsSync(roundsDir)) return out;
  const periods = readdirSync(roundsDir)
    .map((n) => n.match(/^period-(\d+)$/)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
  out.periods = periods;
  for (const p of periods) {
    const dir = join(roundsDir, `period-${p}`);
    const rec = readJSON(join(dir, 'recommendation.json'));
    if (rec?.meta?.game) out.game ||= rec.meta.game;
    const st = readJSON(join(dir, 'state.json'));
    if (st?.meta?.company) out.company ||= st.meta.company;
    if (st?.meta?.team) out.team ||= st.meta.team;
  }
  return out;
}

function autoLabel(id, meta) {
  const bits = [meta.game, meta.company].filter(Boolean).join(' · ');
  return bits ? `Run ${id} — ${bits}` : `Run ${id}`;
}

function cmdList() {
  const m = loadManifest();
  console.log(`Runs (active = #${m.activeId}):\n`);
  for (const r of m.runs) {
    const meta = r.location === 'active' ? detectRunMeta(LIVE_ROUNDS) : detectRunMeta(join(RUNS_DIR, r.location, 'rounds'));
    const flag = r.id === m.activeId ? '➤' : ' ';
    console.log(`  ${flag} #${r.id}  [${r.status}]  ${r.label}`);
    console.log(`       location: ${r.location}   periods: [${meta.periods.join(', ') || '—'}]`);
  }
  console.log('');
}

function cmdArchive(opts) {
  const m = loadManifest();
  const active = m.runs.find((r) => r.location === 'active');
  if (!active) { console.error('No active run in manifest — nothing to archive.'); process.exit(1); }

  const hadData = existsSync(LIVE_ROUNDS) && readdirSync(LIVE_ROUNDS).some((n) => /^period-\d+$/.test(n));
  if (!hadData && !opts.force) {
    console.error('Live run has no period data yet — nothing to freeze. Use --force to archive anyway.');
    process.exit(1);
  }

  // 1) Freeze the active run into temp/runs/run-<id>/{rounds,topsim-data}.
  const folder = `run-${active.id}`;
  const dest = join(RUNS_DIR, folder);
  if (existsSync(dest)) { console.error(`${dest} already exists — refusing to overwrite.`); process.exit(1); }
  const meta = detectRunMeta(LIVE_ROUNDS);
  moveDir(LIVE_ROUNDS, join(dest, 'rounds'));
  moveDir(LIVE_DATA, join(dest, 'topsim-data'));

  active.location = folder;
  active.status = 'archived';
  active.archivedAt = nowISO();
  active.game = meta.game; active.company = meta.company; active.team = meta.team;
  active.periods = meta.periods;
  if (opts.label) active.label = opts.label;
  else if (active.label === `Run ${active.id}` || !active.label) active.label = autoLabel(active.id, meta);

  // 2) Create the fresh ACTIVE run and recreate empty live dirs.
  const nextId = Math.max(...m.runs.map((r) => r.id)) + 1;
  const next = {
    id: nextId,
    label: opts.newLabel || `Run ${nextId}`,
    location: 'active',
    status: 'active',
    createdAt: nowISO(),
  };
  m.runs.push(next);
  m.activeId = nextId;
  mkdirSync(LIVE_ROUNDS, { recursive: true });
  mkdirSync(LIVE_DATA, { recursive: true });

  saveManifest(m);
  console.log(`Froze "${active.label}" → temp/runs/${folder}/  (periods [${meta.periods.join(', ') || '—'}])`);
  console.log(`New active run: #${nextId} "${next.label}" → live (temp/rounds + temp/topsim-data, empty)`);
  console.log(`\nDashboard now shows a run selector. Capture Period 0 of the new game to populate it.`);
}

function cmdRelabel(id, label) {
  const m = loadManifest();
  const r = m.runs.find((x) => x.id === Number(id));
  if (!r) { console.error(`No run #${id}.`); process.exit(1); }
  r.label = label;
  saveManifest(m);
  console.log(`Run #${id} relabeled → "${label}"`);
}

// ---- CLI -------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

switch (cmd) {
  case 'list':
    cmdList();
    break;
  case 'archive':
    cmdArchive({ label: flag('--label'), newLabel: flag('--new-label'), force: argv.includes('--force') });
    break;
  case 'relabel':
    cmdRelabel(argv[1], argv.slice(2).join(' '));
    break;
  default:
    console.log('Usage:');
    console.log('  node scripts/dashboard-runs.mjs list');
    console.log('  node scripts/dashboard-runs.mjs archive [--label "..."] [--new-label "Run 2"] [--force]');
    console.log('  node scripts/dashboard-runs.mjs relabel <id> "<new label>"');
    process.exit(cmd ? 1 : 0);
}
