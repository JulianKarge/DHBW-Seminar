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

// extract heading-grouped tables (decisions pages): {section: [{label, value, type}]}
const extractSectionedTables = async (page) =>
  page.evaluate(() => {
    const parseNumber = (s) => {
      if (s == null) return null;
      const t = String(s).replace(/\./g, '').replace(',', '.').replace(/[^0-9.\-]/g, '');
      if (t === '' || t === '-' || t === '.') return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    };
    const out = {};
    let section = null;
    document.querySelectorAll('h4, table').forEach((el) => {
      if (el.tagName === 'H4') {
        const t = el.innerText.trim();
        if (t && !/^(Periode|Hilfezentrum|Berichtswesen)$/i.test(t)) {
          section = t;
          if (!out[section]) out[section] = { columns: [], rows: [] };
        }
      } else if (el.tagName === 'TABLE' && section) {
        // first row is column headers (skip the row-label column)
        const rows = [...el.querySelectorAll('tr')];
        if (rows.length === 0) return;
        const headerCells = [...rows[0].cells];
        const columns = headerCells.slice(1).map((c) => c.innerText.trim()).filter(Boolean);
        if (columns.length) out[section].columns = columns;
        rows.slice(1).forEach((tr) => {
          const cells = [...tr.cells];
          if (cells.length < 2) return;
          const label = cells[0].innerText.trim();
          if (!label) return;
          const values = cells.slice(1).map((cell) => {
            const cb = cell.querySelector('input[type=checkbox]');
            const input = cell.querySelector('input:not([type=checkbox]), textarea');
            if (cb) return { type: 'checkbox', checked: cb.checked };
            if (input) {
              const raw = input.value;
              return { type: 'input', raw, number: parseNumber(raw) };
            }
            const txt = cell.innerText.replace(/\s*\?\s*$/, '').trim();
            return { type: 'text', text: txt, number: parseNumber(txt) };
          });
          out[section].rows.push({ label, values });
        });
      }
    });
    return out;
  });

// extract Infohub KPIs table — first table on the page with KPI rows
const extractInfohubKPIs = async (page) =>
  page.evaluate(() => {
    const parseNumber = (s) => { const t = String(s ?? '').replace(/\./g, '').replace(',', '.').replace(/[^0-9.\-]/g, ''); const n = Number(t); return Number.isFinite(n) ? n : null; };
    const out = {};
    const tables = document.querySelectorAll('table');
    for (const tbl of tables) {
      const rows = [...tbl.querySelectorAll('tr')];
      const head = rows[0]?.innerText?.toLowerCase() || '';
      if (!head.includes('kpi') && !head.includes('kennzahl') && !head.includes('übersicht')) continue;
      rows.slice(1).forEach((tr) => {
        const c = [...tr.cells];
        if (c.length < 3) return;
        const label = c[0].innerText.trim();
        const unit = c[1].innerText.trim();
        const valTxt = c[2].innerText.trim();
        if (!label) return;
        out[label] = { unit, raw: valTxt, number: parseNumber(valTxt) };
      });
      break;
    }
    return out;
  });

const extractBusinessNews = async (page) =>
  page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    const text = (main.innerText || '').trim();
    const pct = (label) => {
      const re = new RegExp(`(?:${label})[^\\n%]*?(\\d+[,.]\\d+|\\d+)\\s*%`, 'i');
      const m = text.match(re);
      if (!m || m[1] == null) return null;
      return Number(String(m[1]).replace(',', '.'));
    };
    return {
      raw: text.slice(0, 8000),
      forecast: {
        bipReal: pct('Bruttoinlandsprodukt|BIP'),
        loehneGehaelterPct: pct('Löhne|Lohn|Gehalt'),
      },
    };
  });

// Decision tab IDs are game-specific. Default = COPYFIX/GM test; override via TOPSIM_DECISION_TABS env (comma-separated).
const DECISION_TABS = (process.env.TOPSIM_DECISION_TABS || 'vertriebUndProduktentwicklung,einkaufUndFertigung,finanzenUndPlanwerte').split(',').map((s) => s.trim()).filter(Boolean);

// Detect the current period + team + game from the live page. Call after navigating to a
// page where "Periode\n<digits>" appears on its own (businessNews or decisions) — NOT Infohub,
// where "Aktuelle Periode" precedes the KPI table headers and would mis-match into KPI values.
const detectMeta = async (page) =>
  page.evaluate(() => {
    const text = document.body.innerText || '';
    // The current period is the badge that appears just BEFORE the "Periode"
    // label: "Unternehmen2(Team 2)\n 2\nPeriode\n...". Matching the number AFTER
    // "Periode" is unsafe from P2 on, because businessNews then contains a
    // "von Periode 1 auf Periode 2" change-table whose "1\n2" collapses to a
    // bogus "12". Prefer the badge-before; fall back to after-label only if absent.
    const periodMatch = text.match(/\n\s*(\d{1,3})\s*\n\s*Periode(?:\s|\n|$)/i)
      || text.match(/(?:^|\n)\s*Periode\s*\n\s*(\d{1,3})\s*(?:\n|$)/i);
    const teamMatch = text.match(/Unternehmen\s*\d+\s*\(([^)]+)\)/i);
    const companyMatch = text.match(/Unternehmen\s*\d+/i);
    return {
      period: periodMatch ? parseInt(periodMatch[1], 10) : null,
      team: teamMatch ? teamMatch[1].trim() : null,
      company: companyMatch ? companyMatch[0].trim() : null,
    };
  });

const main = async () => {
  log('launching browser...');
  const ctx = await chromium.launchPersistentContext(profileDir, { headless: false, slowMo: 400, viewport: null, args: ['--start-maximized'] });
  let page = ctx.pages()[0] || (await ctx.newPage());
  const state = { meta: { capturedAt: new Date().toISOString(), gameId: null, team: null, company: null, period: null }, sections: {} };
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
    // capture gameId/player_id from the initial popup URL before any hash navigation strips it
    const initialUrlMatch = page.url().match(/player_id=(\d+)/);
    if (initialUrlMatch) state.meta.gameId = `player_id=${initialUrlMatch[1]}`;

    log('extracting Infohub KPIs');
    await gotoHash(page, '/index');
    state.sections.infohub = await extractInfohubKPIs(page);

    log('extracting Wirtschaftsnachrichten');
    await gotoHash(page, '/businessNews');
    state.sections.businessNews = await extractBusinessNews(page);

    // detect period + team + company on the businessNews page (clean "Periode\n<n>" pattern)
    const detected = await detectMeta(page);
    state.meta.period = detected.period;
    state.meta.team = detected.team;
    state.meta.company = detected.company;
    log(`detected meta: period=${state.meta.period} team=${state.meta.team} company=${state.meta.company} gameId=${state.meta.gameId}`);

    for (const tab of DECISION_TABS) {
      log(`extracting decisions tab: ${tab}`);
      await gotoHash(page, `/decisions?decision=${tab}`);
      state.sections[`decisions_${tab}`] = await extractSectionedTables(page);
    }

    const periodLabel = state.meta.period != null ? state.meta.period : 'unknown';
    const outPath = path.join(dataDir, `game-state-period-${periodLabel}.json`);
    fs.writeFileSync(outPath, JSON.stringify(state, null, 2));
    log(`wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);
    log('section keys: ' + Object.keys(state.sections).join(', '));
  } catch (e) {
    log('FATAL: ' + (e.stack || e.message));
    process.exitCode = 1;
  } finally {
    await ctx.close().catch(() => {});
    log('done');
  }
};
main();
