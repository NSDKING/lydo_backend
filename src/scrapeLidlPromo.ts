import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { saveLidlPromos } from './supabaseClient.js';

dotenv.config();

export interface LidlPromo {
  title: string;
  price: string;
  available: boolean | null;
  image_url?: string;
  supermarket: 'Lidl';
  source_url: string;
}

/**
 * Extract products from page (FAST + STABLE)
 */
async function extractFromPage(page: any, url: string): Promise<LidlPromo[]> {
  await page.goto(url, {
    waitUntil: 'domcontentloaded', // ⚡ faster than networkidle
    timeout: 30000,
  });

  await page.waitForTimeout(2000);

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

      const image_url =
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
        image_url,
      };
    });
  });

  return products
    .filter((p: any) => p.title && p.price)
    .map((p: any) => ({
      title: p.title,
      price: p.price,
      available: p.available,
      image_url: p.image_url,
      supermarket: 'Lidl',
      source_url: url,
    }));
}

/**
 * MAIN SCRAPER (SAFE FOR RAILWAY)
 */
export async function scrapeLidlPromo(
  catalogueUrl: string,
  maxPages = 2 // ⚡ IMPORTANT LIMIT
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

    // ⚡ block heavy assets (faster + less memory)
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

  if (allPromos.length > 0) {
    await saveLidlPromos(allPromos);
  }

  return allPromos;
}