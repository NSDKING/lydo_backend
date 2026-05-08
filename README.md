# Mako Backend

This backend provides Supabase-backed endpoints for user data, Lidl promo scraping, AI-generated meal menus, and TikTok recipe analysis.

## Endpoints

- `GET /health`
  - Returns service health.
- `POST /user-data`
  - Body: `{ userId: string, profile: object }`
  - Saves user profile data to Supabase `users` table.
- `GET /lidl/promos`
  - Scrapes Lidl promos and saves them to Supabase `lidl_promos` table.
- `POST /menu/generate`
  - Body: `{ userId, preferences?, dietaryRestrictions?, mealsPerDay?, days? }`
  - Generates a menu with OpenAI and saves it to Supabase `menus` table.
- `POST /tiktok/analyze`
  - Body: `{ userId, tiktokUrl }`
  - Screenshots the TikTok page, analyzes the recipe with OpenAI, and saves it to Supabase `recipes` table.

## Environment

Copy `backend/.env.example` to `backend/.env` and set:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `PORT` (optional)
- `LIDL_REGION` (optional)

## Run

```bash
cd backend
npm install
npm run dev
```
