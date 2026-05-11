import { chromium } from 'playwright';

const url = 'https://www.lidl.fr/c/manger-boire/s10068374';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1400, height: 900 },
  locale: 'fr-FR',
  extraHTTPHeaders: { 'Accept-Language': 'fr-FR,fr;q=0.9' },
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
});

const page = await context.newPage();
console.log('Loading page...');
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

try {
  const btn = page.locator('#onetrust-accept-btn-handler').first();
  if (await btn.isVisible({ timeout: 2000 })) { await btn.click(); await page.waitForTimeout(1000); }
} catch {}

await page.evaluate(async () => {
  await new Promise<void>((resolve) => {
    let total = 0;
    const timer = setInterval(() => {
      window.scrollBy(0, 600); total += 600;
      if (total >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
    }, 200);
  });
});
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll('.product-grid-box'));

  return cards.slice(0, 5).map(card => {
    // parse the data-gridbox-impression JSON
    let impression: any = {};
    try { impression = JSON.parse(decodeURIComponent(card.getAttribute('data-gridbox-impression') || '{}')); } catch {}

    // get image
    const img = card.querySelector('img') as HTMLImageElement | null;
    const imageUrl = img?.dataset?.src || img?.dataset?.lazySrc || img?.src || null;

    // price text from DOM (to find old price / displayed price)
    const priceEl = card.querySelector('.product-grid-box__price');
    const priceHTML = priceEl?.innerHTML || '';

    // title from DOM
    const titleEl = card.querySelector('.product-grid-box__title');
    const titleText = titleEl?.textContent?.trim() || '';

    // availability
    const availEl = card.querySelector('.product-grid-box__availabilities');
    const availText = availEl?.textContent?.trim() || '';

    return {
      impression,
      titleText,
      imageUrl,
      priceHTML: priceHTML.slice(0, 500),
      availText,
    };
  });
});

info.forEach((item, i) => {
  console.log(`\n=== PRODUCT ${i + 1} ===`);
  console.log('Impression JSON:', JSON.stringify(item.impression, null, 2));
  console.log('Title DOM:', item.titleText);
  console.log('Image URL:', item.imageUrl);
  console.log('Price HTML:', item.priceHTML);
  console.log('Availability:', item.availText);
});

await browser.close();
