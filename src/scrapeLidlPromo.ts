import dotenv from 'dotenv';
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
 * Safe fetch wrapper with retry
 */
async function safeFetch(url: string, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          referer: 'https://www.lidl.fr/',
        },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      return await res.json();
    } catch (err) {
      console.warn(`Fetch attempt ${i + 1} failed`, err);
      if (i === retries - 1) throw err;
    }
  }
}

/**
 * Try multiple possible API shapes (Lidl changes often)
 */
async function fetchFromAPI(categoryId: string, offset: number): Promise<LidlPromo[]> {
  const limit = 24;

  const urls = [
    `https://www.lidl.fr/p/api/gridboxes/FR/fr/filter/${categoryId}?offset=${offset}&limit=${limit}`,
    `https://www.lidl.fr/p/api/psr/FR/fr/search?category=${categoryId}&offset=${offset}&limit=${limit}`,
  ];

  let data: any = null;

  for (const url of urls) {
    try {
      data = await safeFetch(url);
      if (data) break;
    } catch {
      continue;
    }
  }

  if (!data) return [];

  const items =
    data.items ||
    data.products ||
    data.gridBoxes ||
    [];

  return items.map((item: any) => {
    const price =
      item.price?.price ??
      item.price?.current ??
      item.price ??
      'N/A';

    const currency =
      item.price?.currency ?? '€';

    return {
      title: item.fullTitle || item.title || 'Unknown',
      price: `${price} ${currency}`,
      available: item.availability?.available ?? item.available ?? null,
      imageUrl: item.image || item.picture,
      supermarket: 'Lidl',
      sourceUrl: item.canonicalUrl
        ? `https://www.lidl.fr${item.canonicalUrl}`
        : '',
    };
  });
}

/**
 * MAIN SCRAPER
 */
export async function scrapeLidlPromo(catalogueUrl: string, maxPages = 5) {
  const match = catalogueUrl.match(/(s\d+)/);
  if (!match) throw new Error('Could not extract category ID');

  const categoryId = match[1];

  const allPromos: LidlPromo[] = [];
  const limit = 24;

  console.log(`Scraping category ${categoryId}`);

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;

    console.log(`Fetching offset ${offset}`);

    const promos = await fetchFromAPI(categoryId, offset);

    if (!promos.length) {
      console.log('No more products → stopping');
      break;
    }

    allPromos.push(...promos);
  }

  if (allPromos.length) {
    await saveLidlPromos(allPromos);
  }

  return allPromos;
}

/**
 * API handler
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
    res.status(500).json({ error: (err as Error).message });
  }
}