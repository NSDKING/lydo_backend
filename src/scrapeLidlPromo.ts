import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { saveLidlPromos } from './supabaseClient.js';

dotenv.config();

export interface LidlPromo {
  title: string;
  price: string;
  available: boolean | null;
  imageUrl?: string;
  supermarket: 'Lidl';
  sourceUrl: string;
}

/**
 * Extract products directly from rendered DOM
 * (FAST VERSION - no scroll, no useless waits)
 */
async function extractFromPage(page: any, url: string): Promise<LidlPromo[]> {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  // Wait only for product grid (fast + reliable)
  await page.waitForSelector(
    '[data-testid="product-card"], article, .product, div[class*="product"]',
    { timeout: 15000 }
  );

  const products = await page.evaluate(() => {
    const cards = Array.from(
      document.querySelectorAll(
        '[data-testid="product-card"], article, .product, div[class*="product"]'
      )
    );

    return cards.map((card) => {
      const title =
        card.querySelector('h3')?.textContent?.trim() ||
        card.querySelector('[class*="title"]')?.textContent?.trim() ||
        null;

      const price =
        card.querySelector('[data-testid*="price"]')?.textContent?.trim() ||
        card.querySelector('[class*="price"]')?.textContent?.trim() ||
        null;

      const imageUrl =
        (card.querySelector('img') as HTMLImageElement)?.src || null;

      const availabilityText =
        card.querySelector('[class*="availability"]')?.textContent?.toLowerCase() ||
        '';

      const available =
        availabilityText.includes('indisponible') ||
        availabilityText.includes('rupture')
          ? false
          : availabilityText
          ? true
          : null;

      return {
        title,
        price,
        available,
        imageUrl,
      };
    });
  });

  return products
    .filter((p: any) => p.title && p.price)
    .map((p: any) => ({
      title: p.title,
      price: p.price,
      available: p.available,
      imageUrl: p.imageUrl, // ✅ FIXED BUG HERE
      supermarket: 'Lidl',
      sourceUrl: url,
    }));
}

/**
 * MAIN SCRAPER
 */
export async function scrapeLidlPromo(
  catalogueUrl: string,
  maxPages = 5
) {
  const browser = await chromium.launch({
    headless: true,
  });

  const allPromos: LidlPromo[] = [];

  try {
    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    });

    // Block heavy assets BEFORE navigation (performance boost)
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();

      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        return route.abort();
      }

      route.continue();
    });

    const baseUrl = catalogueUrl.split('?')[0];

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const pageUrl = `${baseUrl}?offset=${(pageNum - 1) * 24}`;

      console.log(`Scraping: ${pageUrl}`);

      const promos = await extractFromPage(page, pageUrl);

      if (!promos.length) {
        console.log('No more products → stopping');
        break;
      }

      allPromos.push(...promos);

      console.log(`Page ${pageNum}: ${promos.length} products`);
    }
  } finally {
    await browser.close();
  }

  // Save to Supabase (make sure you use UPSERT in saveLidlPromos)
  if (allPromos.length > 0) {
    await saveLidlPromos(allPromos);
  }

  return allPromos;
}

/**
 * API HANDLER
 */
export async function handler(req: any, res: any) {
  const url = req.query?.url as string;

  if (!url) {
    return res.status(400).json({ error: 'Missing url' });
  }

  try {
    const pages = req.query?.pages
      ? parseInt(req.query.pages, 10)
      : 5;

    const promos = await scrapeLidlPromo(url, pages);

    res.status(200).json({
      count: promos.length,
      promos,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: (err as Error).message,
    });
  }
}