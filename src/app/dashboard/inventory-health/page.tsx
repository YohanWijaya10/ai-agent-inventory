"use client";

import { useEffect, useMemo, useState } from 'react';
import { SectionCard, Spinner } from '@/components/ui';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge as SBadge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DATA_PROXY, fetchJson } from '@/lib/dataClient';
import { BalancesResponseSchema, ProductsResponseSchema, TransactionsResponseSchema, WarehousesResponseSchema, type Balance, type Product, type Trx, type Warehouse } from '@/lib/schemas';
import { computeInventoryHealth, type ComputedItem, type DaysWindow } from '@/lib/inventoryHealth';
import { fetchIssueOutMaps, type OutMaps } from '@/lib/outIssues';
import { buildActionGroups, buildSelectedItemNote, buildWhyBullets, formatVerdict, getWorstRisk } from '@/lib/insightHelpers';
import AskAiPopup from '@/components/inventory/AskAiPopup';
import AskAiFab from '@/components/inventory/AskAiFab';

type TabKey = 'low' | 'over';

export default function InventoryHealthPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState<string>('ALL');
  const [days, setDays] = useState<DaysWindow>(30);
  const [search, setSearch] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [transactions, setTransactions] = useState<Trx[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>('low');
  const [insights, setInsights] = useState<{ executiveSummary: string | null; insights: string[]; actions: string[]; itemNote: { why: string; action: string } | null; error?: string | null }>({ executiveSummary: null, insights: [], actions: [], itemNote: null });
  const [selectedItem, setSelectedItem] = useState<ComputedItem | null>(null);
  const [outMaps, setOutMaps] = useState<OutMaps | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [showDraftPlan, setShowDraftPlan] = useState(false);
  // Parameters for purchase recommendation
  const [leadTimeDays, setLeadTimeDays] = useState<number>(7);
  const [bufferDays, setBufferDays] = useState<number>(3);

  type DraftPlanRow = { sku: string; name: string; reason: string; priority: 'High'|'Medium' };
  const [draftPlan, setDraftPlan] = useState<DraftPlanRow[]>([]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [warehousesRaw, productsRaw, balancesRaw, trxRaw] = await Promise.all([
        fetchJson(`${DATA_PROXY}/api/warehouses`, { cache: 'no-store' }),
        fetchJson(`${DATA_PROXY}/api/products`, { cache: 'no-store' }),
        fetchJson(`${DATA_PROXY}/api/inventorybalance`, { cache: 'no-store' }),
        fetchJson(`${DATA_PROXY}/api/inventorytransaction`, { cache: 'no-store' }),
      ]);

      const whsP = WarehousesResponseSchema.safeParse(warehousesRaw);
      const prodsP = ProductsResponseSchema.safeParse(productsRaw);
      const balsP = BalancesResponseSchema.safeParse(balancesRaw);
      const trxP = TransactionsResponseSchema.safeParse(trxRaw);

      setWarehouses(whsP.success ? whsP.data.filter((w) => w.id && w.name) : []);
      setProducts(prodsP.success ? prodsP.data : []);
      setBalances(balsP.success ? balsP.data : []);
      setTransactions(trxP.success ? trxP.data : []);

      if (!whsP.success || !prodsP.success || !balsP.success || !trxP.success) {
        setError('Sebagian data tidak sesuai skema. Menampilkan data yang tersedia.');
      }
    } catch (e: any) {
      setError(e.message || 'Gagal memuat data');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => { (async () => { try { const maps = await fetchIssueOutMaps(); setOutMaps(maps); } catch { setOutMaps(null); } })(); }, []);

  const computed = useMemo(() => {
    const wId = warehouseId === 'ALL' ? undefined : warehouseId;
    const balFiltered = balances.filter((b) => !wId || b.warehouseId === wId);
    const trxFiltered = transactions.filter((t) => !wId || t.warehouseId === wId);
    return computeInventoryHealth({ balances: balFiltered, products, transactions: trxFiltered, windowDays: days, search });
  }, [balances, products, transactions, warehouseId, days, search]);

  function withOutOverrides(row: ComputedItem): ComputedItem {
    if (!outMaps) return row;
    const v7 = outMaps.out7[row.productId];
    const v14 = outMaps.out14[row.productId];
    const v30 = outMaps.out30[row.productId];
    const outQty_7 = typeof v7 === 'number' ? v7 : row.outQty_7;
    const outQty_14 = typeof v14 === 'number' ? v14 : row.outQty_14;
    const outQty_30 = typeof v30 === 'number' ? v30 : row.outQty_30;
    let avgDailyOut = 0;
    if (outQty_7 > 0) avgDailyOut = outQty_7 / 7;
    else if (outQty_14 > 0) avgDailyOut = outQty_14 / 14;
    else if (outQty_30 > 0) avgDailyOut = outQty_30 / 30;
    const daysLeft = avgDailyOut > 0 ? row.qtyOnHand / avgDailyOut : null;
    return { ...row, outQty_7, outQty_14, outQty_30, avgDailyOut, daysLeft };
  }

  useEffect(() => {
    (async () => {
      try {
        setInsightsLoading(true);
        const warehouseName = warehouseId === 'ALL' ? 'All' : (warehouses.find((w) => w.id === warehouseId)?.name || warehouseId);
        const lowOver = {
          lowStockTop: computed.lowStock.map(withOutOverrides),
          overStockTop: computed.overStock.map(withOutOverrides),
        };
        const body = {
          windowDays: days,
          warehouseName,
          lowStockTop: lowOver.lowStockTop,
          overStockTop: lowOver.overStockTop,
          selectedItem: selectedItem ? withOutOverrides(selectedItem) : null,
        };
        const res = await fetch('/api/ai/explain-inventory-health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        setInsights(data);
      } catch (e: any) {
        setInsights({ executiveSummary: null, insights: [], actions: [], itemNote: null, error: e.message });
      } finally {
        setInsightsLoading(false);
      }
    })();
  }, [days, warehouseId, JSON.stringify(computed.lowStock), JSON.stringify(computed.overStock), selectedItem, outMaps, warehouses]);

  // removed generated timestamp display

  const lowOverWithOverrides = useMemo(() => {
    const low = computed.lowStock.map(withOutOverrides);
    const over = computed.overStock.map(withOutOverrides);
    return { low, over };
  }, [computed.lowStock, computed.overStock, outMaps]);

  const worst = useMemo(() => getWorstRisk(lowOverWithOverrides.low), [lowOverWithOverrides.low]);
  const kpis = useMemo(() => ([
    { label: 'Low Stock Count', value: computed.summary.lowStockCount },
    { label: 'Overstock Count', value: computed.summary.overStockCount },
  ]), [computed.summary]);

  // Agent: classify priorities using ONLY existing data
  // Priority rules: P1 stockout; P2 low buffer with daysLeft <= 7; P3 overstock
  const agentPlan = useMemo(() => {
    const stockout = lowOverWithOverrides.low.filter(i => i.qtyOnHand === 0);
    // Low buffer: stok > 0, stok ≤ stok aman, sisa hari (dibulatkan kebawah) ≤ 7
    const lowBuffer = lowOverWithOverrides.low.filter(i => {
      if (!(i.qtyOnHand > 0)) return false;
      if (!(i.qtyOnHand <= (i.safetyStock ?? 0))) return false;
      if (i.daysLeft === null) return false;
      const dl = Math.floor(i.daysLeft);
      return dl <= 7;
    });
    const overstock = lowOverWithOverrides.over.filter(i => i.qtyOnHand > (i.safetyStock ?? 0));

    const todayUrgent = stockout.map(i => `Reorder: ${i.sku} (stok habis)`);
    const next7Days = lowBuffer.map(i => {
      const dl = i.daysLeft !== null ? Math.max(0, Math.floor(i.daysLeft)) : undefined;
      return dl !== undefined ? `Monitor & jadwalkan reorder: ${i.sku} (sisa ~${dl} hari)` : `Monitor & jadwalkan reorder: ${i.sku}`;
    });
    const optimization = overstock.map(i => `Kurangi/redistribusi stok: ${i.sku} (stok berlebih)`);

    // worstRisk item for auto selection (prefer stockout from low)
    return { stockout, lowBuffer, overstock, todayUrgent, next7Days, optimization };
  }, [lowOverWithOverrides.low, lowOverWithOverrides.over]);

  // Auto select worst risk item to keep the page proactive
  useEffect(() => {
    if (!worst) return;
    if (!selectedItem || selectedItem.sku !== worst.sku) {
      const candidate = [...computed.lowStock, ...computed.overStock].map(withOutOverrides).find(i => i.sku === worst.sku);
      if (candidate) setSelectedItem(candidate);
    }
  }, [worst, computed.lowStock, computed.overStock]);

  function onGenerateDraftPlan() {
    const rows: DraftPlanRow[] = [];
    for (const i of agentPlan.stockout) {
      rows.push({ sku: i.sku, name: i.name, reason: 'Stok habis; top-up ke level aman + buffer.', priority: 'High' });
    }
    for (const i of agentPlan.lowBuffer) {
      const dl = i.daysLeft !== null ? Math.max(0, Math.floor(i.daysLeft)) : undefined;
      rows.push({ sku: i.sku, name: i.name, reason: dl !== undefined ? `Stok menipis (sisa ~${dl} hari).` : 'Stok menipis.', priority: 'Medium' });
    }
    setDraftPlan(rows);
    setShowDraftPlan(true);
  }

  function computeRecommendedQty(item: ComputedItem): number {
    const available = Math.max(0, (item.qtyOnHand ?? 0) - (item.qtyReserved ?? 0));
    const avg = Math.max(0, item.avgDailyOut ?? 0);
    const baseTarget = Math.max(item.safetyStock ?? 0, item.reorderPoint ?? 0);
    let targetLevel = baseTarget;
    const isStockout = (item.qtyOnHand ?? 0) === 0;
    if (isStockout) {
      targetLevel = (item.safetyStock ?? baseTarget) + avg * (Math.max(0, leadTimeDays) + Math.max(0, bufferDays));
    } else if (avg > 0) {
      targetLevel = baseTarget + avg * Math.max(0, bufferDays);
    } else {
      targetLevel = baseTarget; // slow/no movement
    }
    const needed = Math.ceil(Math.max(0, targetLevel - available));
    return Number.isFinite(needed) ? needed : 0;
  }

  return (
    <div className="container-max py-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Kesehatan Persediaan</h1>
          <p className="text-sm text-gray-500">Pantau risiko stok rendah dan overstock untuk keputusan cepat.</p>
        </div>
      </div>

      <Card className="mb-6"><CardContent className="p-4">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Gudang</label>
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="border rounded-md px-2 py-1 text-sm">
              <option value="ALL">All</option>
              {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.name}</option>))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Hari</label>
            <div className="inline-flex rounded-md shadow-sm border overflow-hidden">
              {[7, 14, 30].map((d) => (
                <button key={d} onClick={() => setDays(d as DaysWindow)} className={`px-3 py-1.5 text-sm ${days === d ? 'bg-brand-600 text-white' : 'bg-white hover:bg-gray-50'}`}>{d}</button>
              ))}
            </div>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cari SKU atau nama" className="border rounded-md px-3 py-1.5 text-sm w-full sm:w-64" />
            <Button variant="outline" onClick={refresh}>Muat Ulang</Button>
          </div>
        </div>
        {error && (<div className="mt-3 text-sm text-red-600">{error}</div>)}
      </CardContent></Card>

      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {kpis.map((k) => (
          <Card key={k.label} className="col-span-1"><CardContent className="p-4">
            <div className="text-sm text-gray-500">{k.label}</div>
            <div className="mt-1 text-xl font-semibold" suppressHydrationWarning>{k.value}</div>
          </CardContent></Card>
        ))}
        <Card className="col-span-2 lg:col-span-1"><CardContent className="p-4">
          <div className="text-sm text-gray-500">Risiko Terburuk</div>
          {worst ? (
            <div className="mt-1"><div className="font-semibold">{worst.name} ({worst.sku})</div><div className="text-xs text-gray-600 mt-1">{worst.reasonText}</div></div>
          ) : (<div className="mt-1 text-gray-500">—</div>)}
        </CardContent></Card>
        
      </div>

      <Card className="mb-6"><CardContent className="p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">AI Insights</h3>
          <div className="flex items-center gap-2">{insightsLoading && <SBadge variant="secondary">Memuat…</SBadge>}{insights?.error && <SBadge variant="destructive">LLM Error</SBadge>}</div>
        </div>
        {(() => { const v = formatVerdict(lowOverWithOverrides.low, lowOverWithOverrides.over); const variant = v.tone === 'red' ? 'destructive' : v.tone === 'yellow' ? 'warning' : 'info'; return (<Alert variant={variant as any} className="mt-3 font-semibold">{v.text}</Alert>); })()}
        {/* Narrative paragraphs (2–4 short paragraphs) */}
        {(() => {
          const paras: string[] = [];
          if (insights?.executiveSummary) paras.push(String(insights.executiveSummary));
          if (Array.isArray(insights?.insights) && insights.insights.length) {
            // Join insights into 1–2 paragraphs for readability
            const half = Math.ceil(Math.min(insights.insights.length, 4) / 2);
            const first = insights.insights.slice(0, half).join(' ');
            const second = insights.insights.slice(half, half * 2).join(' ');
            if (first) paras.push(first);
            if (second) paras.push(second);
          }
          // Fallback if model returned nothing
          if (!paras.length) {
            const v = formatVerdict(lowOverWithOverrides.low, lowOverWithOverrides.over);
            paras.push('Ringkasnya, kondisi stok hari ini menunjukkan pola yang perlu perhatian khusus. Beberapa material berada pada level kritis/menipis, sementara sebagian lain justru berlebih.');
            if (v.tone === 'red') paras.push('Dampaknya dapat mengganggu kelancaran produksi dan pemenuhan pesanan. Prioritas utama adalah mengamankan material yang sudah habis dan yang sisa harinya tinggal sedikit.');
            else if (v.tone === 'yellow') paras.push('Jika tidak ditangani segera, stok yang menipis dapat jatuh ke kondisi habis dan menghentikan proses produksi pada beberapa lini.');
            else paras.push('Stok berlebih mengikat ruang dan modal. Tanpa tindakan, biaya penyimpanan meningkat dan perputaran persediaan menurun.');
          }
          return (
            <div className="mt-4 space-y-2 text-sm text-gray-800">
              {paras.slice(0, 4).map((p, i) => (<p key={i}>{p}</p>))}
            </div>
          );
        })()}
        {/* Actions (short bullets, max 3) */}
        <div className="mt-4">
          <div className="text-xs uppercase text-gray-500 mb-1">Rekomendasi Tindakan</div>
          {(() => { const ag = buildActionGroups(lowOverWithOverrides.low, lowOverWithOverrides.over); const bullets = [
            ag.reorder.length ? `Reorder segera: ${ag.reorder.slice(0,5).join(', ')}` : '',
            ag.monitor.length ? `Pantau dekat: ${ag.monitor.slice(0,5).join(', ')}` : '',
            ag.reduce.length ? `Kurangi stok: ${ag.reduce.slice(0,5).join(', ')}` : '',
          ].filter(Boolean).slice(0,3); return bullets.length ? (<ul className="list-disc ml-5 text-sm space-y-1">{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>) : (<div className="text-sm text-gray-500">—</div>); })()}
        </div>
      </CardContent></Card>

      {/* Agent Plan */}
      <Card className="mb-6"><CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="font-semibold">📋 Rencana Otomatis Hari Ini (AI Agent)</div>
          <Button variant="outline" onClick={onGenerateDraftPlan}>Generate Draft Purchase Plan</Button>
        </div>
        <div className="mt-3">
          <div className="text-xs uppercase text-gray-500 mb-1">TODAY (URGENT)</div>
          {agentPlan.todayUrgent.length ? (
            <ul className="list-disc ml-5 text-sm space-y-1">
              {agentPlan.todayUrgent.map((l, i) => (<li key={i}>{l}</li>))}
            </ul>
          ) : (<div className="text-sm text-gray-500">Tidak ada tindakan mendesak.</div>)}
        </div>
        <div className="mt-4">
          <div className="text-xs uppercase text-gray-500 mb-1">NEXT 7 DAYS</div>
          {agentPlan.next7Days.length ? (
            <ul className="list-disc ml-5 text-sm space-y-1">
              {agentPlan.next7Days.map((l, i) => (<li key={i}>{l}</li>))}
            </ul>
          ) : (<div className="text-sm text-gray-500">Tidak ada rencana 7 hari ke depan.</div>)}
        </div>
        <div className="mt-4">
          <div className="text-xs uppercase text-gray-500 mb-1">OPTIMIZATION</div>
          {agentPlan.optimization.length ? (
            <ul className="list-disc ml-5 text-sm space-y-1">
              {agentPlan.optimization.map((l, i) => (<li key={i}>{l}</li>))}
            </ul>
          ) : (<div className="text-sm text-gray-500">Tidak ada rekomendasi optimasi.</div>)}
        </div>
      </CardContent></Card>

      {/* Draft Purchase Plan (artifact) */}
      {showDraftPlan && (
        <Card className="mb-6"><CardContent className="p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="font-semibold">Draft Purchase Plan</div>
            <div className="flex items-center gap-2 ml-auto">
              <label className="text-sm text-gray-600">Lead time (hari)</label>
              <input type="number" min={0} max={90} value={leadTimeDays} onChange={(e)=>setLeadTimeDays(Math.max(0, parseInt(e.target.value || '0', 10)))} className="w-20 border rounded px-2 py-1 text-sm" />
              <label className="text-sm text-gray-600">Buffer (hari)</label>
              <input type="number" min={0} max={60} value={bufferDays} onChange={(e)=>setBufferDays(Math.max(0, parseInt(e.target.value || '0', 10)))} className="w-20 border rounded px-2 py-1 text-sm" />
              <Button variant="ghost" onClick={()=>setShowDraftPlan(false)} className="text-gray-700">Tutup</Button>
            </div>
          </div>

          {/* Mobile list */}
          <div className="mt-3 space-y-3 sm:hidden">
            {draftPlan.length === 0 && (
              <div className="p-4 text-gray-500 text-center border rounded-md">Tidak ada item untuk dibeli.</div>
            )}
            {draftPlan.map((r, idx) => {
              const all = [...computed.lowStock, ...computed.overStock].map(withOutOverrides);
              const it = all.find(i => i.sku === r.sku);
              const rec = it ? computeRecommendedQty(it) : 0;
              return (
                <div key={idx} className="border rounded-md p-3">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold">{r.sku}</div>
                    <span className={`text-xs px-2 py-0.5 rounded ${r.priority === 'High' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>{r.priority}</span>
                  </div>
                  <div className="text-sm text-gray-700 mt-1">{r.name}</div>
                  <div className="text-xs text-gray-500 mt-1">{r.reason}</div>
                  <div className="mt-2 text-sm"><span className="text-gray-500">Recommended Qty:</span> <span className="font-semibold">{rec}</span></div>
                </div>
              );
            })}
          </div>

          {/* Desktop table */}
          <div className="mt-3 overflow-x-auto hidden sm:block">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
                <tr>
                  <th className="text-left p-2">SKU</th>
                  <th className="text-left p-2">Nama</th>
                  <th className="text-left p-2">Alasan</th>
                  <th className="text-left p-2">Prioritas</th>
                  <th className="text-right p-2">Recommended Qty</th>
                </tr>
              </thead>
              <tbody>
                {draftPlan.map((r, idx) => {
                  const all = [...computed.lowStock, ...computed.overStock].map(withOutOverrides);
                  const it = all.find(i => i.sku === r.sku);
                  const rec = it ? computeRecommendedQty(it) : 0;
                  return (
                    <tr key={idx} className="border-t">
                      <td className="p-2">{r.sku}</td>
                      <td className="p-2">{r.name}</td>
                      <td className="p-2">{r.reason}</td>
                      <td className="p-2">{r.priority}</td>
                      <td className="p-2 text-right">{rec}</td>
                    </tr>
                  );
                })}
                {draftPlan.length === 0 && (
                  <tr><td colSpan={5} className="p-4 text-gray-500 text-center">Tidak ada item untuk dibeli.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent></Card>
      )}

      {/* Ask AI popup trigger handled in header; popup mounted below */}

      <Tabs value={activeTab} onValueChange={(v)=>setActiveTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="low">Stok Rendah</TabsTrigger>
          <TabsTrigger value="over">Overstock</TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase"><tr><th className="text-left p-2">SKU</th><th className="text-left p-2">Nama</th><th className="text-left p-2">Satuan</th><th className="text-left p-2">Status</th><th className="text-right p-2">Stok Saat Ini</th><th className="text-right p-2">Dipesan</th><th className="text-right p-2">Stok Aman</th><th className="text-right p-2">Batas Pesan Ulang</th><th className="text-right p-2">Keluar 7h</th><th className="text-right p-2">Keluar 14h</th><th className="text-right p-2">Keluar 30h</th><th className="text-right p-2">Rata-rata/hari</th><th className="text-right p-2">Sisa Hari</th></tr></thead>
            <tbody>
              {(activeTab === 'low' ? computed.lowStock : computed.overStock).map((r) => {
                const row = withOutOverrides(r);
                const isStockout = row.qtyOnHand === 0;
                const isLow = row.qtyOnHand > 0 && row.qtyOnHand < (row.safetyStock ?? 0);
                const status = isStockout ? 'STOCKOUT' : (isLow ? 'LOW_BUFFER' : 'OVERSTOCK');
                const rowTint = isStockout ? 'bg-red-50' : (isLow ? 'bg-yellow-50' : 'bg-indigo-50');
                const badge = status === 'STOCKOUT' ? (<SBadge variant="destructive">STOCKOUT</SBadge>) : status === 'LOW_BUFFER' ? (<SBadge variant="warning">LOW BUFFER</SBadge>) : (<SBadge variant="secondary">OVERSTOCK</SBadge>);
                return (
                  <tr key={`${row.warehouseId}-${row.productId}`} className={`border-t hover:bg-gray-100 cursor-pointer ${rowTint}`} onClick={() => setSelectedItem(row)}>
                    <td className="p-2 whitespace-nowrap"><div className="font-medium">{row.sku}</div></td>
                    <td className="p-2 whitespace-nowrap">{row.name}</td>
                    <td className="p-2 whitespace-nowrap">{row.uom}</td>
                    <td className="p-2 whitespace-nowrap">{badge}</td>
                    <td className="p-2 text-right">{row.qtyOnHand}</td>
                    <td className="p-2 text-right">{row.qtyReserved}</td>
                    <td className="p-2 text-right">{row.safetyStock}</td>
                    <td className="p-2 text-right">{row.reorderPoint}</td>
                    <td className="p-2 text-right">{row.outQty_7}</td>
                    <td className="p-2 text-right">{row.outQty_14}</td>
                    <td className="p-2 text-right">{row.outQty_30}</td>
                    <td className="p-2 text-right">{row.avgDailyOut.toFixed(2)}</td>
                    <td className="p-2 text-right">{row.daysLeft !== null ? row.daysLeft.toFixed(1) : '—'}</td>
                  </tr>
                );
              })}
              {loading && (<tr><td colSpan={13} className="p-6 text-center text-gray-500"><div className="inline-flex items-center gap-2 justify-center"><Spinner /> Loading…</div></td></tr>)}
              {!loading && (activeTab === 'low' ? computed.lowStock.length === 0 : computed.overStock.length === 0) && (<tr><td colSpan={13} className="p-6 text-center text-gray-500">No items</td></tr>)}
            </tbody>
          </table>
        </div>
        </Card>

      <Card className="mt-4"><CardContent className="p-4">
        <div className="font-semibold">Catatan Item Terpilih</div>
        {selectedItem ? (
          <div className="mt-2 text-sm text-gray-700 space-y-2">
            <div className="text-gray-900 font-medium">{selectedItem.name} ({selectedItem.sku})</div>
            {(() => { const note = buildSelectedItemNote(withOutOverrides(selectedItem)); return note ? (<div className="space-y-3"><div><div className="text-xs uppercase text-gray-500">Kenapa ini penting</div><div className="mt-1">{note.why}</div></div><div><div className="text-xs uppercase text-gray-500">Langkah yang disarankan</div><div className="mt-1">{note.action}</div></div></div>) : (<div className="text-gray-500">—</div>); })()}
          </div>
        ) : (<div className="mt-2 text-sm text-gray-500">Klik item untuk melihat analisis.</div>)}
      </CardContent></Card>

      {(() => {
        const warehouseName = warehouseId === 'ALL' ? 'All' : (warehouses.find((w) => w.id === warehouseId)?.name || warehouseId);
        const makeSlim = (x: ComputedItem) => ({ sku: x.sku, name: x.name, qtyOnHand: x.qtyOnHand, safetyStock: x.safetyStock, reorderPoint: x.reorderPoint, outQty_7: x.outQty_7, outQty_14: x.outQty_14, outQty_30: x.outQty_30, avgDailyOut: x.avgDailyOut, daysLeft: x.daysLeft });
        const lowSlim = lowOverWithOverrides.low.map(makeSlim);
        const overSlim = lowOverWithOverrides.over.map(makeSlim);
        const selSlim = selectedItem ? makeSlim(withOutOverrides(selectedItem)) : null;
        return (
          <AskAiPopup
            open={askOpen}
            onClose={()=>setAskOpen(false)}
            windowDays={days}
            warehouseName={warehouseName}
            lowStockTop={lowSlim}
            overStockTop={overSlim}
            selectedItem={selSlim}
            onPickSku={(sku) => {
              const all = [...computed.lowStock, ...computed.overStock].map(withOutOverrides);
              const found = all.find(i => i.sku === sku);
              if (found) setSelectedItem(found);
            }}
          />
        );
      })()}

      {/* Floating AI button pinned to the screen */}
      <AskAiFab onClick={() => setAskOpen(true)} />
    </div>
  );
}
