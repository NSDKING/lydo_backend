import dotenv from 'dotenv';
import OpenAI from 'openai';
import { chromium } from 'playwright';
import { saveRecipeAnalysis } from './supabaseClient.js';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface TiktokAnalysisRequest {
  userId: string;
  tiktokUrl: string;
}

export async function processTiktokRecipe(request: TiktokAnalysisRequest) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await page.goto(request.tiktokUrl, { waitUntil: 'networkidle' });

  const screenshotBuffer = await page.screenshot({ fullPage: true });
  // Explicitly typing 'el' as Element to satisfy strict mode
  const description = await page.$eval('meta[name="description"]', (el: Element) => (el as HTMLMetaElement).content).catch(() => '');
  const analysisPrompt = `You are a nutrition-savvy recipe analyst. The TikTok recipe URL is ${request.tiktokUrl}. The page description is: "${description}". Provide:
1. The recipe title
2. Ingredients list
3. Estimated macros per serving (protein, carbs, fat, kcal)
4. A short recipe summary
Use only the data available.`;

  const response = await openai.responses.create({
    model: 'gpt-4o',
    input: analysisPrompt,
    temperature: 0.7,
    max_output_tokens: 800,
  });

  await browser.close();

  const output = response.output_text ?? '';
  const recipe = {
    user_id: request.userId,
    source_url: request.tiktokUrl,
    analysis_text: output,
    screenshot: screenshotBuffer.toString('base64'),
    created_at: new Date().toISOString(),
  };

  const saved = await saveRecipeAnalysis(recipe);
  return { output, saved };
}

export async function handler(req: any, res: any) {
  try {
    const body = req.body;
    const result = await processTiktokRecipe(body);
    res.status(200).json(result);
  } catch (error) {
    console.error('TikTok analysis failed', error);
    res.status(500).json({ error: (error as Error).message });
  }
}
