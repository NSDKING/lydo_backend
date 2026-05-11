import dotenv from 'dotenv';
import { chromium, Page } from 'playwright';
import { saveLidlPromos } from './supabaseClient.js';

dotenv.config();

// Replace Unicode characters outside Latin-1 (>255) with ASCII equivalents
function sanitize(str: string): string {
  return str
    .replace(/’|‘/g, "'")   // curly single quotes → straight
    .replace(/“|”/g, '"')   // curly double quotes → straight
    .replace(/–/g, '-')          // en dash
    .replace(/—/g, '--')         // em dash
    .replace(/Œ/g, 'OE')         // Œ
    .replace(/œ/g, 'oe')         // œ
    .replace(/[Ā-￿]/g, c => c.normalize('NFD').replace(/[̀-ͯ]/g, '') || '?')
    .trim();
}

export interface LidlPromo {
  title: string;
  price: string;
  old_price?: string;
  discount_percent?: number;
  available: boolean | null;
  image_url?: string;
  supermarket: 'Lidl';
  source_url: string;
}

async function dismissCookieBanner(page: Page) {
  try {
    const btn = page.locator('#onetrust-accept-btn-handler').first();
    if (await btn.isVisible({ timeout: 3000 })) {
      await btn.click();
      await page.waitForTimeout(1000);
    }
  } catch {}
}

async function autoScroll(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      // phase 1: incremental scroll (triggers intersection observers / lazy loads)
      let total = 0;
      const distance = 500;
      const step = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= document.body.scrollHeight) {
          clearInterval(step);

          // phase 2: wait for new content, then keep scrolling if height grew
          let lastHeight = document.body.scrollHeight;
          let stableCount = 0;
          const stabilise = setInterval(() => {
            window.scrollTo(0, document.body.scrollHeight);
            const h = document.body.scrollHeight;
            if (h === lastHeight) {
              stableCount++;
              if (stableCount >= 3) { clearInterval(stabilise); resolve(); }
            } else {
              stableCount = 0;
              lastHeight = h;
            }
          }, 700);
        }
      }, 250);
    });
  });
  await page.waitForTimeout(500);
}

async function extractFromPage(page: Page, url: string, isFirstPage: boolean): Promise<LidlPromo[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`Opening ${url} (attempt ${attempt})`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

      if (isFirstPage && attempt === 1) {
        await dismissCookieBanner(page);
      }

      // wait for product grid to render
      await page
        .waitForSelector('.product-grid-box', { timeout: 20000 })
        .catch(() => {});

      await autoScroll(page);

      const products = await page.evaluate((sourceUrl: string) => {
        const cards = Array.from(document.querySelectorAll('.product-grid-box'));

        const results: Array<{
          title: string;
          price: string;
          old_price?: string;
          discount_percent?: number;
          available: boolean;
          image_url?: string;
          source_url: string;
        }> = [];

        const seen = new Set<string>();

        for (const card of cards) {
          // --- title & price from structured JSON attribute ---
          let impression: Record<string, any> = {};
          try {
            impression = JSON.parse(
              decodeURIComponent(card.getAttribute('data-gridbox-impression') || '{}')
            );
          } catch {}

          const title: string = impression.name || card.querySelector('.product-grid-box__title')?.textContent?.trim() || '';
          if (!title || seen.has(title)) continue;
          seen.add(title);

          const currentPriceNum: number | undefined = typeof impression.price === 'number' ? impression.price : undefined;
          const price = currentPriceNum !== undefined ? `${currentPriceNum.toFixed(2)} €` : '';
          if (!price) continue;

          // --- old price: look for struck-through price element ---
          const oldPriceEl = card.querySelector(
            '.ods-price__price--old, [class*="old-price"], [class*="OldPrice"], del, s'
          );
          const oldPriceText = oldPriceEl?.textContent?.trim() || undefined;
          const oldPriceNum = oldPriceText
            ? parseFloat(oldPriceText.replace(',', '.').replace(/[^\d.]/g, ''))
            : undefined;
          const old_price = oldPriceNum && !isNaN(oldPriceNum) ? `${oldPriceNum.toFixed(2)} €` : undefined;

          const discount_percent =
            old_price && currentPriceNum && oldPriceNum && oldPriceNum > currentPriceNum
              ? Math.round(((oldPriceNum - currentPriceNum) / oldPriceNum) * 100)
              : undefined;

          // --- image: direct CDN src ---
          const imgEl = card.querySelector('img') as HTMLImageElement | null;
          const rawSrc =
            imgEl?.dataset?.src ||
            imgEl?.dataset?.lazySrc ||
            imgEl?.getAttribute('data-original') ||
            imgEl?.src ||
            undefined;
          const image_url = rawSrc && !rawSrc.startsWith('data:') ? rawSrc : undefined;

          // --- availability from text ---
          const availText = card.querySelector('.product-grid-box__availabilities')?.textContent?.trim().toLowerCase() || '';
          const available = !(
            availText.includes('rupture') ||
            availText.includes('out of stock') ||
            availText.includes('indisponible')
          );

          results.push({ title, price, old_price, discount_percent, available, image_url, source_url: sourceUrl });
        }

        return results;
      }, url);

      console.log(`FOUND PRODUCTS: ${products.length}`);

      return products.map((p) => ({
        ...p,
        title: sanitize(p.title),
        price: p.price.replace(' €', ''),
        old_price: p.old_price ? p.old_price.replace(' €', '') : undefined,
        supermarket: 'Lidl' as const,
      }));
    } catch (err) {
      console.error(`EXTRACTION ERROR (attempt ${attempt}):`, err);
      if (attempt < 3) await page.waitForTimeout(3000 * attempt);
    }
  }
  return [];
}

export async function scrapeLidlPromo(catalogueUrl: string, maxPages = 10) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const allPromos: LidlPromo[] = [];

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1400, height: 900 },
      locale: 'fr-FR',
      extraHTTPHeaders: {
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    });

    const page = await context.newPage();

    await page.route('**/*', (route) => {
      if (['font', 'media'].includes(route.request().resourceType())) return route.abort();
      route.continue();
    });

    const baseUrl = catalogueUrl.split('?')[0];
    const seenTitles = new Set<string>();
    let consecutiveNoNew = 0;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      // server returns 12 items at offset=0, then 24 per page after that
      const offset = pageNum === 1 ? 0 : 12 + (pageNum - 2) * 24;
      const pageUrl = `${baseUrl}?offset=${offset}`;

      console.log(`SCRAPING PAGE ${pageNum} (offset=${offset})`);

      const promos = await extractFromPage(page, pageUrl, pageNum === 1);

      const newPromos = promos.filter(p => !seenTitles.has(p.title));
      newPromos.forEach(p => seenTitles.add(p.title));

      if (!newPromos.length) {
        consecutiveNoNew++;
        if (consecutiveNoNew >= 2) {
          console.log('No new products on 2 consecutive pages — stopping');
          break;
        }
      } else {
        consecutiveNoNew = 0;
        allPromos.push(...newPromos);
        console.log(`  ${newPromos.length} new, ${promos.length - newPromos.length} dupes`);
      }

      if (pageNum < maxPages) {
        await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));
      }
    }
  } finally {
    await browser.close();
  }

  const deduped = Array.from(new Map(allPromos.map((p) => [p.title, p])).values());
  console.log(`TOTAL UNIQUE PRODUCTS: ${deduped.length}`);

  if (deduped.length > 0) await saveLidlPromos(deduped);

  return deduped;
}

export async function handler(req: any, res: any) {
  try {
    const url = req.query?.url as string;
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const pages = req.query?.pages ? parseInt(req.query.pages, 10) : 10;
    const promos = await scrapeLidlPromo(url, pages);

    return res.status(200).json({ count: promos.length, promos });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: (err as Error).message });
  }
}
