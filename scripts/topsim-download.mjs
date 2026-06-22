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

const ensureLoggedIn = async (page) => {
  if (!(await page.locator('input[type=email]').first().isVisible().catch(() => false))) return;
  const EMAIL = grab('Email'), PASSWORD = grab('Password');
  log('login form present — authenticating');
  await page.locator('input[type=email]').first().fill(EMAIL);
  await page.locator('input[type=password]').first().fill(PASSWORD);
  await page.getByRole('button', { name: /log\s*in|sign\s*in|anmelden|submit/i })
    .or(page.locator('button[type=submit]')).first().click().catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
};

const main = async () => {
  log('launching browser...');
  const ctx = await chromium.launchPersistentContext(profileDir, { headless: false, slowMo: 400, viewport: null, args: ['--start-maximized'], acceptDownloads: true });
  let page = ctx.pages()[0] || (await ctx.newPage());
  try {
    log(`goto ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await ensureLoggedIn(page);

    log('clicking Games -> play button');
    await page.getByRole('link', { name: /^games$/i }).or(page.getByText(/^games$/i)).first().click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const [gameTab] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 8000 }),
      page.getByText('play_circle_filled').first().click(),
    ]);
    page = gameTab;
    await page.bringToFront();
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    log(`game tab: ${page.url()}`);

    log('navigating to #/reports');
    await page.evaluate(() => { window.location.hash = '/reports'; });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // The reports page has two download blocks: "Download: alle Berichte" (pdf|xls) and
    // "Download: Einzelbericht" (pdf|xls). Target the xls button inside the "alle Berichte" block.
    const alleBlock = page.locator(':scope', { hasText: /Download:\s*alle Berichte/i }).first();
    // Find an XLS button that's near "alle Berichte". Use the page-level button list and pick
    // the FIRST xls button (alle Berichte block is rendered first per the screenshot).
    const xlsButtons = page.getByRole('button', { name: /xls/i });
    const xlsCount = await xlsButtons.count();
    log(`xls button count on page: ${xlsCount}`);
    if (xlsCount === 0) throw new Error('no XLS button found on reports page');

    const target = xlsButtons.first(); // alle Berichte XLS (first)
    log('clicking "alle Berichte" XLS button (triggers confirm modal)...');
    await target.click();
    const jaBtn = page.getByRole('button', { name: /^ja$/i }).first();
    await jaBtn.waitFor({ state: 'visible', timeout: 10000 });
    log('confirm modal appeared — clicking Ja and waiting for download');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      jaBtn.click(),
    ]);
    const suggested = download.suggestedFilename();
    // The "alle Berichte" XLS contains all closed periods (cumulative). Filename uses
    // CLI arg `--period N` (the period these reports represent), else auto-detect via the
    // period badge already present in the game tab.
    const argIdx = process.argv.indexOf('--period');
    let periodLabel = (argIdx > -1 && process.argv[argIdx + 1]) ? process.argv[argIdx + 1] : null;
    if (!periodLabel) {
      periodLabel = await page.evaluate(() => {
        const t = document.body.innerText || '';
        const m = t.match(/(?:^|\n)\s*Periode\s*\n\s*(\d{1,3})\s*(?:\n|$)/i);
        return m ? m[1] : 'unknown';
      });
    }
    const outPath = path.join(dataDir, `period-${periodLabel}-${suggested}`);
    await download.saveAs(outPath);
    const size = fs.statSync(outPath).size;
    log(`downloaded: ${outPath} (${size} bytes, suggested filename "${suggested}")`);
    fs.writeFileSync(path.join(dataDir, 'last-download.json'), JSON.stringify({ path: outPath, suggested, size, capturedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    log('FATAL: ' + (e.stack || e.message));
    await page.screenshot({ path: path.join(dataDir, 'download-error.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await ctx.close().catch(() => {});
    log('done');
  }
};
main();
