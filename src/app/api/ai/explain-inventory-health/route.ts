import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDeepseekClient, safeParseInsights } from "@/lib/deepseek";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  windowDays: z.union([z.literal(7), z.literal(14), z.literal(30)]),
  warehouseName: z.string().nullable().optional(),
  lowStockTop: z.array(z.any()).default([]),
  overStockTop: z.array(z.any()).default([]),
  selectedItem: z.any().nullable().optional(),
});

const OUTPUT_JSON_INSTRUCTIONS = `
Anda adalah AI Inventory Analyst untuk pemilik bisnis dan tim operasional.
Gunakan Bahasa Indonesia yang sederhana, langsung, dan mudah dipahami.

Aturan bahasa (WAJIB):
- Jangan menyebut nama field teknis seperti qtyOnHand, safetyStock, reorderPoint secara eksplisit.
- Terjemahkan field ke bahasa natural:
  • qtyOnHand → "stok saat ini"
  • safetyStock → "stok aman"
  • reorderPoint → "batas pesan ulang"
  • daysLeft → "sisa hari stok"
- Angka tetap WAJIB disebutkan persis, tapi dengan konteks bahasa manusia.
- Contoh benar:
  "stok saat ini sudah 0",
  "stok aman berada di 600 unit",
  "sisa stok hanya cukup untuk 7 hari".
- Contoh salah:
  "qtyOnHand=0",
  "di bawah safetyStock=600".


Keluaran WAJIB:
- HANYA JSON ketat dengan key:
  executiveSummary (string),
  insights (string[]),
  actions (string[]),
  itemNote ({ why: string, action: string } | null)
- Jangan menambahkan teks lain di luar JSON.

Aturan data:
- Jangan mengarang angka atau menghitung angka baru.
- Jika menyebut angka, gunakan persis dari input.
- Gunakan hanya field:
  sku, name, qtyOnHand, safetyStock, reorderPoint,
  outQty_7, outQty_14, outQty_30, avgDailyOut, daysLeft.

Cara berpikir (penting):
- lowStockTop dan overStockTop sudah ditentukan oleh sistem.
- Tugas Anda adalah MENJELASKAN artinya, bukan mempertanyakan labelnya.

Gaya penulisan:
- Fokus ke MAKNA, bukan mengulang semua angka.
- Satu bullet = satu pesan utama.
- Gunakan bahasa operasional seperti:
  "stok habis total", "risiko stockout", "stok berlebih", "perlu tindakan".

Struktur:
1) executiveSummary
   - Maks 3–4 kalimat.
   - Jawab: apa masalah utamanya & item mana paling kritis.

2) insights
   - 3–5 bullet pendek.
   - Bahas:
     • pola konsumsi (cepat / stabil / rendah)
     • kondisi stok vs safetyStock
     • urgensi berdasarkan daysLeft
   - Hindari pengulangan angka yang sama.

3) actions
   - Langkah konkret yang bisa dilakukan tim.
   - Sebutkan SKU yang terdampak.
   - Jangan terlalu teknis, fokus ke keputusan.

4) selectedItem (jika ada):
   - why: kenapa item ini bermasalah (1–2 kalimat).
   - action: apa yang harus dilakukan (1–2 kalimat).
   - Jika tidak ada, itemNote = null.
`;

function slimItem(item: any) {
  if (!item || typeof item !== "object") return null;
  const pick = {
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
  } as const;
  return pick;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid body",
          executiveSummary: null,
          insights: [],
          actions: [],
          itemNote: null,
        },
        { status: 400 }
      );
    }
    const {
      windowDays,
      warehouseName,
      lowStockTop,
      overStockTop,
      selectedItem,
    } = parsed.data;

    let client;
    try {
      client = getDeepseekClient();
    } catch (e: any) {
      return NextResponse.json(
        {
          error: e.message,
          executiveSummary: null,
          insights: [],
          actions: [],
          itemNote: null,
        },
        { status: 200 }
      );
    }

    const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

    const system = OUTPUT_JSON_INSTRUCTIONS;
    const lowSlim = Array.isArray(lowStockTop)
      ? lowStockTop.map(slimItem).filter(Boolean)
      : [];
    const overSlim = Array.isArray(overStockTop)
      ? overStockTop.map(slimItem).filter(Boolean)
      : [];
    const selectedSlim = selectedItem ? slimItem(selectedItem) : null;
    const user = `Konteks: windowDays=${windowDays}, warehouse=${
      warehouseName ?? "All"
    }\n\nTop LowStock (maks 10):\n${JSON.stringify(
      lowSlim,
      null,
      2
    )}\n\nTop OverStock (maks 10):\n${JSON.stringify(
      overSlim,
      null,
      2
    )}\n\nItem Terpilih (opsional):\n${JSON.stringify(
      selectedSlim,
      null,
      2
    )}\n\nInstruksi: Analisis pola dan risiko berdasarkan field yang diberikan saja. Keluarkan JSON ketat.`;

    const chat = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" as any },
    } as any);

    const content = chat.choices?.[0]?.message?.content ?? "";
    const parsedInsights = safeParseInsights(content);

    return NextResponse.json(parsedInsights, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      {
        error: e.message || "Server error",
        executiveSummary: null,
        insights: [],
        actions: [],
        itemNote: null,
      },
      { status: 200 }
    );
  }
}
