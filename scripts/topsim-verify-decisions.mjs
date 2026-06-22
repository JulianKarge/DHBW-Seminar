// READ-ONLY post-save verification. Opens each Entscheidungen tab THREE times and reads back
// every input value + checkbox + the tab's save-status, then compares against the expected
// apply-plan. Never fills, never clicks Speichern. Proves the saved decisions are correct.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PERIOD = process.argv[2] || '2'; // pass the period number as first arg
const outDir = path.join(root, 'temp', 'topsim-data', `verify-period-${PERIOD}`);
const profileDir = path.join(root, 'playwright', '.auth', 'topsim-profile');
fs.mkdirSync(outDir, { recursive: true });
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const credText = fs.readFileSync(path.join(root, 'credentials.local.md'), 'utf8');
const grab = (k) => { const m = credText.match(new RegExp(`\\|\\s*${k}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'i')); return m ? m[1].trim() : null; };
const LOGIN_URL = grab('URL');

const plan = JSON.parse(fs.readFileSync(path.join(root, 'temp', 'rounds', `period-${PERIOD}`, 'apply-plan.json'), 'utf8'));
// expected checkbox states (not in apply-plan): both must stay ON
const EXPECT_CHECK = { 'Aktiv auf Markt 2': true, 'Marktforschungsbericht': true };
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').replace(/\./g, '').replace(',', '.');

const gotoHash = async (page, h) => { await page.evaluate((x)=>{window.location.hash=x.replace(/^#/,'');},h); await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{}); await page.waitForTimeout(1500); };

// read every decision row: label -> array of {type,value/checked} per column, plus tab status
const readTab = async (page) => page.evaluate(() => {
  const out = { rows: [], status: {} };
  document.querySelectorAll('li').forEach((li) => {
    const t = (li.innerText || '').replace(/\s+/g, ' ').trim();
    const m = t.match(/^(Vertrieb und Produktentwicklung|Einkauf und Fertigung|Finanzen und Planwerte)\b(.*)$/);
    if (m) out.status[m[1]] = m[2].trim();
  });
  document.querySelectorAll('table').forEach((tbl) => {
    [...tbl.querySelectorAll('tr')].forEach((tr) => {
      const cells = [...tr.cells]; if (cells.length < 2) return;
      const label = cells[0].innerText.trim(); if (!label) return;
      const vals = cells.slice(1).map((cell) => {
        const cb = cell.querySelector('input[type=checkbox]');
        const inp = cell.querySelector('input:not([type=checkbox]),textarea');
        if (cb) return { type: 'checkbox', checked: cb.checked };
        if (inp) return { type: 'input', raw: inp.value };
        return { type: 'text', text: cell.innerText.replace(/\s*\?\s*$/, '').trim() };
      });
      if (vals.some(v => v.type === 'input' || v.type === 'checkbox')) out.rows.push({ label, vals });
    });
  });
  return out;
});

const findRow = (tab, sub) => tab.rows.find(r => r.label.includes(sub));

const main = async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, { headless:false, slowMo:250, viewport:null, args:['--start-maximized'] });
  let page = ctx.pages()[0] || (await ctx.newPage());
  const passes = [];
  try {
    await page.goto(LOGIN_URL, { waitUntil:'domcontentloaded', timeout:60000 });
    await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
    await page.getByRole('link',{name:/^games$/i}).or(page.getByText(/^games$/i)).first().click();
    const [pop] = await Promise.all([ ctx.waitForEvent('page',{timeout:8000}), page.getByText('play_circle_filled').first().click() ]);
    page = pop; await page.bringToFront(); await page.waitForLoadState('networkidle',{timeout:20000}).catch(()=>{}); await page.waitForTimeout(2000);

    for (let pass = 1; pass <= 3; pass++) {
      log(`========== PASS ${pass} ==========`);
      const passData = {};
      for (const t of plan.tabs) {
        await gotoHash(page, `/decisions?decision=${t.decision}`);
        const data = await readTab(page);
        passData[t.decision] = data;
        await page.screenshot({ path: path.join(outDir, `pass${pass}-${t.decision}.png`) }).catch(()=>{});
        log(`  [P${pass}] ${t.label}: status="${data.status[t.label]||'?'}"`);
      }
      passes.push(passData);
    }

    // ===== compare every expected value across all 3 passes =====
    const problems = [];
    const lines = [];
    for (const t of plan.tabs) {
      lines.push(`\n### ${t.label} (${t.decision})`);
      // status must be a timestamp (saved), identical-ish across passes
      const statuses = passes.map(p => p[t.decision].status[t.label] || '?');
      const savedOk = statuses.every(s => /\d{2}\.\d{2}\.\d{4}/.test(s));
      lines.push(`  status: ${JSON.stringify(statuses)} ${savedOk ? 'GESPEICHERT ✓' : '<<< NICHT GESPEICHERT'}`);
      if (!savedOk) problems.push(`${t.label}: status not saved`);
      for (const inp of t.inputs) {
        const col = inp.col || 0;
        if (inp.type === 'checkbox') {
          const creads = passes.map(p => { const r = findRow(p[t.decision], inp.label); const v = r && r.vals.find(x=>x.type==='checkbox'); return v ? v.checked : null; });
          const cMatch = creads.every(r => r === inp.checked);
          lines.push(`  [checkbox] ${inp.label} erwartet ${inp.checked} → ${JSON.stringify(creads)} ${cMatch?'OK':'<<< MISMATCH'}`);
          if (!cMatch) problems.push(`${t.decision}:${inp.label} checkbox expected ${inp.checked} got ${JSON.stringify(creads)}`);
          continue;
        }
        const reads = passes.map(p => { const r = findRow(p[t.decision], inp.label); const v = r && r.vals.filter(x=>x.type==='input')[col]; return v ? v.raw : '<MISSING>'; });
        const allMatch = reads.every(r => norm(r) === norm(inp.value));
        const allSame = reads.every(r => norm(r) === norm(reads[0]));
        const mark = allMatch ? 'OK' : '<<< MISMATCH';
        lines.push(`  ${inp.label}[c${col}] erwartet "${inp.value}" → P1/P2/P3 ${JSON.stringify(reads)} ${mark}${allSame?'':' (passes differ!)'}`);
        if (!allMatch) problems.push(`${t.decision}:${inp.label}[c${col}] expected ${inp.value} got ${JSON.stringify(reads)}`);
      }
      // checkbox expectations on the vertrieb tab
      for (const [sub, want] of Object.entries(EXPECT_CHECK)) {
        const reads = passes.map(p => { const r = findRow(p[t.decision], sub); const v = r && r.vals.find(x=>x.type==='checkbox'); return v ? v.checked : null; });
        if (reads.some(r => r !== null)) {
          const ok = reads.every(r => r === want);
          lines.push(`  [checkbox] ${sub} erwartet ${want} → ${JSON.stringify(reads)} ${ok?'OK':'<<< MISMATCH'}`);
          if (!ok) problems.push(`${sub} checkbox expected ${want} got ${JSON.stringify(reads)}`);
        }
      }
    }
    lines.push(`\n===== VERDICT: ${problems.length ? 'PROBLEME:\n - ' + problems.join('\n - ') : 'ALLE 3 PASSES BESTÄTIGEN ALLE WERTE ✓'}`);
    const report = lines.join('\n');
    fs.writeFileSync(path.join(outDir, 'verify-report.txt'), report);
    fs.writeFileSync(path.join(outDir, 'verify-raw.json'), JSON.stringify(passes, null, 2));
    console.log(report);
  } catch(e){ log('FATAL: '+(e.stack||e.message)); } finally { await ctx.close().catch(()=>{}); log('done (read-only, nothing changed)'); }
};
main();
