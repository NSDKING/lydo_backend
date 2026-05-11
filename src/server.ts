import './wsPolyfill.js';
 
import express, { Request, Response } from 'express';

import { handler as menuHandler, getWeekHandler, swapHandler, adaptHandler } from './generateMenu.js';
import { handler as tiktokHandler } from './processTiktok.js';
import { handler as lidlHandler } from './scrapeLidlPromo.js';

import { saveUserData } from './supabaseClient.js';

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

app.get('/menu/week/:key', getWeekHandler);
app.post('/menu/generate', menuHandler);
app.post('/menu/swap', swapHandler);
app.post('/recipe/adapt', adaptHandler);

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

process.on('SIGTERM', () => {
  console.log('SIGTERM received');

  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});