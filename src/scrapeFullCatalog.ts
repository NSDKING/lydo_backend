/**
 * Scrapes ALL food products from the Lidl France "Manger & Boire" section.
 * Covers the main category + every known food subcategory.
 * Run with: npx ts-node src/scrapeFullCatalog.ts
 * Or trigger via POST /lidl/scrape-catalog on the backend.
 */

import dotenv from 'dotenv';
import { chromium, Page } from 'playwright';
import { supabaseAdmin } from './supabaseClient.js';
import { LidlPromo } from './scrapeLidlPromo.js';

dotenv.config();

// ─── Category pages to scrape ────────────────────────────────────────────────
// Each entry: [label, url]
const CATALOG_CATEGORIES: [string, string][] = [
  ['Manger & Boire',           'https://www.lidl.fr/c/manger-boire/s10068374'],
  ['Fruits & Légumes',         'https://www.lidl.fr/h/fruits-et-legumes/h10071012'],
  ['Viandes & Charcuteries',   'https://www.lidl.fr/h/viandes-et-charcuteries/h10071016'],
  ['Poissons & Crustacés',     'https://www.lidl.fr/h/poissons-et-crustaces/h10071050'],
  ['Fromages & Laitiers',      'https://www.lidl.fr/h/fromages-produits-laitiers/h10071017'],
  ['Œufs & Produits secs',     'https://www.lidl.fr/h/oeufs-et-produits-secs/h10071045'],
  ['Pains & Viennoiseries',    'https://www.lidl.fr/h/pains-et-viennoiseries/h10071015'],
  ['Plats préparés',           'https://www.lidl.fr/h/plats-prepares/h10071020'],
  ['Épicerie & Sucreries',     'https://www.lidl.fr/h/epicerie-et-sucreries/h10071044'],
  ['Huiles & Conserves',       'https://www.lidl.fr/h/huiles-conserves/h10071681'],
  ['Sauces & Épices',          'https://www.lidl.fr/h/sauces-epices/h10071682'],
  ['Confitures & Tartinades',  'https://www.lidl.fr/h/confitures-pates-a-tartiner/h10071684'],
  ['Café, Thé & Cacao',        'https://www.lidl.fr/h/cafe-the-cacao/h10071683'],
  ['Boissons',                 'https://www.lidl.fr/h/boissons/h10071022'],
  ['Surgelés',                 'https://www.lidl.fr/h/produits-surgeles/h10071049'],
  ['Vins & Spiritueux',        'https://www.lidl.fr/h/vins-et-spiritueux/h10071687'],
];

const MAX_PAGES_PER_CATEGORY = 30; // 12 + 29×24 = ~708 products max per category

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitize(str: string): string {
  return str
    .replace(/'|'/g, "'").replace(/"|"/g, '"')
    .replace(/–/g, '-').replace(/—/g, '--')
    .replace(/Œ/g, 'OE').replace(/œ/g, 'oe')
    .replace(/[Ā-￿]/g, c => c.normalize('NFD').replace(/[̀-ͯ]/g, '') || '?')
    .trim();
}

async function dismissCookies(page: Page) {
  try {
    const btn = page.locator('#onetrust-accept-btn-handler').first();
    if (await btn.isVisible({ timeout: 4000 })) {
      await btn.click();
      await page.waitForTimeout(800);
    }
  } catch {}
}

async function autoScroll(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>(resolve => {
      let total = 0;
      const step = setInterval(() => {
        window.scrollBy(0, 600);
        total += 600;
        if (total >= document.body.scrollHeight) {
          clearInterval(step);
          let last = document.body.scrollHeight, stable = 0;
          const check = setInterval(() => {
            window.scrollTo(0, document.body.scrollHeight);
            const h = document.body.scrollHeight;
            if (h === last) { if (++stable >= 3) { clearInterval(check); resolve(); } }
            else { stable = 0; last = h; }
          }, 600);
        }
      }, 200);
    });
  });
  await page.waitForTimeout(400);
}

async function extractPage(page: Page, url: string, acceptCookies: boolean): Promise<LidlPromo[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (acceptCookies) await dismissCookies(page);
      await page.waitForSelector('.product-grid-box', { timeout: 15000 }).catch(() => {});
      await autoScroll(page);

      const products = await page.evaluate((src: string) => {
        const results: any[] = [];
        const seen = new Set<string>();

        for (const card of document.querySelectorAll('.product-grid-box')) {
          let imp: any = {};
          try { imp = JSON.parse(decodeURIComponent(card.getAttribute('data-gridbox-impression') || '{}')); } catch {}

          const title: string = imp.name || card.querySelector('.product-grid-box__title')?.textContent?.trim() || '';
          if (!title || seen.has(title)) continue;
          seen.add(title);

          const currentPriceNum: number | undefined = typeof imp.price === 'number' ? imp.price : undefined;
          const price = currentPriceNum !== undefined ? `${currentPriceNum.toFixed(2)}` : '';
          if (!price) continue;

          const oldEl = card.querySelector('.ods-price__price--old,[class*="old-price"],[class*="OldPrice"],del,s');
          const oldTxt = oldEl?.textContent?.trim();
          const oldNum = oldTxt ? parseFloat(oldTxt.replace(',', '.').replace(/[^\d.]/g, '')) : undefined;
          const old_price = oldNum && !isNaN(oldNum) ? `${oldNum.toFixed(2)}` : undefined;
          const discount_percent = old_price && currentPriceNum && oldNum && oldNum > currentPriceNum
            ? Math.round(((oldNum - currentPriceNum) / oldNum) * 100)
            : undefined;

          const imgEl = card.querySelector('img') as HTMLImageElement | null;
          const rawSrc = imgEl?.dataset?.src || imgEl?.dataset?.lazySrc || imgEl?.getAttribute('data-original') || imgEl?.src;
          const image_url = rawSrc && !rawSrc.startsWith('data:') ? rawSrc : undefined;

          const availTxt = card.querySelector('.product-grid-box__availabilities')?.textContent?.trim().toLowerCase() || '';
          const available = !availTxt.includes('rupture') && !availTxt.includes('indisponible') && !availTxt.includes('out of stock');

          results.push({ title, price, old_price, discount_percent, available, image_url, source_url: src });
        }
        return results;
      }, url);

      return products.map(p => ({ ...p, title: sanitize(p.title), supermarket: 'Lidl' as const }));
    } catch (err) {
      console.error(`  attempt ${attempt} failed:`, (err as Error).message);
      if (attempt < 3) await page.waitForTimeout(3000 * attempt);
    }
  }
  return [];
}

// ─── Upsert ───────────────────────────────────────────────────────────────────
// All catalog items use source_url='catalog' so (title, source_url) is unique
// per product and upserts work with the existing DB constraint.

const CATALOG_SOURCE = 'catalog';

async function saveCatalogItems(items: LidlPromo[]) {
  if (!items.length) return;
  const rows = items.map(({ supermarket: _, source_url: _su, ...rest }) => ({
    ...rest,
    source_url: CATALOG_SOURCE,
  }));
  // Batch in chunks of 200 to avoid payload limits
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await supabaseAdmin
      .from('lidl_promos')
      .upsert(chunk, { onConflict: 'title,source_url' });
    if (error) console.error('  upsert error:', error.message);
    else console.log(`  saved chunk ${i}–${i + chunk.length}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function scrapeFullCatalog(): Promise<{ total: number }> {
  console.log('Launching browser…');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const allItems: LidlPromo[] = [];
  let cookiesAccepted = false;

  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1400, height: 900 },
      locale: 'fr-FR',
      extraHTTPHeaders: { 'Accept-Language': 'fr-FR,fr;q=0.9' },
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    });

    const page = await ctx.newPage();
    await page.route('**/*', route => {
      if (['font', 'media'].includes(route.request().resourceType())) return route.abort();
      route.continue();
    });

    for (const [label, categoryUrl] of CATALOG_CATEGORIES) {
      console.log(`\n=== ${label} ===`);
      const seenInCat = new Set<string>();
      let noNewCount = 0;

      for (let pg = 1; pg <= MAX_PAGES_PER_CATEGORY; pg++) {
        const offset = pg === 1 ? 0 : 12 + (pg - 2) * 24;
        const url = `${categoryUrl}?offset=${offset}`;

        process.stdout.write(`  page ${pg} (offset=${offset})… `);
        const items = await extractPage(page, url, !cookiesAccepted);
        cookiesAccepted = true;

        const fresh = items.filter(p => !seenInCat.has(p.title));
        fresh.forEach(p => seenInCat.add(p.title));
        process.stdout.write(`${fresh.length} new\n`);

        if (!fresh.length) {
          if (++noNewCount >= 2) { console.log('  → no new items, moving on'); break; }
        } else {
          noNewCount = 0;
          allItems.push(...fresh);
        }

        if (pg < MAX_PAGES_PER_CATEGORY) await page.waitForTimeout(1200 + Math.random() * 600);
      }

      console.log(`  subtotal for ${label}: ${seenInCat.size}`);
    }
  } finally {
    await browser.close();
  }

  // Deduplicate across categories by title, keeping best (has image wins)
  const byTitle = new Map<string, LidlPromo>();
  for (const item of allItems) {
    const existing = byTitle.get(item.title);
    if (!existing || (!existing.image_url && item.image_url)) byTitle.set(item.title, item);
  }
  const deduped = [...byTitle.values()];

  console.log(`\nTotal unique products: ${deduped.length}`);
  await saveCatalogItems(deduped);
  console.log('Done.');

  return { total: deduped.length };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function handler(_req: any, res: any) {
  try {
    const result = await scrapeFullCatalog();
    return res.status(200).json(result);
  } catch (err) {
    console.error('Full catalog scrape failed:', err);
    return res.status(500).json({ error: (err as Error).message });
  }
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('scrapeFullCatalog.ts') || process.argv[1]?.endsWith('scrapeFullCatalog.js')) {
  scrapeFullCatalog().then(r => {
    console.log(`Scraped ${r.total} products.`);
    process.exit(0);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
