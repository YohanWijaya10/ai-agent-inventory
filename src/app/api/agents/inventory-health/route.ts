import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDeepseekClient, safeParseInsights } from '@/lib/deepseek';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ChatMsgSchema = z.object({ role: z.enum(['user','assistant']), content: z.string() });

const BodySchema = z.object({
  windowDays: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  warehouseName: z.string().nullable().optional(),
  lowStockTop: z.array(z.any()).default([]),
  overStockTop: z.array(z.any()).default([]),
  selectedItem: z.any().nullable().optional(),
  question: z.string().optional().nullable(),
  chatHistory: z.array(ChatMsgSchema).max(10).optional()
});

function needsSelectedItem(q: string | null | undefined): boolean {
  if (!q) return false;
  const s = q.toLowerCase();
  return /(item ini|sku ini|ini gimana|kenapa.*item|berapa.*hari|telat|delay|terlambat)/.test(s);
}

const OUTPUT_JSON_INSTRUCTIONS = (hasQuestion: boolean) => `
Anda adalah asisten keputusan operasional (Bahasa Indonesia). Jawab singkat, spesifik, dan berbasis data yang diberikan saja.

JANGAN mengarang angka. Jika menyebut angka, gunakan persis yang ada di input. Jangan sebut nama field teknis (qtyOnHand/safetyStock/reorderPoint). Gunakan istilah: "stok saat ini", "stok aman", "batas pesan ulang", "sisa hari stok".

Keluaran harus STRICT JSON saja, tanpa komentar atau Markdown.
Skema yang harus dipenuhi:
${hasQuestion ? '{ "executiveSummary": string|null, "insights": string[], "actions": string[], "itemNote": {"why": string, "action": string}|null, "answer": string, "followUps": string[] }' : '{ "executiveSummary": string|null, "insights": string[], "actions": string[], "itemNote": {"why": string, "action": string}|null }'}
`;

function slimItem(item: any) {
  if (!item || typeof item !== 'object') return null;
  return {
    sku: item.sku,
    name: item.name,
    qtyOnHand: item.qtyOnHand,
    safetyStock: item.safetyStock,
    reorderPoint: item.reorderPoint,
    outQty_7: item.outQty_7,
    outQty_14: item.outQty_14,
    outQty_30: item.outQty_30,
    avgDailyOut: item.avgDailyOut,
    daysLeft: item.daysLeft,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid body', executiveSummary: null, insights: [], actions: [], itemNote: null, answer: 'Permintaan tidak valid.', followUps: [] }, { status: 400 });
    }
    const { windowDays, warehouseName, lowStockTop, overStockTop, selectedItem, question, chatHistory } = parsed.data;

    // Guard: if question requires selected item but none provided
    if (needsSelectedItem(question) && !selectedItem) {
      return NextResponse.json({
        executiveSummary: null,
        insights: [],
        actions: [],
        itemNote: null,
        answer: 'Pilih item dulu supaya saya bisa jawab lebih spesifik.',
        followUps: ['Klik salah satu SKU di tabel.']
      });
    }

    let client;
    try { client = getDeepseekClient(); } catch (e: any) {
      return NextResponse.json({ error: e.message, executiveSummary: null, insights: [], actions: [], itemNote: null, answer: 'Layanan AI tidak tersedia.', followUps: [] }, { status: 200 });
    }

    const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

    const lowSlim = Array.isArray(lowStockTop) ? lowStockTop.map(slimItem).filter(Boolean) : [];
    const overSlim = Array.isArray(overStockTop) ? overStockTop.map(slimItem).filter(Boolean) : [];
    const selectedSlim = selectedItem ? slimItem(selectedItem) : null;

    const system = OUTPUT_JSON_INSTRUCTIONS(!!(question && question.trim()));

    const chatIntro = (chatHistory || []).map((m) => ({ role: m.role, content: m.content })).slice(-10);

    const user = `Konteks dashboard: windowDays=${windowDays}, warehouse=${warehouseName ?? 'All'}

Low Stock Top (maks 10):
${JSON.stringify(lowSlim, null, 2)}

Overstock Top (maks 10):
${JSON.stringify(overSlim, null, 2)}

Item Terpilih (opsional):
${JSON.stringify(selectedSlim, null, 2)}

Pertanyaan pengguna (opsional):
${question ?? ''}

Instruksi:
- Jawab dalam Bahasa Indonesia, 2-5 kalimat, to-the-point.
- Gunakan hanya angka yang ada di konteks.
- Jika pertanyaan menyebut "item ini"/"SKU ini" tapi item terpilih null, jawab: "Pilih item dulu supaya saya bisa jawab lebih spesifik." dan beri 1 follow up: "Klik salah satu SKU di tabel." ; dalam kasus ini jangan membuat angka tambahan.
- Jika pertanyaan tentang keterlambatan pemasok N hari, hanya bandingkan dengan "sisa hari stok" dari item terpilih; jangan hitung angka baru.
- Hindari penyebutan nama field teknis; gunakan istilah bisnis yang natural.
`;

    const messages: any[] = [
      { role: 'system', content: system },
      ...chatIntro,
      { role: 'user', content: user },
    ];

    const chat = await client.chat.completions.create({
      model,
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' as any },
    } as any);

    const content = chat.choices?.[0]?.message?.content ?? '';
    const parsedInsights = safeParseInsights(content);
    // Ensure keys exist even if model omits when no question
    if (!('answer' in parsedInsights)) (parsedInsights as any).answer = question ? 'Maaf, saya belum bisa memproses pertanyaan itu dari data yang tersedia.' : null;
    if (!('followUps' in parsedInsights)) (parsedInsights as any).followUps = [];

    return NextResponse.json(parsedInsights, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Server error', executiveSummary: null, insights: [], actions: [], itemNote: null, answer: 'Maaf, terjadi kesalahan di server.', followUps: [] }, { status: 200 });
  }
}

