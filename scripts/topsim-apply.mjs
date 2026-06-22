import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'temp', 'topsim-data');
const profileDir = path.join(root, 'playwright', '.auth', 'topsim-profile');
fs.mkdirSync(dataDir, { recursive: true });

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const credText = fs.readFileSync(path.join(root, 'credentials.local.md'), 'utf8');
const grab = (k) => { const m = credText.match(new RegExp(`\\|\\s*${k}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'i')); return m ? m[1].trim() : null; };
const LOGIN_URL = grab('URL');

// Apply plan: pass `--plan <path>` (e.g. temp/rounds/period-N/apply-plan.json) to override.
// If no --plan, falls back to the inline default below (the COPYFIX-GM Period-1 plan, kept as
// a worked example). The JSON file format must be: { "tabs": [{ "decision", "label", "inputs": [{ "label", "value" }] }] }.
const planArgIdx = process.argv.indexOf('--plan');
let APPLY_PLAN;
if (planArgIdx > -1 && process.argv[planArgIdx + 1]) {
  const planPath = path.resolve(process.argv[planArgIdx + 1]);
  console.log(`[apply] reading plan from ${planPath}`);
  APPLY_PLAN = JSON.parse(fs.readFileSync(planPath, 'utf8')).tabs;
} else {
  APPLY_PLAN = [
  {
    decision: 'vertriebUndProduktentwicklung',
    label: 'Vertrieb und Produktentwicklung',
    inputs: [
      { label: 'Preis Markt 1 (EUR)', value: '3.000' },        // unchanged
      { label: 'Werbung Markt 1 (MEUR)', value: '8,00' },      // 6,00 -> 8,00
      { label: 'Vertrieb (Anz. Personen)', value: '110' },      // 100 -> 110
      { label: 'Mitarbeiterendbestand Technologie', value: '35' }, // unchanged
      { label: 'Großabnehmer (Stück)', value: '4.000' },        // 0 -> 4.000
    ],
  },
  {
    decision: 'einkaufUndFertigung',
    label: 'Einkauf und Fertigung',
    inputs: [
      { label: 'Fertigungsmenge (Stück)', value: '40.000' },    // unchanged
      { label: 'Investition (Anz. neue Anlagen)', value: '0' },  // unchanged
      { label: 'Fertigungspersonal', value: '70' },              // 50 -> 70
    ],
  },
  {
    decision: 'finanzenUndPlanwerte',
    label: 'Finanzen und Planwerte',
    inputs: [
      { label: 'Angenommener Absatz Copy Classic Markt 1', value: '45.000' }, // 50.000 -> 45.000
    ],
  },
];
}

const ensureLoggedIn = async (page) => {
  if (!(await page.locator('input[type=email]').first().isVisible().catch(() => false))) return;
  log('logging in');
  await page.locator('input[type=email]').first().fill(grab('Email'));
  await page.locator('input[type=password]').first().fill(grab('Password'));
  await page.getByRole('button', { name: /log\s*in|sign\s*in|anmelden|submit/i }).or(page.locator('button[type=submit]')).first().click().catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
};

const gotoHash = async (page, hash) => {
  await page.evaluate((h) => { window.location.hash = h.replace(/^#/, ''); }, hash);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
};

const fillByRowLabel = async (page, input) => {
  const labelSubstr = input.label, value = input.value, col = input.col || 0;
  // Find <tr> that contains the label text, then its col-th textbox (default 0 = first).
  // Multi-column decision rows (e.g. Vertrieb Markt 1 / Markt 2) need col > 0.
  const row = page.locator('tr', { hasText: labelSubstr }).first();
  await row.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  // Checkbox targets (e.g. "Aktiv auf Markt 1" for Copy Budget) — set checked state.
  if (input.type === 'checkbox') {
    const cbs = row.getByRole('checkbox');
    const cnt = await cbs.count();
    if (cnt === 0) throw new Error(`row "${labelSubstr}" has no checkbox`);
    const idx = (input.cbIndex != null) ? input.cbIndex : (cnt === 1 ? 0 : col);
    const cb = cbs.nth(idx);
    if (input.checked) await cb.check(); else await cb.uncheck();
    const st = await cb.isChecked().catch(() => null);
    log(`  checkbox "${labelSubstr}"[cb ${idx}] set ${input.checked} (read back: ${st})`);
    return;
  }
  const boxes = row.getByRole('textbox');
  const n = await boxes.count();
  if (col >= n) throw new Error(`row "${labelSubstr}" has ${n} textbox(es), col ${col} out of range`);
  const textbox = boxes.nth(col);
  if (!(await textbox.isVisible().catch(() => false))) throw new Error(`no visible textbox (col ${col}) in row "${labelSubstr}"`);
  await textbox.click({ clickCount: 3 });
  await textbox.fill(value);
  await textbox.evaluate((el) => el.blur());
  const actual = await textbox.inputValue().catch(() => '<unknown>');
  log(`  filled "${labelSubstr}"[col ${col}] = "${value}" (read back: "${actual}")`);
};

const clickSpeichernAndConfirm = async (page) => {
  // Speichern is rendered as a styled div (no button role) — match by exact text.
  const btn = page.getByRole('button', { name: /^Speichern$/i })
    .or(page.locator(':text-is("Speichern")')).first();
  await btn.waitFor({ state: 'visible', timeout: 8000 });
  log('  clicking Speichern');
  await btn.click();
  await page.waitForTimeout(800);
  // optional confirm modal
  const jaBtn = page.getByRole('button', { name: /^ja$/i }).first();
  if (await jaBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    log('  confirm modal — clicking Ja');
    await jaBtn.click();
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
};

const readTabStatus = async (page) =>
  page.evaluate(() => {
    const out = {};
    document.querySelectorAll('li').forEach((li) => {
      const t = (li.innerText || '').replace(/\s+/g, ' ').trim();
      const m = t.match(/^(Vertrieb und Produktentwicklung|Einkauf und Fertigung|Finanzen und Planwerte)\b(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    });
    return out;
  });

const main = async () => {
  log(`launching browser (target: test project)`);
  const ctx = await chromium.launchPersistentContext(profileDir, { headless: false, slowMo: 400, viewport: null, args: ['--start-maximized'] });
  let page = ctx.pages()[0] || (await ctx.newPage());
  const result = { startedAt: new Date().toISOString(), source: 'period-1-ai-recommendation.json', tabs: [] };
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await ensureLoggedIn(page);

    log('Games -> play');
    await page.getByRole('link', { name: /^games$/i }).or(page.getByText(/^games$/i)).first().click();
    const [popup] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 8000 }),
      page.getByText('play_circle_filled').first().click(),
    ]);
    page = popup;
    await page.bringToFront();
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    log(`game tab: ${page.url()}`);

    for (const tab of APPLY_PLAN) {
      log(`=== tab: ${tab.label} (${tab.decision}) ===`);
      await gotoHash(page, `/decisions?decision=${tab.decision}`);
      await page.screenshot({ path: path.join(dataDir, `apply-${tab.decision}-1-before.png`) }).catch(() => {});

      const statusBefore = await readTabStatus(page);
      log(`  status before: ${JSON.stringify(statusBefore)}`);

      const tabResult = { tab: tab.label, decision: tab.decision, inputs: [], statusBefore, statusAfter: null };
      for (const input of tab.inputs) {
        try {
          await fillByRowLabel(page, input);
          tabResult.inputs.push({ ...input, ok: true });
        } catch (e) {
          log(`  FILL FAILED for "${input.label}": ${e.message}`);
          tabResult.inputs.push({ ...input, ok: false, error: e.message });
        }
      }
      await page.screenshot({ path: path.join(dataDir, `apply-${tab.decision}-2-filled.png`) }).catch(() => {});

      await clickSpeichernAndConfirm(page);
      await page.screenshot({ path: path.join(dataDir, `apply-${tab.decision}-3-after.png`) }).catch(() => {});

      const statusAfter = await readTabStatus(page);
      tabResult.statusAfter = statusAfter;
      log(`  status after:  ${JSON.stringify(statusAfter)}`);
      result.tabs.push(tabResult);
    }

    result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dataDir, 'apply-result.json'), JSON.stringify(result, null, 2));
    log('all tabs processed. apply-result.json written.');
  } catch (e) {
    log('FATAL: ' + (e.stack || e.message));
    await page.screenshot({ path: path.join(dataDir, 'apply-error.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await ctx.close().catch(() => {});
    log('closed.');
  }
};
main();
