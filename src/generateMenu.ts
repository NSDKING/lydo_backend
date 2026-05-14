import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { supabasePublic, getWeeklyPlan, saveWeeklyPlan } from './supabaseClient.js';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a precision nutrition assistant that creates practical meal plans using real supermarket products.

You will receive a list of Lidl supermarket promotions and a user request. Your job is to create a meal plan that:
1. Prioritises discounted products (those with old_price) to save money
2. Meets the user's calorie target and macros
3. Uses realistic portions and cooking methods
4. Names meals clearly (e.g. "Poulet rôti + légumes vapeur")

CRITICAL: Your entire response must be a single valid JSON object — no markdown, no prose, no code fences:

{
  "days": [
    {
      "day": "Monday",
      "total_calories": 2000,
      "protein_g": 130,
      "carbs_g": 200,
      "fat_g": 65,
      "meals": [
        {
          "name": "Meal name",
          "calories": 600,
          "protein_g": 40,
          "carbs_g": 60,
          "fat_g": 15,
          "ingredients": ["200g chicken breast", "150g rice"],
          "steps": ["Season chicken, heat pan on high.", "Cook chicken 6 min each side.", "Boil rice 12 min, drain.", "Plate and serve."],
          "lidl_products_used": ["Filets de poulet Lidl"]
        }
      ]
    }
  ]
}

For steps: 3–5 concise cooking instructions per meal, each under 12 words.`;

export interface MenuRequest {
  userId?: string;
  preferences?: string;
  dietaryRestrictions?: string;
  mealsPerDay?: number;
  days?: number;
  targetCalories?: number;
}

export interface Meal {
  name: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  ingredients: string[];
  steps: string[];
  lidl_products_used: string[];
}

export interface DayPlan {
  day: string;
  total_calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  meals: Meal[];
}

export interface MenuPlan {
  days: DayPlan[];
}

export function getWeekKey(date = new Date()): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const yearStart = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d.getTime() - yearStart.getTime()) / 86400000 - 3 + ((yearStart.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

export async function fetchLidlPromos(): Promise<Array<Record<string, any>>> {
  const { data, error } = await supabasePublic
    .from('lidl_promos')
    .select('title, price, old_price, discount_percent, available')
    .eq('available', true)
    .order('discount_percent', { ascending: false, nullsFirst: false })
    .limit(80);

  if (error) throw new Error(`Failed to fetch Lidl promos: ${error.message}`);
  return data ?? [];
}

export function buildPromosText(promos: Array<Record<string, any>>): string {
  if (!promos.length) return 'No promotions available at this time.';
  const lines = promos.map(p => {
    const discount = p.discount_percent ? ` [${p.discount_percent}% OFF]` : '';
    const wasPrice = p.old_price ? ` (was ${p.old_price}€)` : '';
    return `- ${p.title}: ${p.price}€${wasPrice}${discount}`;
  });
  return `Current Lidl promotions (${promos.length} items, sorted by discount):\n${lines.join('\n')}`;
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`No JSON found in response: ${text.slice(0, 200)}`);
    return JSON.parse(match[0]) as T;
  }
}

// ─── Generate full week plan ────────────────────────────────────────────────

export async function generateMenu(request: MenuRequest): Promise<{ plan: MenuPlan }> {
  const promos = await fetchLidlPromos();
  const promosText = buildPromosText(promos);

  const days = request.days ?? 7;
  const mealsPerDay = request.mealsPerDay ?? 3;
  const targetCalories = request.targetCalories ?? 2000;

  const userRequest = [
    `Generate a ${days}-day meal plan with ${mealsPerDay} meals per day.`,
    `Daily calorie target: ${targetCalories} kcal.`,
    request.preferences ? `Preferences: ${request.preferences}.` : '',
    request.dietaryRestrictions ? `Dietary restrictions: ${request.dietaryRestrictions}.` : '',
  ].filter(Boolean).join(' ');

  const stream = await anthropic.messages.stream({
    model: 'claude-opus-4-7',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } } as any],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: promosText, cache_control: { type: 'ephemeral' } } as any,
        { type: 'text', text: userRequest },
      ],
    }],
  });

  const message = await stream.finalMessage();
  const rawText = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text).join('');

  const plan = parseJson<MenuPlan>(rawText);

  const usage = message.usage as any;
  const cacheParts: string[] = [];
  if (usage.cache_creation_input_tokens) cacheParts.push(`${usage.cache_creation_input_tokens} written`);
  if (usage.cache_read_input_tokens) cacheParts.push(`${usage.cache_read_input_tokens} read`);
  console.log(`Menu generated. Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out` +
    (cacheParts.length ? ` | cache: ${cacheParts.join(', ')}` : ''));

  return { plan };
}

// ─── Swap a single meal ─────────────────────────────────────────────────────

export async function swapSingleMeal(dayPlan: DayPlan, mealIndex: number, preferences?: string): Promise<Meal> {
  const [promos] = await Promise.all([fetchLidlPromos()]);
  const promosText = buildPromosText(promos);

  const mealToReplace = dayPlan.meals[mealIndex];
  const otherMeals = dayPlan.meals
    .filter((_, i) => i !== mealIndex)
    .map(m => `${m.name} (${m.calories} kcal, P:${m.protein_g}g C:${m.carbs_g}g F:${m.fat_g}g)`)
    .join('; ');

  const prefLine = preferences ? `User preferences for replacement: ${preferences}.` : '';

  const prompt = `Day target: ${dayPlan.total_calories} kcal. Other meals already planned: ${otherMeals}.
Replace: "${mealToReplace.name}" (${mealToReplace.calories} kcal).
${prefLine}

${promosText}

Suggest ONE different meal that fits nutritionally. Return JSON only:
{"name":"...","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"ingredients":["..."],"steps":["Step 1.","Step 2.","Step 3."],"lidl_products_used":["..."]}`;

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 900,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
  return parseJson<Meal>(text);
}

// ─── Adapt a TikTok recipe with Lidl products ───────────────────────────────

export async function adaptRecipeWithLidl(title: string, ingredients: string[]): Promise<any> {
  const promos = await fetchLidlPromos();
  const promosText = buildPromosText(promos);

  const prompt = `Recipe: "${title}"
Original ingredients: ${ingredients.join(', ')}

${promosText}

Match each ingredient to the closest available Lidl promotion where possible.
Return JSON only:
{
  "adaptedIngredients": [
    { "original": "500g chicken breast", "lidlProduct": "Filets de poulet Lidl — 4.99€", "note": "Use 2 packs" },
    { "original": "200ml olive oil", "lidlProduct": null, "note": "Not available at Lidl" }
  ]
}`;

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
  return parseJson<any>(text);
}

// ─── Route handlers ──────────────────────────────────────────────────────────

export async function handler(req: any, res: any) {
  try {
    const weekKey = getWeekKey();

    // Always generate fresh (client checked cache before calling this)
    const { plan } = await generateMenu(req.body as MenuRequest);

    // Save to Supabase for future loads
    saveWeeklyPlan(weekKey, plan as any).catch(e =>
      console.warn('Failed to cache weekly plan:', (e as Error).message)
    );

    return res.status(200).json({ plan, weekKey });
  } catch (error) {
    console.error('Menu generation failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
}

export async function getWeekHandler(req: any, res: any) {
  try {
    const { key } = req.params;
    const plan = await getWeeklyPlan(key);
    if (!plan) return res.status(404).json({ error: 'No plan for this week' });
    return res.status(200).json({ plan, weekKey: key });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
}

export async function swapHandler(req: any, res: any) {
  try {
    const { dayPlan, mealIndex, preferences } = req.body;
    if (!dayPlan || mealIndex === undefined) return res.status(400).json({ error: 'Missing dayPlan or mealIndex' });
    const meal = await swapSingleMeal(dayPlan as DayPlan, mealIndex as number, preferences as string | undefined);
    return res.status(200).json({ meal });
  } catch (error) {
    console.error('Swap failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
}

export async function adaptHandler(req: any, res: any) {
  try {
    const { title, ingredients } = req.body;
    if (!title || !ingredients) return res.status(400).json({ error: 'Missing title or ingredients' });
    const result = await adaptRecipeWithLidl(title as string, ingredients as string[]);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Adapt failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
}

export async function foodScanHandler(req: any, res: any) {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'Analyze this food photo. Estimate nutrition for the visible portion. Return JSON only:\n{"name":"...","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"notes":"brief portion note"}' },
        ],
      }],
    });

    const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
    return res.status(200).json(parseJson<any>(text));
  } catch (error) {
    console.error('Food scan failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
}

export async function catalogHandler(req: any, res: any) {
  try {
    const { data, error } = await supabasePublic
      .from('lidl_promos')
      .select('title, price, old_price, discount_percent, image_url')
      .eq('available', true)
      .order('discount_percent', { ascending: false, nullsFirst: false })
      .limit(300);
    if (error) throw error;
    return res.status(200).json({ products: data ?? [] });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
}
