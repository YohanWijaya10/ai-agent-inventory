import OpenAI from 'openai';
import { z } from 'zod';

export function getDeepseekClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseURL = process.env.DEEPSEEK_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error('DeepSeek env vars missing (DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL)');
  }
  return new OpenAI({
    apiKey,
    baseURL,
  });
}

export const InsightsSchema = z.object({
  executiveSummary: z.string().nullable(),
  insights: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
  itemNote: z.object({
    why: z.string(),
    action: z.string(),
  }).nullable().default(null),
  answer: z.string().optional().nullable().default(null),
  followUps: z.array(z.string()).optional().default([])
});

export type Insights = z.infer<typeof InsightsSchema>;

export function extractJson(str: string): any {
  // Try to find JSON block in the content
  const match = str.match(/\{[\s\S]*\}$/);
  if (!match) throw new Error('No JSON found in LLM response');
  return JSON.parse(match[0]);
}

export function safeParseInsights(content: string): Insights {
  try {
    const raw = extractJson(content);
    const parsed = InsightsSchema.parse(raw);
    return parsed;
  } catch (e: any) {
    return { executiveSummary: null, insights: [], actions: [], itemNote: null, answer: 'Maaf, saya belum bisa memproses pertanyaan itu dari data yang tersedia.', followUps: [] } as any;
  }
}
