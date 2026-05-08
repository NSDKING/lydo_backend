import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set in the environment');
}

export const supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
  },
});

export async function saveUserData(userId: string, profile: Record<string, any>) {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ id: userId, profile }, { onConflict: 'id' })
    .select();

  if (error) {
    throw error;
  }

  return true;
}

export async function saveLidlPromos(promos: Array<Record<string, any>>) {
  const { error } = await supabaseAdmin.from('lidl_promos').insert(promos);
  if (error) {
    throw error;
  }
  return promos;
}

export async function saveGeneratedMenu(menu: Record<string, any>) {
  const { data, error } = await supabaseAdmin.from('menus').insert(menu).select();
  if (error) {
    throw error;
  }
  return data;
}

export async function saveRecipeAnalysis(recipe: Record<string, any>) {
  const { data, error } = await supabaseAdmin.from('recipes').insert(recipe).select();
  if (error) {
    throw error;
  }
  return data;
}
