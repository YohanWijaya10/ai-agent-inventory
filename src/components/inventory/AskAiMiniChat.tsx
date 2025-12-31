"use client";

import { useMemo, useRef, useState } from 'react';

type SlimItem = {
  sku: string;
  name: string;
  qtyOnHand: number;
  safetyStock: number;
  reorderPoint: number;
  outQty_7: number;
  outQty_14: number;
  outQty_30: number;
  avgDailyOut: number;
  daysLeft: number | null;
};

type Message = { role: 'user' | 'assistant'; content: string; ts: number };

export function detectDelayDay(input: string): number | null {
  const s = input.toLowerCase();
  const m = s.match(/(?:telat|delay|terlambat)\s*(\d{1,2})\s*hari/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 30) return n;
  }
  return null;
}

function statusOf(item: SlimItem) {
  if (item.qtyOnHand === 0) return 'STOCKOUT';
  if (item.qtyOnHand > 0 && item.qtyOnHand < (item.safetyStock ?? 0)) return 'LOW_BUFFER';
  return 'OVERSTOCK';
}

export default function AskAiMiniChat(props: {
  windowDays: 7 | 14 | 30;
  warehouseName: string | null;
  lowStockTop: SlimItem[];
  overStockTop: SlimItem[];
  selectedItem: SlimItem | null;
  onPickSku?: (sku: string) => void;
}) {
  const { windowDays, warehouseName, lowStockTop, overStockTop, selectedItem, onPickSku } = props;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const hasStockout = useMemo(() => lowStockTop.some((i) => statusOf(i) === 'STOCKOUT'), [lowStockTop]);

  async function send(question: string) {
    if (!question.trim()) return;
    const userMsg: Message = { role: 'user', content: question.trim(), ts: Date.now() };
    setMessages((prev) => [...prev.slice(-9), userMsg]);
    setInput('');
    setIsLoading(true);
    try {
      // Call existing insights endpoint with current context
      const body = {
        windowDays,
        warehouseName: warehouseName ?? 'All',
        lowStockTop,
        overStockTop,
        selectedItem,
      };
      const res = await fetch('/api/agents/inventory-health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          question,
          chatHistory: [...messages, { role: 'user', content: question }].slice(-10).map(m => ({ role: m.role, content: m.content }))
        }),
      });
      const data = await res.json();
      const answer: string = data?.answer || 'Maaf, saya belum bisa memproses pertanyaan itu dari data yang tersedia.';
      setFollowUps(Array.isArray(data?.followUps) ? data.followUps.slice(0, 3) : []);
      const aiMsg: Message = { role: 'assistant', content: answer, ts: Date.now() };
      setMessages((prev) => [...prev.slice(-9), aiMsg]);
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    } catch (e: any) {
      const aiMsg: Message = { role: 'assistant', content: 'Maaf, terjadi kendala saat memproses pertanyaan.', ts: Date.now() };
      setMessages((prev) => [...prev.slice(-9), aiMsg]);
    } finally {
      setIsLoading(false);
    }
  }

  function onQuick(q: string) {
    setInput(q);
    void send(q);
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between">
        <div className="font-semibold">Tanya AI</div>
        <div className="text-xs text-gray-500">Jawaban berdasarkan data dashboard ini</div>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {['Kenapa item ini kritis?', 'Apa dampak kalau supplier telat 3 hari?', 'Apa yang harus dilakukan hari ini?'].map((q) => (
          <button key={q} onClick={() => onQuick(q)} className="text-xs px-2 py-1 rounded-full border hover:bg-gray-50">{q}</button>
        ))}
      </div>

      <div className="mt-3 h-64 overflow-y-auto space-y-2">
        {messages.map((m, idx) => (
          <div key={idx} className={`max-w-[90%] ${m.role === 'user' ? 'ml-auto text-right' : ''}`}>
            <div className={`${m.role === 'user' ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-900'} inline-block px-3 py-2 rounded-lg`}>{m.content}</div>
            {m.role === 'assistant' && idx === messages.length - 1 && followUps.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {followUps.map((f, i) => (
                  <button key={i} onClick={() => onQuick(f)} className="text-xs px-2 py-1 rounded-full border hover:bg-gray-50">{f}</button>
                ))}
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {!selectedItem && (
        <div className="mt-3">
          <div className="text-xs text-gray-600 mb-1">Pilih SKU cepat:</div>
          <div className="flex flex-wrap gap-2">
            {[...new Map([...lowStockTop, ...overStockTop].map(it => [it.sku, it])).values()].slice(0, 10).map((it) => (
              <button key={it.sku} onClick={() => onPickSku && onPickSku(it.sku)} className="text-xs px-2 py-1 rounded-full border hover:bg-gray-50">
                {it.sku} — {it.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tanya: kenapa SKU ini kritis?"
          className="border rounded-md px-3 py-2 text-base sm:text-sm flex-1"
        />
        <button type="submit" disabled={isLoading} className="px-3 py-2 text-sm rounded-md bg-brand-600 text-white disabled:opacity-50">Kirim</button>
      </form>
    </div>
  );
}

function buildAnswer(question: string, ctx: { insights: { executiveSummary?: string | null; insights?: string[]; actions?: string[]; itemNote?: { why: string; action: string } | null }; selectedItem: SlimItem | null; lowStockTop: SlimItem[]; overStockTop: SlimItem[]; }): string {
  const q = question.toLowerCase();
  const delay = detectDelayDay(q);
  const hasDelayIntent = /telat|delay|terlambat/.test(q);
  const askWhyItem = /kenapa|mengapa/.test(q) && (/item|ini|kriti|critical|menipis/.test(q));
  const askWhatToDo = /apa yang harus dilakukan hari ini|apa yang harus dilakukan|harus.*hari ini/.test(q);
  const askStockoutList = /(stok|stock).*habis|habis.*apa/.test(q);
  const askDaysLeft = /(berapa.*hari|cukup.*hari|sisa.*hari|berapa lama)/.test(q);
  const askSafe = /aman|safe/.test(q);

  const allItems: SlimItem[] = [ctx.selectedItem, ...ctx.lowStockTop, ...ctx.overStockTop].filter(Boolean) as SlimItem[];
  const tokenSku = q.match(/sku[-_ ]?[a-z0-9]+/i)?.[0]?.toLowerCase();
  const byToken = tokenSku ? allItems.find((it) => it.sku.toLowerCase() === tokenSku) : undefined;
  const byName = allItems.find((it) => q.includes(it.name.toLowerCase()));
  const bySkuSub = allItems.find((it) => q.includes(it.sku.toLowerCase()));
  const refItem = byToken || byName || bySkuSub || ctx.selectedItem || null;

  if (!refItem && (askWhyItem || hasDelayIntent || askDaysLeft || askSafe)) {
    return 'Pilih item dulu supaya saya bisa jawab lebih spesifik.';
  }

  if (hasDelayIntent) {
    const d = delay ?? 3;
    const item = refItem!;
    const dl = item.daysLeft;
    if (dl === null) return `Jika pemasok telat ${d} hari, dampaknya bergantung laju pemakaian. Tanpa data sisa hari stok, sebaiknya siapkan rencana pengadaan cadangan.`;
    const dlInt = Math.max(0, Math.floor(dl));
    if (dlInt === 0) return `Stok saat ini 0; keterlambatan ${d} hari akan memperpanjang periode stockout.`;
    if (d >= dlInt) return `Sisa hari stok sekitar ${dlInt}. Keterlambatan ${d} hari berpotensi memicu stockout.`;
    return `Masih ada buffer sekitar ${dlInt} hari. Keterlambatan ${d} hari kemungkinan aman, namun tetap pantau konsumsi harian.`;
  }

  if (askStockoutList) {
    const stockout = ctx.lowStockTop.filter((i) => i.qtyOnHand === 0).map((i) => i.sku || i.name);
    return stockout.length ? `Item habis stok: ${stockout.join(', ')}.` : 'Tidak ada item yang habis stok saat ini.';
  }

  if (askDaysLeft && refItem) {
    if (refItem.daysLeft === null) return 'Data sisa hari stok tidak tersedia untuk item ini.';
    const dlInt = Math.max(0, Math.floor(refItem.daysLeft));
    return dlInt === 0 ? 'Stok saat ini 0; tidak ada sisa hari stok.' : `Perkiraan sisa hari stok sekitar ${dlInt} hari.`;
  }

  if (askSafe && refItem) {
    const st = statusOf(refItem);
    if (st === 'STOCKOUT') return 'Belum aman: stok sudah habis.';
    if (st === 'LOW_BUFFER') return 'Belum aman: stok menipis dan perlu tindakan preventif.';
    return 'Relatif aman: stok di atas batas aman untuk saat ini.';
  }

  if (askWhyItem && refItem) {
    if (ctx.insights?.itemNote?.why && ctx.selectedItem && (ctx.selectedItem.sku === refItem.sku || ctx.selectedItem.name === refItem.name)) {
      return ctx.insights.itemNote.why;
    }
    const it = refItem;
    const isStockout = it.qtyOnHand === 0;
    const isLow = it.qtyOnHand > 0 && it.qtyOnHand < (it.safetyStock ?? 0);
    if (isStockout) return 'Stok saat ini 0 sementara pemakaian masih berjalan. Risiko operasional tinggi.';
    if (isLow) {
      const d = it.daysLeft !== null ? Math.max(0, Math.floor(it.daysLeft)) : null;
      return d !== null ? `Stok menipis dengan sisa sekitar ${d} hari. Perlu tindakan preventif.` : 'Stok menipis dan berisiko mengganggu layanan.';
    }
    return 'Stok berlebih; ruang dan modal kerja tidak efisien.';
  }

  if (askWhatToDo) {
    const actions: string[] = [];
    if (ctx.insights?.actions?.length) actions.push(...ctx.insights.actions);
    const stockoutSkus = ctx.lowStockTop.filter((i) => i.qtyOnHand === 0).map((i) => i.sku);
    const lowSkus = ctx.lowStockTop.filter((i) => i.qtyOnHand > 0 && i.qtyOnHand < (i.safetyStock ?? 0)).map((i) => i.sku);
    const overSkus = ctx.overStockTop.map((i) => i.sku);
    const lines: string[] = [];
    if (stockoutSkus.length) lines.push(`Prioritas: lakukan reorder untuk ${stockoutSkus.join(', ')}.`);
    if (lowSkus.length) lines.push(`Pantau dan siapkan pemesanan untuk ${lowSkus.join(', ')}.`);
    if (overSkus.length) lines.push(`Evaluasi pengurangan stok untuk ${overSkus.join(', ')}.`);
    if (actions.length) lines.push(...actions);
    return lines.length ? lines.join(' ') : 'Tidak ada tindakan mendesak; tetap pantau konsumsi dan stok aman.';
  }

  if (ctx.insights?.insights?.length) return ctx.insights.insights.slice(0, 3).join(' ');
  if (ctx.insights?.executiveSummary) return String(ctx.insights.executiveSummary);
  return 'Tidak ada informasi tambahan. Ajukan pertanyaan yang lebih spesifik.';
}
