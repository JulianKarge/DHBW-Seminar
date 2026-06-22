// Opens the in-game Handbuch dialog and dumps the article text for the requested TOC topics.
// Read-only. Usage: node scripts/topsim-handbuch.mjs "Einkauf und Fertigung" "Vertrieb und Produktentwicklung"
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
const topics = process.argv.slice(2);
const slug = (s)=>s.replace(/[^a-z0-9]+/gi,'-').toLowerCase().slice(0,40);

const main = async () => {
  const ctx = await chromium.launchPersistentContext(profileDir, { headless:false, slowMo:300, viewport:null, args:['--start-maximized'] });
  let page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto(LOGIN_URL, { waitUntil:'domcontentloaded', timeout:60000 });
    await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
    await page.getByRole('link',{name:/^games$/i}).or(page.getByText(/^games$/i)).first().click();
    const [pop] = await Promise.all([ ctx.waitForEvent('page',{timeout:8000}), page.getByText('play_circle_filled').first().click() ]);
    page = pop; await page.bringToFront(); await page.waitForLoadState('networkidle',{timeout:20000}).catch(()=>{}); await page.waitForTimeout(2000);

    // open Handbuch
    await page.getByText(/^Handbuch$/).first().click();
    await page.waitForTimeout(1500);
    const dialog = page.locator('dialog, [role=dialog]').first();

    for (const topic of topics) {
      log(`opening topic: ${topic}`);
      // click the TOC entry inside the dialog
      const entry = dialog.getByText(new RegExp('^'+topic.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$','i')).first();
      if (await entry.isVisible().catch(()=>false)) { await entry.click().catch(()=>{}); await page.waitForTimeout(1200); }
      else log(`  TOC entry not directly visible, trying contains`);
      // expand any sub-list by clicking again then dump article
      const article = dialog.locator('article, .content, [class*=content i]').first();
      let txt = await article.innerText().catch(()=> '');
      if (!txt || txt.length < 50) txt = await dialog.innerText().catch(()=> '');
      const f = path.join(outDir, `handbuch-${slug(topic)}.txt`);
      fs.writeFileSync(f, txt);
      log(`  wrote ${f} (${txt.length} chars)`);
    }
    await page.screenshot({ path: path.join(outDir,'handbuch.png') }).catch(()=>{});
  } catch(e){ log('FATAL: '+(e.stack||e.message)); } finally { await ctx.close().catch(()=>{}); log('done'); }
};
main();
