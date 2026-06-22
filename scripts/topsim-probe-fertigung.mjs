// NON-COMMITTAL probe: opens the Einkauf/Fertigung decision tab, enters trial values,
// reads the live "Ergebnisse der Berechnung" (projected capacity/Auslastung/costs), and
// NEVER clicks Speichern. Used to resolve P2 Anlagen capacity + new-Anlage lead time.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'temp', 'topsim-explore');
const profileDir = path.join(root, 'playwright', '.auth', 'topsim-profile');
fs.mkdirSync(outDir, { recursive: true });
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const credText = fs.readFileSync(path.join(root, 'credentials.local.md'), 'utf8');
const grab = (k) => { const m = credText.match(new RegExp(`\\|\\s*${k}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'i')); return m ? m[1].trim() : null; };
const LOGIN_URL = grab('URL');

const gotoHash = async (page, h) => { await page.evaluate((x)=>{window.location.hash=x.replace(/^#/,'');},h); await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{}); await page.waitForTimeout(1500); };
const fillRow = async (page, label, val) => {
  const row = page.locator('tr', { hasText: label }).first();
  await row.waitFor({ state:'visible', timeout:8000 }).catch(()=>{});
  const tb = row.getByRole('textbox').first();
  await tb.click({ clickCount:3 }); await tb.fill(val); await tb.evaluate(el=>el.blur());
  await page.waitForTimeout(1200);
  log(`  filled "${label}" = ${val} (read back ${await tb.inputValue().catch(()=>'?')})`);
};
const grabResults = async (page) => page.evaluate(() => {
  // capture every h4 section + following table text, focus on "Ergebnisse"/capacity wording
  const out = [];
  document.querySelectorAll('h4, h3, h2').forEach(h => {
    const t = (h.innerText||'').trim();
    if (/ergebnis|kapazit|auslast|berechnung/i.test(t)) {
      let el = h.nextElementSibling, buf = [t];
      let n = 0;
      while (el && n < 6) { if (/table|div|section/i.test(el.tagName)) buf.push((el.innerText||'').replace(/\s+/g,' ').trim()); el = el.nextElementSibling; n++; }
      out.push(buf.join('  ::  '));
    }
  });
  // also dump any text node mentioning Kapazität/Auslastung
  const body = (document.querySelector('main')||document.body).innerText||'';
  const lines = body.split('\n').map(s=>s.trim()).filter(s=>/kapazit|auslast|überstund|ergebnis|fertigungskapazit/i.test(s));
  return { sections: out, lines };
});

const main = async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, { headless:false, slowMo:300, viewport:null, args:['--start-maximized'] });
  let page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto(LOGIN_URL, { waitUntil:'domcontentloaded', timeout:60000 });
    await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
    await page.getByRole('link',{name:/^games$/i}).or(page.getByText(/^games$/i)).first().click();
    const [pop] = await Promise.all([ ctx.waitForEvent('page',{timeout:8000}), page.getByText('play_circle_filled').first().click() ]);
    page = pop; await page.bringToFront(); await page.waitForLoadState('networkidle',{timeout:20000}).catch(()=>{}); await page.waitForTimeout(2000);

    await gotoHash(page, '/decisions?decision=einkaufUndFertigung');
    // SCENARIO 1: default existing Anlagen, push Fertigungsmenge very high to reveal capacity via Auslastung
    log('SCENARIO 1: Fertigungsmenge=60.000, Investition=0 (reveals EXISTING P2 capacity)');
    await fillRow(page, 'Fertigungsmenge (Stück)', '60.000');
    let r1 = await grabResults(page);
    fs.writeFileSync(path.join(outDir,'probe-s1.json'), JSON.stringify(r1,null,2));
    log('S1 lines:\n' + r1.lines.join('\n'));

    // SCENARIO 2: add 1 Typ A + 1 Typ B new Anlage, keep Fertigungsmenge high (reveals if new Anlagen add P2 capacity = lead time)
    log('SCENARIO 2: + Investition Typ A=1, Typ B=1 (reveals new-Anlage lead time)');
    const invRow = page.locator('tr', { hasText: 'Investition (Anz. neue Anlagen)' }).first();
    const boxes = invRow.getByRole('textbox');
    await boxes.nth(0).click({clickCount:3}); await boxes.nth(0).fill('1'); await boxes.nth(0).evaluate(el=>el.blur());
    await boxes.nth(1).click({clickCount:3}); await boxes.nth(1).fill('1'); await boxes.nth(1).evaluate(el=>el.blur());
    await page.waitForTimeout(1500);
    let r2 = await grabResults(page);
    fs.writeFileSync(path.join(outDir,'probe-s2.json'), JSON.stringify(r2,null,2));
    log('S2 lines:\n' + r2.lines.join('\n'));

    // capture full page text for manual inspection
    fs.writeFileSync(path.join(outDir,'probe-fulltext.txt'), await page.evaluate(()=> (document.querySelector('main')||document.body).innerText));
    await page.screenshot({ path: path.join(outDir,'probe-fertigung.png'), fullPage:true }).catch(()=>{});
    log('RESET (no save) — clicking Zurücksetzen');
    await page.locator(':text-is("Zurücksetzen")').first().click().catch(()=>{});
    await page.waitForTimeout(800);
  } catch(e){ log('FATAL: '+(e.stack||e.message)); } finally { await ctx.close().catch(()=>{}); log('done (nothing saved)'); }
};
main();
