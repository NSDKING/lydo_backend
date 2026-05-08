import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { saveGeneratedMenu } from './supabaseClient.js';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface MenuRequest {
  userId: string;
  preferences?: string;
  dietaryRestrictions?: string;
  mealsPerDay?: number;
  days?: number;
}

export async function generateMenu(request: MenuRequest) {
  const prompt = `Generate a ${request.days ?? 7}-day meal plan for a user with the following preferences: ${request.preferences ?? 'no special preferences'}, dietary restrictions: ${request.dietaryRestrictions ?? 'none'}, and ${request.mealsPerDay ?? 3} meals per day. Provide recipe names, short descriptions, and estimated macros for each meal.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    temperature: 0.8,
    system: 'You are a helpful nutrition assistant that generates meal plans.',
    messages: [{ role: 'user', content: prompt }],
  });

  const output = response.content[0]?.type === 'text' ? response.content[0].text : '';

  const menu = {
    user_id: request.userId,
    preferences: request.preferences,
    dietary_restrictions: request.dietaryRestrictions,
    days: request.days ?? 7,
    meals_per_day: request.mealsPerDay ?? 3,
    plan_text: output,
    created_at: new Date().toISOString(),
  };

  const saved = await saveGeneratedMenu(menu);
  return { output, saved };
}

export async function handler(req: any, res: any) {
  try {
    const body = req.body;
    const result = await generateMenu(body);
    res.status(200).json(result);
  } catch (error) {
    console.error('Menu generation failed', error);
    res.status(500).json({ error: (error as Error).message });
  }
}
