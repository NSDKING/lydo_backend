import { scrapeLidlPromo } from './scrapeLidlPromo.js';

const url = process.argv[2] ?? 'https://www.lidl.fr/c/manger-boire/s10068374';
const pages = parseInt(process.argv[3] ?? '1', 10);

console.log(`\nTesting scraper: ${url} (${pages} page(s))\n`);

const results = await scrapeLidlPromo(url, pages);

console.log('\n--- RESULTS ---');
console.log(`Total: ${results.length} products`);
results.slice(0, 15).forEach((p, i) => {
  console.log(`\n[${i + 1}] ${p.title}`);
  console.log(`    Price: ${p.price}${p.old_price ? ` (was ${p.old_price})` : ''}${p.discount_percent ? ` -${p.discount_percent}%` : ''}`);
  console.log(`    Avail: ${p.available}`);
  if (p.image_url) console.log(`    Image: ${p.image_url.slice(0, 80)}`);
});
if (results.length > 15) console.log(`\n... and ${results.length - 15} more`);
