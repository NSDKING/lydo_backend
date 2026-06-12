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

const SYSTEM_PROMPT = `You are a recipe extraction assistant. Given the title and description of a TikTok recipe video, extract the recipe details.

Return ONLY valid JSON — no markdown, no prose — matching this exact schema:
{
  "title": "Recipe name",
  "ingredients": ["200g chicken breast", "1 tbsp olive oil"],
  "steps": ["Step 1 description", "Step 2 description"],
  "macros": { "protein_g": 40, "carbs_g": 50, "fat_g": 15, "calories": 490 },
  "prep_time": "20 min",
  "difficulty": "Easy"
}

Rules:
- If ingredients or steps are not in the text, infer them from the recipe name.
- If macros cannot be calculated exactly, make a reasonable nutritional estimate.
- difficulty must be "Easy", "Medium", or "Hard".
- Always return all fields — never omit any.`;

async function extractRecipeWithClaude(title: string, description: string) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `${SYSTEM_PROMPT}\n\nTitle: ${title}\nDescription: ${description}`,
      },
    ],
  });

  const raw = (msg.content[0] as { type: string; text: string }).text ?? '{}';
  // Strip any accidental markdown fences
  const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(cleaned);
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
