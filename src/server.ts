import './wsPolyfill.js';
 
import express, { Request, Response } from 'express';

import { handler as menuHandler, getWeekHandler, swapHandler, stepsHandler, adaptHandler, catalogHandler, foodScanHandler } from './generateMenu.js';
import { handler as tiktokHandler } from './processTiktok.js';
import { handler as lidlHandler } from './scrapeLidlPromo.js';
import { handler as fullCatalogHandler, scrapeFullCatalog } from './scrapeFullCatalog.js';

import { saveUserData, supabasePublic } from './supabaseClient.js';

const app = express();

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = '0.0.0.0';

app.get('/', (_req, res) => {
  res.status(200).send('Mako Backend Online');
});


app.get('/health', (_req, res) => {
  res.status(200).send('OK');
});

app.use(express.json({ limit: '10mb' }));

app.post('/user-data', async (req: Request, res: Response) => {
  try {
    const { userId, profile } = req.body;

    if (!userId || !profile) {
      return res.status(400).json({
        error: 'Missing userId or profile payload'
      });
    }

    await saveUserData(userId, profile);

    return res.status(200).json({
      success: true
    });
  } catch (error) {
    console.error('User data save failed:', error);

    return res.status(500).json({
      error: (error as Error).message
    });
  }
});

app.get('/lidl/promos', lidlHandler);
app.get('/lidl/catalog', catalogHandler);
app.post('/lidl/scrape-catalog', fullCatalogHandler);

app.get('/menu/week/:key', getWeekHandler);
app.post('/menu/generate', menuHandler);
app.post('/menu/swap', swapHandler);
app.post('/meal/steps', stepsHandler);
app.post('/recipe/adapt', adaptHandler);

app.post('/food/scan', foodScanHandler);

app.post('/tiktok/analyze', tiktokHandler);

const server = app.listen(PORT, HOST, () => {
  console.log(`
🚀 Mako Backend Initialized
---------------------------------
Local:   http://localhost:${PORT}
Network: http://${HOST}:${PORT}
Health:  /health
---------------------------------
`);
});

// ─── Auto-scrape Lidl catalog ────────────────────────────────────────────────
// Lidl France refreshes promos every Thursday. We check DB staleness on startup
// and every 6 hours — if data is older than 3 days, trigger a full catalog scrape.

async function maybeAutoScrape() {
  try {
    const { data } = await supabasePublic
      .from('lidl_promos')
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data?.updated_at) {
      console.log('[auto-scrape] No Lidl data found — running initial scrape');
      scrapeFullCatalog().catch(e => console.error('[auto-scrape] failed:', e.message));
      return;
    }

    const ageMs = Date.now() - new Date(data.updated_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    console.log(`[auto-scrape] Lidl data age: ${ageDays.toFixed(1)} days`);

    if (ageDays >= 3) {
      console.log('[auto-scrape] Stale — triggering catalog scrape');
      scrapeFullCatalog().catch(e => console.error('[auto-scrape] failed:', e.message));
    }
  } catch (e) {
    console.error('[auto-scrape] check failed:', (e as Error).message);
  }
}

// Run on startup (after a short delay so the server is ready) + every 6 hours
setTimeout(maybeAutoScrape, 10_000);
setInterval(maybeAutoScrape, 6 * 60 * 60 * 1000);

process.on('SIGTERM', () => {
  console.log('SIGTERM received');

  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});