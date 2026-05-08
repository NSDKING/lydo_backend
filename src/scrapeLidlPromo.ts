import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { saveLidlPromos } from './supabaseClient.js';

dotenv.config();

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

/**
 * Extracts all items and calculates discounts
 */
async function extractFromPage(page: any, url: string): Promise<LidlPromo[]> {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // Scroll to trigger lazy loading
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let lastHeight = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 400);
          const newHeight = document.body.scrollHeight;
          if (window.innerHeight + window.scrollY >= newHeight || newHeight === lastHeight) {
            clearInterval(timer);
            resolve();
          }
          lastHeight = newHeight;
        }, 150);
      });
    });

    const products = await page.evaluate(() => {
      // Helper to extract digits and decimals from price strings
      const parsePrice = (str: string | null) => {
        if (!str) return null;
        const match = str.replace(',', '.').match(/(\d+\.\d+|\d+)/);
        return match ? parseFloat(match[0]) : null;
      };

      // Target EVERY product article
      const cards = Array.from(document.querySelectorAll('article, [data-testid="product-card"], .product-grid-item'));

      return cards.map((card) => {
        const title = card.querySelector('h3, [class*="title"]')?.textContent?.trim() || null;
        
        // Lidl often puts the current price in a specific test-id
        const currentPriceText = card.querySelector('[data-testid="current-price"], .price-box__price, [class*="current"]')?.textContent?.trim() || null;
        
        // Old price is usually in a <del> or a "strikethrough" class
        const oldPriceText = card.querySelector('del, [class*="old-price"], [class*="strikethrough"]')?.textContent?.trim() || null;

        const image_url = (card.querySelector('img') as HTMLImageElement)?.src || null;

        const cur = parsePrice(currentPriceText);
        const old = parsePrice(oldPriceText);
        let discount = 0;

        if (cur && old && old > cur) {
          discount = Math.round(((old - cur) / old) * 100);
        }

        return {
          title,
          price: currentPriceText,
          old_price: oldPriceText || null,
          discount_percent: discount > 0 ? discount : 0,
          image_url,
        };
      });
    });

    return products
      .filter((p) => p.title && p.price)
      .map((p) => ({
        title: p.title!,
        price: p.price!,
        old_price: p.old_price || undefined,
        discount_percent: p.discount_percent || undefined,
        available: true,
        image_url: p.image_url || undefined,
        supermarket: 'Lidl',
        source_url: url,
      }));
  } catch (err) {
    console.error("Extraction error:", err);
    return [];
  }
}

export async function scrapeLidlPromo(catalogueUrl: string, maxPages = 5) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const allPromos: LidlPromo[] = [];

  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });

    // Block heavy assets but KEEP CSS for layout logic
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) return route.abort();
      route.continue();
    });

    const baseUrl = catalogueUrl.split('?')[0];

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const pageUrl = `${baseUrl}?offset=${(pageNum - 1) * 24}`;
      console.log(`Scraping: ${pageUrl}`);
      const promos = await extractFromPage(page, pageUrl);

      if (!promos.length) break;
      allPromos.push(...promos);
      await page.waitForTimeout(1000);
    }
  } finally {
    await browser.close();
  }

  if (allPromos.length > 0) {
    await saveLidlPromos(allPromos);
  }

  return allPromos;
}

export async function handler(req: any, res: any) {
  const url = req.query?.url as string;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    const pages = req.query?.pages ? parseInt(req.query.pages, 10) : 1;
    const promos = await scrapeLidlPromo(url, pages);
    res.status(200).json({ count: promos.length, promos });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}