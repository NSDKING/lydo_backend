import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { fetchLidlPromos, buildPromosText } from './generateMenu.js';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a precision nutrition assistant. Generate meal plans using the provided Lidl promotions. Prioritise discounted items. Respond with valid JSON only — no markdown, no prose:

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
          "ingredients": ["200g chicken breast"],
          "lidl_products_used": ["Filets de poulet Lidl"]
        }
      ]
    }
  ]
}`;

const promos = await fetchLidlPromos();
const promosText = buildPromosText(promos);
console.log(`Fetched ${promos.length} Lidl promos\n`);

console.log('Generating 1-day plan...\n');
const stream = await anthropic.messages.stream({
  model: 'claude-opus-4-7',
  max_tokens: 4000,
  thinking: { type: 'adaptive' },
  system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } } as any],
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: promosText, cache_control: { type: 'ephemeral' } } as any,
        { type: 'text', text: 'Generate a 1-day meal plan (3 meals). Daily target: 2000 kcal. High protein preferred.' },
      ],
    },
  ],
});

const message = await stream.finalMessage();
const raw = message.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');

const plan = JSON.parse(raw);
const usage = message.usage as any;
console.log(`Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out${usage.cache_read_input_tokens ? ` (${usage.cache_read_input_tokens} cached)` : ''}\n`);

for (const day of plan.days) {
  console.log(`${day.day}: ${day.total_calories} kcal | P:${day.protein_g}g C:${day.carbs_g}g F:${day.fat_g}g`);
  for (const meal of day.meals) {
    console.log(`  - ${meal.name} (${meal.calories} kcal)`);
    if (meal.lidl_products_used?.length) console.log(`    Lidl: ${meal.lidl_products_used.join(', ')}`);
  }
}
