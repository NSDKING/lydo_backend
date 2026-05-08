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
      const distance = 1000;

      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= document.body.scrollHeight + 5000) {
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
    console.log(`Opening ${url}`);

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await page.waitForTimeout(4000);

    await autoScroll(page);

    await page.waitForTimeout(3000);

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

      // ONLY REAL PRODUCT CARDS
      const cards = Array.from(
        document.querySelectorAll(`
          [data-testid="product-card"],
          .ret-o-card,
          .odc-product,
          article[data-testid]
        `)
      );

      console.log('FOUND CARDS:', cards.length);

      for (const card of cards) {
        const fullText = card.textContent?.trim() || '';

        // remove garbage
        if (
          !fullText ||
          fullText.includes('Rendered:') ||
          fullText.length < 15
        ) {
          continue;
        }

        // TITLE
        let title =
          card.querySelector('h1,h2,h3,h4')?.textContent?.trim() ||
          null;

        // fallback title
        if (!title) {
          const possible = Array.from(
            card.querySelectorAll('span,div,p')
          )
            .map((e) => e.textContent?.trim())
            .filter(Boolean)
            .find(
              (t) =>
                t &&
                !t.includes('€') &&
                !t.includes('En supermarché') &&
                !t.includes('%') &&
                t.length > 3 &&
                t.length < 120
            );

          title = possible || null;
        }

        if (!title) continue;

        // clean title
        title = title
          .replace(/Rendered:.*/gi, '')
          .replace(/\s+/g, ' ')
          .trim();

        // skip junk
        if (
          title.includes('<form') ||
          title.includes('Retours sous 30 jours') ||
          title.length > 120
        ) {
          continue;
        }

        // PRICES
        const priceTexts = Array.from(
          card.querySelectorAll('span,div,p')
        )
          .map((e) => e.textContent?.trim())
          .filter(
            (t) =>
              t &&
              t.includes('€')
          );

        if (!priceTexts.length) continue;

        const parsedPrices = priceTexts
          .map((raw) => ({
            raw,
            num: parsePrice(raw),
          }))
          .filter((p) => p.num !== null);

        if (!parsedPrices.length) continue;

        parsedPrices.sort((a, b) => a.num! - b.num!);

        const currentPrice = parsedPrices[0].raw;

        let oldPrice: string | undefined;

        if (parsedPrices.length >= 2) {
          oldPrice =
            parsedPrices[parsedPrices.length - 1].raw;
        }

        // DISCOUNT
        let discount: number | undefined;

        const cur = parsePrice(currentPrice);
        const old = parsePrice(oldPrice || null);

        if (cur && old && old > cur) {
          discount = Math.round(
            ((old - cur) / old) * 100
          );
        }

        // IMAGE
        const image =
          (card.querySelector('img') as HTMLImageElement)
            ?.src || undefined;

        // dedupe
        if (!unique.has(title)) {
          unique.set(title, {
            title,
            price: currentPrice,
            old_price: oldPrice,
            discount_percent: discount,
            image_url: image,
          });
        }
      }

      return Array.from(unique.values());
    });

    console.log(`FOUND PRODUCTS: ${products.length}`);

    return products.map((p: any) => ({
      title: p.title,
      price: p.price,
      old_price: p.old_price,
      discount_percent: p.discount_percent,
      available: true,
      image_url: p.image_url,
      supermarket: 'Lidl',
      source_url: url,
    }));
  } catch (err) {
    console.error('EXTRACTION ERROR:', err);
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

    // anti bot
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    await page.setViewportSize({
      width: 1400,
      height: 4000,
    });

    // KEEP images
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();

      if (['font', 'media'].includes(type)) {
        return route.abort();
      }

      route.continue();
    });

    // DEBUG API
    page.on('response', async (response) => {
      try {
        const url = response.url();

        if (
          url.includes('product') ||
          url.includes('search') ||
          url.includes('grid')
        ) {
          const contentType =
            response.headers()['content-type'] || '';

          if (contentType.includes('application/json')) {
            console.log('API URL:', url);
          }
        }
      } catch {}
    });

    const baseUrl = catalogueUrl.split('?')[0];

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const offset = (pageNum - 1) * 24;

      const pageUrl = `${baseUrl}?offset=${offset}`;

      console.log(`SCRAPING PAGE ${pageNum}`);

      const promos = await extractFromPage(
        page,
        pageUrl
      );

      if (!promos.length) {
        console.log('NO MORE PRODUCTS');
        break;
      }

      allPromos.push(...promos);

      await page.waitForTimeout(2000);
    }
  } finally {
    await browser.close();
  }

  // GLOBAL DEDUPE
  const deduped = Array.from(
    new Map(allPromos.map((p) => [p.title, p])).values()
  );

  console.log(`TOTAL UNIQUE PRODUCTS: ${deduped.length}`);

  if (deduped.length > 0) {
    await saveLidlPromos(deduped);
  }

  return deduped;
}

export async function handler(req: any, res: any) {
  try {
    const url = req.query?.url as string;

    if (!url) {
      return res.status(400).json({
        error: 'Missing url',
      });
    }

    const pages = req.query?.pages
      ? parseInt(req.query.pages, 10)
      : 1;

    const promos = await scrapeLidlPromo(
      url,
      pages
    );

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