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
    .select('plan_json')
    .eq('week_key', weekKey)
    .single();

  if (error || !data) return null;
  return data.plan_json as Record<string, any>;
}

export async function saveWeeklyPlan(weekKey: string, plan: Record<string, any>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('weekly_plans')
    .upsert({ week_key: weekKey, plan_json: plan, created_at: new Date().toISOString() });

  if (error) throw error;
}