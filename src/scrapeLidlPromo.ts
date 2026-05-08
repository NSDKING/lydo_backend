import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import { saveLidlPromos } from './supabaseClient.js';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface LidlPromo {
  title: string;
  price: string;
  validFrom?: string;
  validTo?: string;
  imageUrl?: string;
  supermarket: 'Lidl';
  sourceUrl: string;
}

async function extractPromosFromScreenshot(imageBase64: string): Promise<{ title: string; price: string }[]> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
        },
        {
          type: 'text',
          text: 'Extract all product promotions visible on this Lidl catalogue page. Return a JSON array only, no explanation: [{"title": "product name", "price": "price with currency"}]. If no products are visible return [].',
        },
      ],
    }],
  });

  const text = response.content[0]?.type === 'text' ? response.content[0].text : '[]';
  try {
    const match = text.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch {
    return [];
  }
}

function buildPageUrl(catalogueUrl: string, pageNum: number): string {
  // Replace existing page number or append it
  // URL pattern: .../view/flyer/page/N?...
  const withoutPage = catalogueUrl.replace(/\/page\/\d+/, '');
  const queryIndex = withoutPage.indexOf('?');
  const base = queryIndex !== -1 ? withoutPage.slice(0, queryIndex) : withoutPage;
  const query = queryIndex !== -1 ? withoutPage.slice(queryIndex) : '';
  return `${base}/page/${pageNum}${query}`;
}

export async function scrapeLidlPromo(catalogueUrl: string, maxPages = 5): Promise<LidlPromo[]> {
  const browser = await chromium.launch({ headless: true });
  const allPromos: LidlPromo[] = [];

  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const pageUrl = buildPageUrl(catalogueUrl, pageNum);

      const response = await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => null);
      if (!response || response.status() === 404) break;

      await page.waitForTimeout(1500);

      const screenshotBuffer = await page.screenshot({ fullPage: false });
      const imageBase64 = screenshotBuffer.toString('base64');

      const promos = await extractPromosFromScreenshot(imageBase64);

      for (const promo of promos) {
        allPromos.push({ ...promo, supermarket: 'Lidl', sourceUrl: pageUrl });
      }

      console.log(`Page ${pageNum}: found ${promos.length} promos`);
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
  const catalogueUrl = req.query?.url as string;
  if (!catalogueUrl) {
    return res.status(400).json({ error: 'Missing ?url= query parameter. Pass the Lidl catalogue URL.' });
  }

  try {
    const maxPages = req.query?.pages ? parseInt(req.query.pages as string, 10) : 5;
    const promos = await scrapeLidlPromo(catalogueUrl, maxPages);
    res.status(200).json({ count: promos.length, promos });
  } catch (error) {
    console.error('Lidl scrape failed', error);
    res.status(500).json({ error: (error as Error).message });
  }
}
