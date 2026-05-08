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
 * Extract products from page with improved scrolling and selector resilience
 */
async function extractFromPage(page: any, url: string): Promise<LidlPromo[]> {
  try {
    // Increased timeout for slow catalog loads
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    
    // Initial wait for dynamic components
    await page.waitForTimeout(3000);

    // Optimized Scroll Logic
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let lastHeight = 0;
        let distance = 100;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          
          if (window.innerHeight + window.scrollY >= scrollHeight || lastHeight === scrollHeight) {
            // Give it one more check for lazy loading
            setTimeout(() => {
              if (document.body.scrollHeight === scrollHeight) {
                clearInterval(timer);
                resolve();
              }
            }, 1000);
          }
          lastHeight = scrollHeight;
        }, 100); // Faster intervals for smoother triggering of lazy-loading
      });
    });

    const products = await page.evaluate(() => {
      // Broadened selectors to catch Lidl's varying card structures
      const cards = Array.from(
        document.querySelectorAll(
          '[data-testid="product-card"], article, .product-grid-item, .n-catalog-list__item'
        )
      );

      return cards.map((card) => {
        const title =
          card.querySelector('h3')?.textContent?.trim() ||
          card.querySelector('[class*="title"]')?.textContent?.trim() ||
          card.querySelector('.product-grid-item__title')?.textContent?.trim() ||
          null;

        const price =
          card.querySelector('[data-testid*="price"]')?.textContent?.trim() ||
          card.querySelector('.price-box__price')?.textContent?.trim() ||
          card.querySelector('[class*="price"]')?.textContent?.trim() ||
          null;

        const imageElement = card.querySelector('img') as HTMLImageElement;
        const image_url = imageElement?.src || imageElement?.dataset?.src || null;

        const availabilityText =
          card.querySelector('[class*="availability"]')?.textContent?.toLowerCase() ||
          (card.textContent || '').toLowerCase();

        let available = true;
        if (availabilityText.includes('indisponible') || availabilityText.includes('épuisé') || availabilityText.includes('rupture')) {
          available = false;
        }

        return { title, price, available, image_url };
      });
    });

    return products
      .filter((p: any) => p.title && p.price)
      .map((p: any) => ({
        ...p,
        supermarket: 'Lidl' as const,
        source_url: url,
      }));
  } catch (error) {
    console.error(`Error extracting from ${url}:`, error);
    return [];
  }
}

/**
 * MAIN SCRAPER
 */
export async function scrapeLidlPromo(catalogueUrl: string, maxPages = 5) {
  // CRITICAL: Args for Railway/Linux environments
  const browser = await chromium.launch({ 
    headless: true,
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox', 
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote'
    ]
  });

  const allPromos: LidlPromo[] = [];

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    // Block heavy assets BUT KEEP stylesheets for layout-dependent scrolling
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        return route.abort();
      }
      route.continue();
    });

    const baseUrl = catalogueUrl.split('?')[0];

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      // Lidl often uses 'offset' or 'page' depending on the region/version
      const pageUrl = `${baseUrl}?offset=${(pageNum - 1) * 24}`;

      console.log(`Scraping: ${pageUrl}`);
      const promos = await extractFromPage(page, pageUrl);

      if (promos.length === 0) {
        console.log('No products found on this page, stopping.');
        break;
      }

      allPromos.push(...promos);
      console.log(`Page ${pageNum}: Added ${promos.length} products.`);
      
      // Prevent rapid-fire requests
      await page.waitForTimeout(1000);
    }
  } finally {
    await browser.close();
  }

  if (allPromos.length > 0) {
    console.log(`Syncing ${allPromos.length} items to database...`);
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
    return res.status(400).json({ error: 'Missing url query parameter' });
  }

  try {
    const pages = req.query?.pages ? parseInt(req.query.pages, 10) : 1;
    const promos = await scrapeLidlPromo(url, pages);

    res.status(200).json({
      success: true,
      count: promos.length,
      promos,
    });
  } catch (err) {
    console.error('Handler Error:', err);
    res.status(500).json({
      error: (err as Error).message,
    });
  }
}