import dotenv from 'dotenv';
import { chromium, Page } from 'playwright';
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

function parsePrice(str: string | null): number | null {
  if (!str) return null;

  const cleaned = str
    .replace(',', '.')
    .replace(/[^\d.]/g, '');

  const num = parseFloat(cleaned);

  return isNaN(num) ? null : num;
}

async function autoScroll(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance = 800;

      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= document.body.scrollHeight + 3000) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });
}

async function extractFromPage(
  page: Page,
  url: string
): Promise<LidlPromo[]> {
  try {
    console.log(`Opening: ${url}`);

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // wait initial render
    await page.waitForTimeout(3000);

    // trigger lazy loading
    await autoScroll(page);

    await page.waitForTimeout(2000);

    const products = await page.evaluate(() => {
      const parsePrice = (str: string | null) => {
        if (!str) return null;

        const cleaned = str
          .replace(',', '.')
          .replace(/[^\d.]/g, '');

        const num = parseFloat(cleaned);

        return isNaN(num) ? null : num;
      };

      const unique = new Map();

      // VERY broad selectors
      const cards = Array.from(
        document.querySelectorAll(`
          article,
          li,
          div[data-testid],
          div[class*="product"],
          div[class*="Product"],
          div[class*="item"],
          div[class*="Item"],
          div[class*="card"],
          div[class*="Card"]
        `)
      );

      for (const card of cards) {
        const text = card.textContent?.trim();

        // ignore useless nodes
        if (!text || text.length < 20) continue;

        // TITLE
        let title =
          card.querySelector('h1,h2,h3,h4,strong')?.textContent?.trim() ||
          null;

        if (!title) {
          const lines = text
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);

          title = lines[0] || null;
        }

        if (!title || title.length < 2) continue;

        // ALL possible price texts
        const priceCandidates = Array.from(
          card.querySelectorAll(`
            [class*="price"],
            [class*="Price"],
            span,
            div
          `)
        )
          .map((el) => el.textContent?.trim())
          .filter(Boolean);

        const extractedPrices = priceCandidates
          .map((p) => ({
            raw: p,
            num: parsePrice(p || ''),
          }))
          .filter((p) => p.num !== null);

        if (extractedPrices.length === 0) continue;

        // sort ascending
        extractedPrices.sort((a, b) => a.num! - b.num!);

        const currentPrice = extractedPrices[0].raw || null;

        let oldPrice: string | null = null;

        if (extractedPrices.length >= 2) {
          oldPrice =
            extractedPrices[extractedPrices.length - 1].raw || null;
        }

        // IMAGE
        const image =
          (card.querySelector('img') as HTMLImageElement)?.src ||
          (card.querySelector('img') as HTMLImageElement)?.getAttribute(
            'src'
          ) ||
          null;

        const cur = parsePrice(currentPrice);
        const old = parsePrice(oldPrice);

        let discount = 0;

        if (cur && old && old > cur) {
          discount = Math.round(((old - cur) / old) * 100);
        }

        // deduplicate
        if (!unique.has(title)) {
          unique.set(title, {
            title,
            price: currentPrice,
            old_price: oldPrice,
            discount_percent: discount || null,
            image_url: image,
          });
        }
      }

      return Array.from(unique.values());
    });

    console.log(`Found ${products.length} products`);

    return products.map((p: any) => ({
      title: p.title,
      price: p.price,
      old_price: p.old_price || undefined,
      discount_percent: p.discount_percent || undefined,
      available: true,
      image_url: p.image_url || undefined,
      supermarket: 'Lidl',
      source_url: url,
    }));
  } catch (err) {
    console.error('Extraction error:', err);
    return [];
  }
}

export async function scrapeLidlPromo(
  catalogueUrl: string,
  maxPages = 5
) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const allPromos: LidlPromo[] = [];

  try {
    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    // anti-bot
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    // desktop viewport
    await page.setViewportSize({
      width: 1400,
      height: 4000,
    });

    // DO NOT block images
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();

      if (['font', 'media'].includes(type)) {
        return route.abort();
      }

      route.continue();
    });

    // inspect hidden APIs
    page.on('response', async (response) => {
      try {
        const responseUrl = response.url();

        if (
          responseUrl.includes('product') ||
          responseUrl.includes('grid') ||
          responseUrl.includes('search')
        ) {
          const contentType =
            response.headers()['content-type'] || '';

          if (contentType.includes('application/json')) {
            const json = await response.json();

            console.log(
              'API RESPONSE:',
              JSON.stringify(json).slice(0, 1000)
            );
          }
        }
      } catch {}
    });

    const baseUrl = catalogueUrl.split('?')[0];

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const offset = (pageNum - 1) * 24;

      const pageUrl = `${baseUrl}?offset=${offset}`;

      console.log(`Scraping page ${pageNum}: ${pageUrl}`);

      const promos = await extractFromPage(page, pageUrl);

      if (!promos.length) {
        console.log('No more products found');
        break;
      }

      allPromos.push(...promos);

      await page.waitForTimeout(1500);
    }
  } finally {
    await browser.close();
  }

  // global dedupe
  const deduped = Array.from(
    new Map(allPromos.map((p) => [p.title, p])).values()
  );

  console.log(`Total unique products: ${deduped.length}`);

  if (deduped.length > 0) {
    await saveLidlPromos(deduped);
  }

  return deduped;
}

export async function handler(req: any, res: any) {
  const url = req.query?.url as string;

  if (!url) {
    return res.status(400).json({
      error: 'Missing url',
    });
  }

  try {
    const pages = req.query?.pages
      ? parseInt(req.query.pages, 10)
      : 1;

    const promos = await scrapeLidlPromo(url, pages);

    return res.status(200).json({
      count: promos.length,
      promos,
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: (err as Error).message,
    });
  }
}