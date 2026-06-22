import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'artifacts', 'topsim');
const profileDir = path.join(root, 'playwright', '.auth', 'topsim-profile');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

const logFile = path.join(outDir, 'progress.log');
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
};

// --- read credentials from credentials.local.md (markdown table) ---
const credText = fs.readFileSync(path.join(root, 'credentials.local.md'), 'utf8');
const grab = (key) => {
  const m = credText.match(new RegExp(`\\|\\s*${key}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'i'));
  return m ? m[1].trim() : null;
};
const LOGIN_URL = grab('URL');
const EMAIL = grab('Email');
const PASSWORD = grab('Password');
log(`creds parsed: url=${LOGIN_URL} email=${EMAIL} pw=${PASSWORD ? '***' + PASSWORD.length + 'chars***' : 'MISSING'}`);

const dumpElements = async (page, label) => {
  const data = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const pick = (els) => [...els].filter(vis).slice(0, 60).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      text: (el.innerText || el.value || '').trim().slice(0, 80),
    }));
    return {
      url: location.href,
      title: document.title,
      inputs: pick(document.querySelectorAll('input,textarea,select')),
      buttons: pick(document.querySelectorAll('button,[role=button]')),
      links: pick(document.querySelectorAll('a')),
      headings: [...document.querySelectorAll('h1,h2,h3')].map((h) => h.innerText.trim()).filter(Boolean).slice(0, 30),
    };
  });
  fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(data, null, 2));
  log(`dump ${label}: title="${data.title}" url=${data.url} | inputs=${data.inputs.length} buttons=${data.buttons.length} links=${data.links.length}`);
  return data;
};

const shot = async (page, label) => {
  await page.screenshot({ path: path.join(outDir, `${label}.png`), fullPage: false }).catch(() => {});
  log(`screenshot ${label}.png`);
};

const tryCookieBanner = async (page) => {
  const labels = [/accept all/i, /alle akzeptieren/i, /accept/i, /akzeptieren/i, /zustimmen/i, /agree/i, /einverstanden/i, /ok/i];
  for (const re of labels) {
    const btn = page.getByRole('button', { name: re }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      log(`clicked cookie/consent button matching ${re}`);
      await page.waitForTimeout(800);
      return true;
    }
  }
  return false;
};

const status = { startedAt: new Date().toISOString(), steps: [] };
const writeStatus = () => fs.writeFileSync(path.join(outDir, 'status.json'), JSON.stringify(status, null, 2));

const main = async () => {
  log('launching headed chromium (persistent context)...');
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    slowMo: 600,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = context.pages()[0] || (await context.newPage());

  try {
    log(`goto ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => log('networkidle timeout (continuing)'));
    await tryCookieBanner(page);
    await shot(page, '01-landing');
    const landing = await dumpElements(page, '01-landing');
    status.steps.push({ step: 'landing', url: landing.url, title: landing.title });
    writeStatus();

    // Find an email/login field. If none visible, click a Login/Anmelden entry first.
    const emailField = page.locator('input[type=email], input[name*=email i], input[name*=user i], input[id*=email i], input[id*=user i]').first();
    let haveEmail = await emailField.isVisible().catch(() => false);

    if (!haveEmail) {
      const loginEntry = page.getByRole('link', { name: /log\s*in|sign\s*in|anmelden|login/i })
        .or(page.getByRole('button', { name: /log\s*in|sign\s*in|anmelden|login/i })).first();
      if (await loginEntry.isVisible().catch(() => false)) {
        log('no email field on landing; clicking login entry');
        await loginEntry.click().catch((e) => log('login entry click failed: ' + e.message));
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await tryCookieBanner(page);
        await shot(page, '02-login-page');
        await dumpElements(page, '02-login-page');
        haveEmail = await emailField.isVisible().catch(() => false);
      } else {
        log('no obvious login entry found on landing');
      }
    }

    if (haveEmail) {
      log('filling email');
      await emailField.fill(EMAIL);
      // password may be on same page or revealed after "continue"
      let pwField = page.locator('input[type=password]').first();
      if (!(await pwField.isVisible().catch(() => false))) {
        const cont = page.getByRole('button', { name: /continue|next|weiter|fortfahren/i }).first();
        if (await cont.isVisible().catch(() => false)) {
          log('clicking continue/next to reveal password');
          await cont.click().catch(() => {});
          await page.waitForTimeout(1500);
        }
      }
      pwField = page.locator('input[type=password]').first();
      if (await pwField.isVisible().catch(() => false)) {
        log('filling password');
        await pwField.fill(PASSWORD);
        await shot(page, '03-credentials-filled');
        const submit = page.getByRole('button', { name: /log\s*in|sign\s*in|anmelden|login|submit|continue|weiter/i })
          .or(page.locator('button[type=submit]')).first();
        log('submitting login form');
        await submit.click().catch((e) => log('submit click failed: ' + e.message));
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => log('post-login networkidle timeout'));
        await page.waitForTimeout(2000);
      } else {
        log('password field never appeared');
      }
    } else {
      log('email field never found — cannot auto-login; leaving browser open for manual login');
    }

    await tryCookieBanner(page);
    await shot(page, '04-after-login');
    const after = await dumpElements(page, '04-after-login');

    // crude success heuristic
    const stillHasPassword = await page.locator('input[type=password]').first().isVisible().catch(() => false);
    const errorText = await page.locator('text=/invalid|incorrect|falsch|fehler|wrong|error/i').first().innerText().catch(() => '');
    const likelyLoggedIn = !stillHasPassword && !!after.url && !/login|signin|info/i.test(new URL(after.url).pathname);
    status.steps.push({ step: 'after-login', url: after.url, title: after.title, stillHasPassword, errorText, likelyLoggedIn });
    status.result = likelyLoggedIn ? 'LIKELY_LOGGED_IN' : 'UNCERTAIN_CHECK_SCREENSHOTS';
    writeStatus();
    log(`RESULT: ${status.result} | url=${after.url} | stillHasPassword=${stillHasPassword} | error="${errorText}"`);

    // --- navigate into the simulation data ---
    const clickByName = async (re, label) => {
      const loc = page.getByRole('link', { name: re })
        .or(page.getByRole('button', { name: re }))
        .or(page.getByText(re)).first();
      if (await loc.isVisible().catch(() => false)) {
        log(`clicking "${re}" -> ${label}`);
        await loc.click().catch((e) => log(`click ${label} failed: ${e.message}`));
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);
        await shot(page, label);
        await dumpElements(page, label);
        return true;
      }
      log(`nav target not visible: ${re}`);
      return false;
    };

    if (likelyLoggedIn || !stillHasPassword) {
      await clickByName(/^games$/i, '05-games');
      await clickByName(/my games/i, '06-my-games');
    }

    log('keeping browser OPEN for 45 minutes for manual use. Close the window to end early.');
    fs.writeFileSync(path.join(outDir, 'READY'), 'browser open\n');
    await page.waitForTimeout(45 * 60 * 1000);
  } catch (e) {
    log('FATAL: ' + e.stack);
    status.result = 'ERROR';
    status.error = String(e.message);
    writeStatus();
    await shot(page, '99-error');
  } finally {
    await context.close().catch(() => {});
    log('context closed.');
  }
};

main();
