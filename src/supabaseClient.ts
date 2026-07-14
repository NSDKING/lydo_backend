import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseSecretKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set in the environment');
}

// Admin client — server-side only, bypasses RLS, used for writes
export const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey, {
  auth: { persistSession: false },
});

// Public client — safe for read queries that respect RLS
export const supabasePublic = supabasePublishableKey
  ? createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false } })
  : supabaseAdmin;

// -------------------- USERS --------------------
export async function saveUserData(userId: string, profile: Record<string, any>) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .upsert(
      { id: userId, profile },
      { onConflict: 'id' }
    )
    .select();

  if (error) throw error;
  return data;
}

// -------------------- LIDL PROMOS --------------------
export async function saveLidlPromos(promos: Array<Record<string, any>>) {
  const { data, error } = await supabaseAdmin
    .from('lidl_promos')
    .upsert(promos, { onConflict: 'title,source_url' })
    .select();

  if (error) throw error;
  return data;
}

// -------------------- MENUS --------------------
export async function saveGeneratedMenu(menu: Record<string, any>) {
  const { data, error } = await supabaseAdmin
    .from('menus')
    .insert(menu)
    .select();

  if (error) throw error;
  return data;
}

// -------------------- RECIPES --------------------
export async function saveRecipeAnalysis(recipe: Record<string, any>) {
  const { data, error } = await supabaseAdmin
    .from('recipes')
    .insert(recipe)
    .select();

  if (error) throw error;
  return data;
}

// -------------------- WEEKLY PLANS --------------------
export async function getWeeklyPlan(weekKey: string): Promise<Record<string, any> | null> {
  const { data, error } = await supabasePublic
    .from('weekly_plans')
    .select('plan_text')
    .eq('week_key', weekKey)
    .single();

  if (error || !data?.plan_text) return null;
  try {
    return JSON.parse(data.plan_text) as Record<string, any>;
  } catch {
    return null;
  }
}

export async function saveWeeklyPlan(weekKey: string, userId: string | undefined, plan: Record<string, any>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('weekly_plans')
    .upsert({ week_key: weekKey, user_id: userId ?? null, plan_text: JSON.stringify(plan), created_at: new Date().toISOString() });

  if (error) throw error;
}

// -------------------- GENERATION USAGE (fair-use caps) --------------------
/*
  Required Supabase migration (run once in SQL editor):

  create table if not exists public.generation_usage (
    user_id text not null,
    month_key text not null,
    generate_count integer not null default 0,
    swap_count integer not null default 0,
    updated_at timestamptz default now(),
    primary key (user_id, month_key)
  );
*/

// Generous enough that no normal Pro user notices, tight enough a power user can't
// burn far more than they paid for in Claude spend.
const GENERATE_CAP_PER_MONTH = 30; // full 7-day Sonnet plan generations/regenerations
const SWAP_CAP_PER_MONTH = 200;    // single-meal Haiku swaps

function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export class UsageCapExceededError extends Error {
  constructor(kind: 'generate' | 'swap') {
    super(`__usage_cap__:${kind}`);
  }
}

async function checkAndIncrementUsage(userId: string, kind: 'generate' | 'swap'): Promise<void> {
  const key = monthKey();
  const column = kind === 'generate' ? 'generate_count' : 'swap_count';
  const cap = kind === 'generate' ? GENERATE_CAP_PER_MONTH : SWAP_CAP_PER_MONTH;

  const { data: existing } = await supabaseAdmin
    .from('generation_usage')
    .select(column)
    .eq('user_id', userId)
    .eq('month_key', key)
    .maybeSingle();

  const current = (existing as any)?.[column] ?? 0;
  if (current >= cap) throw new UsageCapExceededError(kind);

  await supabaseAdmin
    .from('generation_usage')
    .upsert({ user_id: userId, month_key: key, [column]: current + 1 }, { onConflict: 'user_id,month_key' });
}

export async function checkGenerateUsage(userId: string): Promise<void> {
  return checkAndIncrementUsage(userId, 'generate');
}

export async function checkSwapUsage(userId: string): Promise<void> {
  return checkAndIncrementUsage(userId, 'swap');
}