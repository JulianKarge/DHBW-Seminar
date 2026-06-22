import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'temp', 'topsim-explore');
const profileDir = path.join(root, 'playwright', '.auth', 'topsim-profile');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

// click targets passed as CLI args; each is treated as a case-insensitive regex on accessible name / visible text
const targets = process.argv.slice(2);
const KEEP_OPEN = !process.env.NO_KEEP;

const logFile = path.join(outDir, 'progress.log');
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(logFile, l + '\n'); };

// safety: never auto-click anything that could mutate simulation state
const DANGER = /logout|sign\s*out|abmelden|delete|löschen|loeschen|remove|entfernen|submit|absenden|confirm|bestätig|finish|abschließ|end round|runde beenden|reset|zurücksetzen|pay|kaufen|buy|order now|verbindlich/i;

const credText = fs.readFileSync(path.join(root, 'credentials.local.md'), 'utf8');
const grab = (k) => { const m = credText.match(new RegExp(`\\|\\s*${k}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'i')); return m ? m[1].trim() : null; };
const LOGIN_URL = grab('URL'), EMAIL = grab('Email'), PASSWORD = grab('Password');

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40);

const dump = async (page, label) => {
  const data = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const pick = (els) => [...els].filter(vis).slice(0, 80).map((el) => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', name: el.getAttribute('name') || '', href: el.getAttribute('href') || '', placeholder: el.getAttribute('placeholder') || '', aria: el.getAttribute('aria-label') || '', text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 90) }));
    const main = document.querySelector('main') || document.body;
    // all anchors incl. hidden, with href + accessible-ish name (for collapsed sidebars)
    const anchors = [...document.querySelectorAll('a')].map((a) => ({ text: (a.innerText || a.getAttribute('aria-label') || a.title || '').trim().replace(/\s+/g, ' ').slice(0, 50), href: a.getAttribute('href') || '' })).filter((a) => a.href || a.text).slice(0, 60);
    return {
      url: location.href, title: document.title,
      headings: [...document.querySelectorAll('h1,h2,h3,h4')].map((h) => h.innerText.trim()).filter(Boolean).slice(0, 40),
      inputs: pick(document.querySelectorAll('input,textarea,select')),
      buttons: pick(document.querySelectorAll('button,[role=button]')),
      links: pick(document.querySelectorAll('a,[role=link],[role=menuitem],[role=tab]')),
      anchors,
      navHtml: (document.querySelector('aside,nav,[class*="sidebar" i],[class*="navigation" i],[class*="menu-" i]')?.outerHTML || '').replace(/\s+/g, ' ').slice(0, 4000),
      mainText: (main.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000),
    };
  });
  fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(data, null, 2));
  log(`dump ${label}: "${data.title}" ${data.url} | h=${data.headings.length} in=${data.inputs.length} btn=${data.buttons.length} lnk=${data.links.length}`);
  return data;
};
const shot = async (page, label) => { await page.screenshot({ path: path.join(outDir, `${label}.png`) }).catch(() => {}); };
const snap = async (page, label) => { await shot(page, label); const d = await dump(page, label); try { fs.writeFileSync(path.join(outDir, `${label}.aria.txt`), await page.locator('body').ariaSnapshot({ timeout: 5000 })); } catch (e) { log(`aria ${label} failed: ${e.message}`); } return d; };

const cookie = async (page) => {
  for (const re of [/accept all/i, /alle akzeptieren/i, /accept/i, /akzeptieren/i, /zustimmen/i, /agree/i, /einverstanden/i]) {
    const b = page.getByRole('button', { name: re }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(600); return; }
  }
};

const ensureLoggedIn = async (page) => {
  const email = page.locator('input[type=email], input[name*=email i], input[name*=user i]').first();
  if (!(await email.isVisible().catch(() => false))) { log('already logged in'); return; }
  log('login form present — authenticating');
  await email.fill(EMAIL);
  let pw = page.locator('input[type=password]').first();
  if (!(await pw.isVisible().catch(() => false))) {
    const c = page.getByRole('button', { name: /continue|next|weiter/i }).first();
    if (await c.isVisible().catch(() => false)) { await c.click().catch(() => {}); await page.waitForTimeout(1200); }
  }
  pw = page.locator('input[type=password]').first();
  await pw.fill(PASSWORD);
  await page.getByRole('button', { name: /log\s*in|sign\s*in|anmelden|login|submit/i }).or(page.locator('button[type=submit]')).first().click().catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
};

const main = async () => {
  log(`=== nav run | targets: ${JSON.stringify(targets)} ===`);
  const ctx = await chromium.launchPersistentContext(profileDir, { headless: false, slowMo: 500, viewport: null, args: ['--start-maximized'] });
  let page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await cookie(page);
    await ensureLoggedIn(page);
    await snap(page, '00-start');

    let i = 1;
    for (const t of targets) {
      if (DANGER.test(t)) { log(`SKIP dangerous target: ${t}`); continue; }
      let loc;
      if (/^#\//.test(t)) {
        loc = page.locator(`a[href="${t}"]`).first(); // SPA hash route via anchor
        if (!(await loc.isVisible().catch(() => false))) {
          // fallback: set location.hash directly to trigger SPA routing
          log(`no anchor for ${t}; navigating via location.hash`);
          await page.evaluate((h) => { window.location.hash = h.replace(/^#/, ''); }, t);
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(2000);
          await cookie(page);
          await snap(page, `${String(i).padStart(2,'0')}-${slug(t)}`);
          i++;
          continue;
        }
      } else {
        const re = new RegExp(t, 'i');
        loc = page.getByRole('link', { name: re })
          .or(page.getByRole('button', { name: re }))
          .or(page.getByRole('menuitem', { name: re }))
          .or(page.getByRole('tab', { name: re }))
          .or(page.getByText(re)).first();
      }
      if (!(await loc.isVisible().catch(() => false))) { log(`target NOT visible: ${t}`); await snap(page, `${String(i).padStart(2,'0')}-MISSING-${slug(t)}`); i++; continue; }
      log(`click: ${t}`);
      const [popup] = await Promise.all([
        ctx.waitForEvent('page', { timeout: 4000 }).catch(() => null),
        loc.click().catch((e) => log(`click failed (${t}): ${e.message}`)),
      ]);
      if (popup) { log('new tab opened — switching to it'); page = popup; await page.bringToFront().catch(() => {}); }
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await cookie(page);
      await snap(page, `${String(i).padStart(2,'0')}-${slug(t)}`);
      i++;
    }
    log(`done. final url=${page.url()} | open tabs=${ctx.pages().length}`);
    if (KEEP_OPEN) { fs.writeFileSync(path.join(outDir, 'READY'), 'open\n'); log('keeping browser open 45 min'); await page.waitForTimeout(45 * 60 * 1000); }
  } catch (e) {
    log('FATAL: ' + (e.stack || e.message));
    await shot(page, '99-error');
  } finally {
    await ctx.close().catch(() => {});
    log('closed');
  }
};
main();
