# Inventory Health Dashboard

Production-ready Next.js (App Router) dashboard that analyzes inventory health from an existing API and optionally augments with DeepSeek insights. Deployable to Vercel.

## Overview
- Framework: Next.js (App Router) + TypeScript + Tailwind
- Hosting: Vercel
- Data Source: `https://serverless-twg8.vercel.app`
  - GET `/api/inventorybalance`
  - GET `/api/inventorytransaction`
  - GET `/api/products`
  - GET `/api/warehouses`
- LLM: DeepSeek via OpenAI-compatible API (server-side only)

## Project Structure
- `src/app/dashboard/inventory-health/page.tsx`: Dashboard route (UI + client-side compute, calls internal AI route)
- `src/app/api/ai/explain-inventory-health/route.ts`: Server route to call DeepSeek, never exposes API key
- `src/lib/dataClient.ts`: Robust `fetchJson` with timeout/retries
- `src/lib/schemas.ts`: Zod schemas for data validation
- `src/lib/inventoryHealth.ts`: Deterministic joins and metrics for low stock/overstock
- `src/lib/deepseek.ts`: OpenAI-compatible client + strict JSON parsing

## Deterministic Computation
The dashboard fetches data in parallel from the existing API and validates shapes via Zod. It computes, per (warehouseId, productId):
- `outQty_7`, `outQty_14`, `outQty_30` from ISSUE transactions
- `avgDailyOut` derived from the most recent non-zero window
- `daysLeft = qtyOnHand / avgDailyOut` (or null if non-consumptive)

Rules:
- LOW_STOCK: `qtyOnHand <= safetyStock` OR `qtyOnHand <= reorderPoint` OR `daysLeft < 7`
- OVERSTOCK: `qtyOnHand > safetyStock*3` OR `(outQty_30 == 0 AND qtyOnHand > safetyStock)`

Outputs:
- `lowStock` top 10 (sorted by `daysLeft` asc, null last)
- `overStock` top 10 (sorted by `qtyOnHand` desc)
- Summary: `totalProductsAnalyzed`, `lowStockCount`, `overStockCount`, `worstRisk`

## DeepSeek Insights
Server-only route: `POST /api/ai/explain-inventory-health`
Body: `{ windowDays, warehouseName, lowStockTop, overStockTop, selectedItem }`

The route calls DeepSeek (OpenAI-compatible) with temperature 0.2 and instructs STRICT JSON output:
```
{
  "executiveSummary": string,
  "insights": string[],
  "actions": string[],
  "itemNote": { "why": string, "action": string } | null
}
```
If the LLM fails, the route returns an object with `error` and `null/[]` fields.

## Getting Started
1. Install dependencies
   - `pnpm install` or `npm install` or `yarn`
2. Run locally
   - `pnpm dev` (or `npm run dev`)
3. Open `http://localhost:3000/dashboard/inventory-health`

## Environment Variables (DeepSeek)
Add the following to your Vercel project (or `.env.local` for local run):
```
DEEPSEEK_API_KEY=your_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

Note: Only the server route uses these env vars. The browser never sees the key.

## Deploy to Vercel
1. Push this repo to GitHub/GitLab/Bitbucket
2. Import into Vercel
3. Set environment variables above in Vercel Project Settings
4. Deploy

## Notes
- Dashboard reads data directly from `https://serverless-twg8.vercel.app`.
- No new agent endpoints are created. The only API we add is the AI explain route used purely for summarization.
- Code is TypeScript-first and validated with Zod; failures degrade gracefully with error banners.

# ai-agent-inventory
