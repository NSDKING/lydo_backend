import dotenv from 'dotenv';
import OpenAI from 'openai';
import { chromium } from 'playwright';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a recipe analyst. Given a TikTok recipe video screenshot and page description, extract the recipe details.

Return ONLY valid JSON — no markdown, no prose — matching this exact schema:
{
  "title": "Recipe name",
  "ingredients": ["200g chicken breast", "1 tbsp olive oil"],
  "steps": ["Step 1 description", "Step 2 description"],
  "macros": { "protein_g": 40, "carbs_g": 50, "fat_g": 15, "calories": 490 },
  "prep_time": "20 min",
  "difficulty": "Easy"
}

If you cannot determine a value, make a reasonable estimate. difficulty must be "Easy", "Medium", or "Hard".`;

export async function processTiktokRecipe(tiktokUrl: string) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 390, height: 844 },
    });

    await page.goto(tiktokUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const description = await page
      .$eval('meta[name="description"]', (el) => (el as HTMLMetaElement).content)
      .catch(() => '');

    const pageTitle = await page.title().catch(() => '');

    // Viewport screenshot only (smaller than full-page)
    const screenshotBuffer = await page.screenshot({ fullPage: false });
    const base64Image = screenshotBuffer.toString('base64');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${SYSTEM_PROMPT}\n\nURL: ${tiktokUrl}\nTitle: ${pageTitle}\nDescription: "${description}"`,
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64Image}`, detail: 'low' },
            },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1000,
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const recipe = JSON.parse(raw);

    return { recipe };
  } finally {
    await browser.close();
  }
}

export async function handler(req: any, res: any) {
  try {
    const { tiktokUrl } = req.body;
    if (!tiktokUrl) return res.status(400).json({ error: 'Missing tiktokUrl' });

    const result = await processTiktokRecipe(tiktokUrl);
    return res.status(200).json(result);
  } catch (error) {
    console.error('TikTok analysis failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
}
