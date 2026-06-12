import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Extract TikTok metadata via plain HTTP (no browser needed) ───────────────

// TikTok serves og: meta tags in the raw HTML for SEO — no JS rendering required.
// Short links (vm.tiktok.com) are followed via fetch's redirect handling.
async function fetchTiktokMeta(url: string): Promise<{ title: string; description: string }> {
  const MOBILE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  const res = await fetch(url, {
    headers: {
      'User-Agent': MOBILE_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`TikTok fetch failed: HTTP ${res.status}`);
  const html = await res.text();

  const ogTag = (prop: string) => {
    // Matches both property= and name= variants, single or double quotes
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
      'i',
    );
    const m = html.match(re) ??
      html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
    return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : '';
  };

  const title = ogTag('og:title') || ogTag('twitter:title') || res.url;
  const description = ogTag('og:description') || ogTag('twitter:description') || ogTag('description') || title;

  return { title, description };
}

// ─── Parse recipe from text with Claude ──────────────────────────────────────

const USER_PROMPT = (title: string, description: string) =>
  `Extract the recipe from this TikTok video and return ONLY a JSON object with these exact fields:
{
  "title": "Recipe name",
  "ingredients": ["200g chicken breast", "1 tbsp olive oil"],
  "steps": ["Step 1", "Step 2"],
  "macros": { "protein_g": 40, "carbs_g": 50, "fat_g": 15, "calories": 490 },
  "prep_time": "20 min",
  "difficulty": "Easy"
}

Rules:
- If ingredients or steps are missing, infer reasonable ones from the recipe name.
- Estimate macros if not provided. difficulty = "Easy", "Medium", or "Hard".
- Never refuse — always return a complete JSON object.

Title: ${title}
Description: ${description}`;

async function extractRecipeWithClaude(title: string, description: string) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: USER_PROMPT(title, description) },
      { role: 'assistant', content: '{' }, // prefill forces JSON output
    ],
  });

  // Response continues from the prefilled '{'
  const rest = (msg.content[0] as { type: string; text: string }).text ?? '';
  const raw = '{' + rest;

  try {
    return JSON.parse(raw);
  } catch {
    // Last resort: extract first {...} block from the text
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Claude did not return valid JSON');
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function processTiktokRecipe(tiktokUrl: string) {
  const { title, description } = await fetchTiktokMeta(tiktokUrl);
  const recipe = await extractRecipeWithClaude(title, description);
  return { recipe };
}

export async function handler(req: any, res: any) {
  try {
    const { tiktokUrl, title, description } = req.body;

    let result: { recipe: any };

    if (title && description) {
      // Client already fetched and parsed the page metadata — go straight to Claude
      const recipe = await extractRecipeWithClaude(title, description);
      result = { recipe };
    } else if (tiktokUrl) {
      // Legacy path: backend fetches the URL itself (may fail on Railway)
      result = await processTiktokRecipe(tiktokUrl);
    } else {
      return res.status(400).json({ error: 'Provide either {title, description} or {tiktokUrl}' });
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error('TikTok analysis failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
}
