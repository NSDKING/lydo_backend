import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { supabasePublic } from './supabaseClient.js';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Stable system prompt — cached across all requests
const SYSTEM_PROMPT = `You are a precision nutrition assistant that creates practical meal plans using real supermarket products.

You will receive a list of Lidl supermarket promotions and a user request. Your job is to create a meal plan that:
1. Prioritises discounted products (those with old_price) to save money
2. Meets the user's calorie target and macros
3. Uses realistic portions and cooking methods
4. Names meals clearly (e.g. "Poulet rôti + légumes vapeur")

CRITICAL: Your entire response must be a single valid JSON object matching this exact schema — no markdown, no prose, no code fences:

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
          "lidl_products_used": ["Filets de poulet Lidl"]
        }
      ]
    }
  ]
}`;

export interface MenuRequest {
  userId: string;
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

export async function generateMenu(request: MenuRequest): Promise<{ plan: MenuPlan }> {
  const [promos] = await Promise.all([fetchLidlPromos()]);
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
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // @ts-ignore — cache_control is supported in 0.95+
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: promosText,
            // @ts-ignore
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: userRequest,
          },
        ],
      },
    ],
  });

  const message = await stream.finalMessage();

  const rawText = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  let plan: MenuPlan;
  try {
    plan = JSON.parse(rawText) as MenuPlan;
  } catch {
    // Try to extract JSON if Claude wrapped it in prose
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Claude did not return valid JSON. Response: ${rawText.slice(0, 300)}`);
    plan = JSON.parse(match[0]) as MenuPlan;
  }

  const usage = message.usage as any;
  const cacheParts: string[] = [];
  if (usage.cache_creation_input_tokens) cacheParts.push(`${usage.cache_creation_input_tokens} written`);
  if (usage.cache_read_input_tokens) cacheParts.push(`${usage.cache_read_input_tokens} read`);
  console.log(`Menu generated. Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out` +
    (cacheParts.length ? ` | cache: ${cacheParts.join(', ')}` : ''));

  return { plan };
}

export async function handler(req: any, res: any) {
  try {
    const result = await generateMenu(req.body as MenuRequest);
    return res.status(200).json(result);
  } catch (error) {
    console.error('Menu generation failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
}
