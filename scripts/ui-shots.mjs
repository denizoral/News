// UI review screenshots and a scroll/click check for the news page.
//
//   npm i --no-save playwright
//   node scripts/ui-shots.mjs --prefix before [--url http://localhost:3000] [--out docs/screenshots/ui-review]
//   node scripts/ui-shots.mjs --verify        # only run the chip-click check
//
// Captures desktop (1440x900) and mobile (390x844) in light and dark: the top
// of the page, the page scrolled ~1500px with the new-stories pill forced on,
// the filter bar, and the markets view. The check scrolls 1500px, forces the
// pill visible and clicks every topic chip, asserting aria-pressed flips.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean));
const url = args.url || 'http://localhost:3000';
const out = args.out || 'docs/screenshots/ui-review';
const prefix = args.prefix || 'shot';
const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

const forcePill = (page) => page.evaluate(() => {
  const pill = document.querySelector('#newPill');
  pill.textContent = 'Show 12 new stories';
  pill.hidden = false;
});

async function open(browser, vp, scheme, hash = '#news') {
  const page = await browser.newPage({ viewport: viewports[vp], colorScheme: scheme, deviceScaleFactor: 1 });
  await page.goto(`${url}/${hash}`);
  await page.waitForSelector(hash === '#markets' ? '#marketList .market' : '#topicChips .chip');
  await page.waitForTimeout(600);
  return page;
}

async function scrollTo(page, y) {
  await page.evaluate((y) => window.scrollTo(0, y), y);
  await page.waitForTimeout(300);
}

async function shots(browser) {
  mkdirSync(out, { recursive: true });
  for (const vp of Object.keys(viewports)) {
    for (const scheme of ['light', 'dark']) {
      const name = (what) => join(out, `${prefix}-${vp}-${what}-${scheme}.png`);
      const page = await open(browser, vp, scheme);
      await page.screenshot({ path: name('top') });
      await page.locator('.filters').screenshot({ path: name('filters') });
      await scrollTo(page, 1500);
      await forcePill(page);
      await page.waitForTimeout(450);
      await page.screenshot({ path: name('scrolled') });
      await page.close();
      const markets = await open(browser, vp, scheme, '#markets');
      await markets.screenshot({ path: name('markets') });
      await markets.close();
    }
  }
}

async function verify(browser) {
  let failures = 0;
  for (const vp of Object.keys(viewports)) {
    const page = await open(browser, vp, 'light');
    const topics = await page.$$eval('#topicChips [data-topic]', (b) => b.map((x) => x.dataset.topic));
    // Start from a topic other than the one under test so every click must flip it.
    for (const topic of [...topics.slice(1), topics[0]]) {
      await scrollTo(page, 1500);
      await forcePill(page);
      const chip = page.locator(`#topicChips [data-topic="${topic}"]`);
      const before = await chip.getAttribute('aria-pressed');
      try {
        // Points across the chip's width must hit the chip itself, not the pill or anything above it.
        // On mobile the filters scroll with the page, so first bring an offscreen chip back to mid-screen.
        const blocked = await chip.evaluate((el) => {
          let r = el.getBoundingClientRect();
          const head = document.querySelector('.masthead').getBoundingClientRect().bottom;
          if (r.top < head || r.bottom > innerHeight) { el.scrollIntoView({ block: 'center' }); r = el.getBoundingClientRect(); }
          const y = r.top + r.height / 2;
          const pts = [0.2, 0.5, 0.8].flatMap((f) => [[r.left + r.width * f, y], [r.left + r.width * f, r.top + 3], [r.left + r.width * f, r.bottom - 3]]);
          const hit = pts.map(([x, y]) => document.elementFromPoint(x, y)).find((h) => h && !el.contains(h));
          return hit ? `${hit.tagName.toLowerCase()}#${hit.id || ''}.${hit.className || ''}` : '';
        });
        if (blocked) throw new Error(`covered by ${blocked}`);
        await chip.click({ timeout: 2000 });
        const after = await page.locator(`#topicChips [data-topic="${topic}"]`).getAttribute('aria-pressed');
        if (before === 'true' || after !== 'true') throw new Error(`aria-pressed ${before} -> ${after}`);
      } catch (e) {
        failures++;
        console.log(`FAIL ${vp} ${topic}: ${e.message.split('\n')[0]}`);
      }
    }
    console.log(`${vp}: clicked ${topics.length} topic chips after scrolling 1500px`);
    await page.close();
  }
  return failures;
}

// CHROMIUM_PATH lets a preinstalled browser stand in for Playwright's pinned one.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failures = 0;
try {
  if (!args.verify) await shots(browser);
  if (args.verify || args.check) failures = await verify(browser);
} finally {
  await browser.close();
}
if (failures) { console.log(`${failures} chip clicks failed`); process.exit(1); }
console.log('ok');
