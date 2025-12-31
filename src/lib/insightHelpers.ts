import type { ComputedItem } from '@/lib/inventoryHealth';

export type ItemStatus = 'STOCKOUT' | 'LOW_BUFFER' | 'OVERSTOCK';

export function getStatus(item: ComputedItem): ItemStatus {
  if (item.qtyOnHand === 0) return 'STOCKOUT';
  if (item.qtyOnHand > 0 && item.qtyOnHand < (item.safetyStock ?? 0)) return 'LOW_BUFFER';
  return 'OVERSTOCK';
}

export function getWorstRisk(items: ComputedItem[]): { sku: string; name: string; reasonText: string } | null {
  if (!items || items.length === 0) return null;
  const sorted = [...items].sort((a, b) => {
    // 1) prioritize stockout
    const aStockout = a.qtyOnHand === 0 ? 1 : 0;
    const bStockout = b.qtyOnHand === 0 ? 1 : 0;
    if (aStockout !== bStockout) return bStockout - aStockout; // stockout first
    // 2) highest outQty_30
    if (a.outQty_30 !== b.outQty_30) return b.outQty_30 - a.outQty_30;
    // 3) fallback highest avgDailyOut
    return (b.avgDailyOut ?? 0) - (a.avgDailyOut ?? 0);
  });
  const top = sorted[0];
  const status = getStatus(top);
  let reasonText = '';
  if (status === 'STOCKOUT') {
    reasonText = 'Stok saat ini 0, konsumsi 30 hari tinggi. Risiko produksi berhenti.';
    if ((top.outQty_30 ?? 0) === 0 && (top.avgDailyOut ?? 0) > 0) {
      reasonText = 'Stok 0 dan laju pemakaian aktif. Risiko operasi terhenti.';
    }
  } else if (status === 'LOW_BUFFER') {
    reasonText = `Stok menipis, sisa hari stok ${top.daysLeft !== null ? Math.max(0, Number(top.daysLeft.toFixed(0))) : 0}. Perlu tindakan preventif.`;
  } else {
    reasonText = 'Stok berlebih. Ruang dan modal kerja tidak efisien.';
  }
  return { sku: top.sku, name: top.name, reasonText };
}

export function formatVerdict(low: ComputedItem[], over: ComputedItem[]): { tone: 'red'|'yellow'|'blue'; text: string } {
  const anyStockout = low.some((i) => getStatus(i) === 'STOCKOUT');
  if (anyStockout) return { tone: 'red', text: 'Stok kritis terdeteksi. Risiko stockout sudah terjadi.' };
  const anyLow = low.some((i) => getStatus(i) === 'LOW_BUFFER');
  if (anyLow) return { tone: 'yellow', text: 'Stok menipis. Perlu tindakan preventif.' };
  return { tone: 'blue', text: 'Stok berlebih. Optimalkan ruang & cash.' };
}

export function buildWhyBullets(low: ComputedItem[], over: ComputedItem[]): string[] {
  const bullets: string[] = [];
  if (low.some((i) => getStatus(i) === 'STOCKOUT')) {
    bullets.push('Bahan penting habis dapat menghentikan proses produksi.');
    bullets.push('Potensi kehilangan penjualan jika barang jadi kosong.');
  } else if (low.length > 0) {
    bullets.push('Stok menipis menambah risiko keterlambatan pemenuhan.');
  }
  if (over.length > 0) {
    bullets.push('Stok berlebih mengikat modal dan ruang gudang.');
  }
  return bullets.slice(0, 3);
}

export function buildActionGroups(low: ComputedItem[], over: ComputedItem[]): { reorder: string[]; monitor: string[]; reduce: string[] } {
  const reorder = low.filter((i) => getStatus(i) === 'STOCKOUT').map((i) => `${i.sku}`);
  const monitor = low.filter((i) => getStatus(i) === 'LOW_BUFFER' && (i.daysLeft ?? 999) <= 7).map((i) => `${i.sku}`);
  const reduce = over.map((i) => `${i.sku}`);
  return { reorder, monitor, reduce };
}

export function buildSelectedItemNote(item: ComputedItem | null): { why: string; action: string } | null {
  if (!item) return null;
  const status = getStatus(item);
  if (status === 'STOCKOUT') {
    const why = 'Stok saat ini 0 sementara permintaan/pemakaian masih berjalan. Risiko operasional dan keterlambatan tinggi.';
    const action = 'Lakukan pemesanan ulang segera dan komunikasikan prioritas ke pemasok.';
    return { why, action };
  }
  if (status === 'LOW_BUFFER') {
    const days = item.daysLeft !== null ? Math.max(0, Number(item.daysLeft.toFixed(0))) : undefined;
    const why = days !== undefined ? `Stok menipis dengan sisa sekitar ${days} hari.` : 'Stok menipis dan berisiko mengganggu layanan.';
    const action = 'Jadwalkan pemesanan ulang dalam waktu dekat dan pantau konsumsi harian.';
    return { why, action };
  }
  const why = 'Stok melebihi kebutuhan dekat; ruang dan modal tidak efisien.';
  const action = 'Kurangi pesanan periode berikut, alihkan ke gudang/kanal dengan perputaran lebih cepat.';
  return { why, action };
}

