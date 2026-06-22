import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'temp', 'topsim-data');

// Default to the NEWEST period-*-reports.xls (the round just downloaded), not a
// fixed filename — otherwise a new round silently re-parses last round's export.
const latestReportsXls = (dir) => {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((n) => /^period-.*reports\.xlsx?$/i.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(dir, files[0].n) : null;
};
const xlsPath = process.argv[2] || latestReportsXls(dataDir) || path.join(dataDir, 'period-0-reports.xls');
if (!fs.existsSync(xlsPath)) {
  console.error(`xls file not found: ${xlsPath}`);
  process.exit(1);
}
console.log(`parsing: ${path.basename(xlsPath)}`);

const wb = XLSX.readFile(xlsPath, { cellDates: true, cellNF: false, cellText: false });
console.log(`workbook: ${path.basename(xlsPath)} (${fs.statSync(xlsPath).size} bytes)`);
console.log(`sheets (${wb.SheetNames.length}): ${wb.SheetNames.join(' | ')}`);

const sheets = {};
const summary = [];
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });
  // strip purely-empty cells from row ends
  const trimmed = rows.map((r) => {
    let end = r.length - 1;
    while (end >= 0 && (r[end] === null || r[end] === '' || r[end] === undefined)) end--;
    return r.slice(0, end + 1);
  }).filter((r) => r.length > 0);
  sheets[name] = trimmed;
  const cells = trimmed.reduce((acc, r) => acc + r.length, 0);
  summary.push({ sheet: name, rows: trimmed.length, cells });
}

const gameState = {
  meta: {
    capturedAt: new Date().toISOString(),
    source: path.basename(xlsPath),
    gameId: '143641 (Test Projekt)',
    team: 'Team 2',
    note: 'Period 0 closing-state reports exported from TOPSIM General Management. This is the read-side input an AI agent would consume each period.',
  },
  sheetSummary: summary,
  sheets,
};

const outPath = path.join(dataDir, 'game-state.json');
fs.writeFileSync(outPath, JSON.stringify(gameState, null, 2));
console.log(`wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);
console.log('\nsheet summary:');
for (const s of summary) console.log(`  ${s.sheet.padEnd(35)} rows=${String(s.rows).padStart(4)} cells=${s.cells}`);
