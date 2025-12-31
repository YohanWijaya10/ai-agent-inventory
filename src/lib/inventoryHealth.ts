import { BalancesResponseSchema, Balance, ProductsResponseSchema, Product, TransactionsResponseSchema, Trx, Warehouse, WarehousesResponseSchema } from './schemas';
import { BASE_DATA_API, fetchJson } from './dataClient';

export type DaysWindow = 7 | 14 | 30;

export type ComputedItem = {
  productId: string;
  warehouseId: string;
  sku: string;
  name: string;
  category: string;
  uom: string;
  qtyOnHand: number;
  qtyReserved: number;
  safetyStock: number;
  reorderPoint: number;
  outQty_7: number;
  outQty_14: number;
  outQty_30: number;
  avgDailyOut: number | 0;
  daysLeft: number | null;
};

export type Summary = {
  totalProductsAnalyzed: number;
  lowStockCount: number;
  overStockCount: number;
  worstRisk: { productId: string; name: string; sku: string; daysLeft: number } | null;
};

export type InventoryHealthResult = {
  lowStock: ComputedItem[];
  overStock: ComputedItem[];
  summary: Summary;
};

export async function loadDomainData(params: { warehouseId?: string | null }): Promise<{
  balances: Balance[];
  products: Product[];
  transactions: Trx[];
  warehouses: Warehouse[];
  errors: string[];
}> {
  const errors: string[] = [];
  const [balancesRaw, productsRaw, trxRaw, warehousesRaw] = await Promise.all([
    fetchJson(`${BASE_DATA_API}/api/inventorybalance`).catch((e) => { errors.push(`balances: ${e.message}`); return []; }),
    fetchJson(`${BASE_DATA_API}/api/products`).catch((e) => { errors.push(`products: ${e.message}`); return []; }),
    fetchJson(`${BASE_DATA_API}/api/inventorytransaction`).catch((e) => { errors.push(`transactions: ${e.message}`); return []; }),
    fetchJson(`${BASE_DATA_API}/api/warehouses`).catch((e) => { errors.push(`warehouses: ${e.message}`); return []; }),
  ]);

  const warehousesParse = WarehousesResponseSchema.safeParse(warehousesRaw);
  if (!warehousesParse.success) errors.push('warehouses shape invalid');
  const productsParse = ProductsResponseSchema.safeParse(productsRaw);
  if (!productsParse.success) errors.push('products shape invalid');
  const balancesParse = BalancesResponseSchema.safeParse(balancesRaw);
  if (!balancesParse.success) errors.push('balances shape invalid');
  const trxParse = TransactionsResponseSchema.safeParse(trxRaw);
  if (!trxParse.success) errors.push('transactions shape invalid');

  let balances = balancesParse.success ? balancesParse.data : [];
  let transactions = trxParse.success ? trxParse.data : [];
  const products = productsParse.success ? productsParse.data : [];
  const warehouses = warehousesParse.success ? warehousesParse.data : [];

  if (params.warehouseId && params.warehouseId !== 'ALL') {
    balances = balances.filter((b) => b.warehouseId === params.warehouseId);
    transactions = transactions.filter((t) => t.warehouseId === params.warehouseId);
  }

  return { balances, products, transactions, warehouses, errors };
}

export function computeInventoryHealth(args: {
  balances: Balance[];
  products: Product[];
  transactions: Trx[];
  windowDays: DaysWindow;
  search?: string;
}): InventoryHealthResult {
  const { balances, products, transactions, windowDays, search } = args;

  const now = new Date();
  // Gunakan semua transaksi; masing-masing window (7/14/30) akan dihitung relatif ke NOW
  const txFiltered = transactions.filter((t) => t.trxDate instanceof Date && !isNaN(t.trxDate.getTime()));

  const productMap = new Map(products.map((p) => [p.id, p]));

  const key = (wId: string, pId: string) => `${wId}__${pId}`;

  const groupBalances = new Map<string, Balance>();
  for (const b of balances) {
    groupBalances.set(key(b.warehouseId, b.productId), b);
  }

  const groupedIssues = new Map<string, Trx[]>();
  for (const t of txFiltered) {
    if (String(t.trxType).trim().toUpperCase() !== 'ISSUE') continue;
    const k = key(t.warehouseId, t.productId);
    const arr = groupedIssues.get(k) ?? [];
    arr.push(t);
    groupedIssues.set(k, arr);
  }

  const items: ComputedItem[] = [];
  for (const [k, bal] of groupBalances.entries()) {
    const prod = productMap.get(bal.productId);
    if (!prod) continue;
    const issues = groupedIssues.get(k) ?? [];

    function sumOutWithin(days: number): number {
      const threshold = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      let sum = 0;
      for (const tr of issues) {
        if (tr.trxDate < threshold) continue;
        let qty = 0;
        if (typeof tr.signedQty === 'number') {
          qty = tr.signedQty < 0 ? -tr.signedQty : tr.signedQty;
        } else if (typeof tr.qty === 'number') {
          qty = tr.qty;
        }
        sum += qty;
      }
      return sum;
    }

    const out7 = sumOutWithin(7);
    const out14 = sumOutWithin(14);
    const out30 = sumOutWithin(30);

    let avgDailyOut = 0;
    if (out7 > 0) avgDailyOut = out7 / 7;
    else if (out14 > 0) avgDailyOut = out14 / 14;
    else if (out30 > 0) avgDailyOut = out30 / 30;

    const daysLeft = avgDailyOut > 0 ? bal.qtyOnHand / avgDailyOut : null;

    const item: ComputedItem = {
      productId: bal.productId,
      warehouseId: bal.warehouseId,
      sku: prod.sku,
      name: prod.name,
      category: prod.category ?? '',
      uom: prod.uom ?? 'ea',
      qtyOnHand: bal.qtyOnHand,
      qtyReserved: bal.qtyReserved ?? 0,
      safetyStock: bal.safetyStock ?? 0,
      reorderPoint: bal.reorderPoint ?? 0,
      outQty_7: out7,
      outQty_14: out14,
      outQty_30: out30,
      avgDailyOut,
      daysLeft,
    };
    items.push(item);
  }

  const filtered = (search && search.trim())
    ? items.filter((i) => {
        const q = search.toLowerCase();
        return i.sku.toLowerCase().includes(q) || i.name.toLowerCase().includes(q);
      })
    : items;

  function isLow(i: ComputedItem): boolean {
    return (
      i.qtyOnHand <= i.safetyStock ||
      i.qtyOnHand <= i.reorderPoint ||
      (i.daysLeft !== null && i.daysLeft < 7)
    );
  }

  function isOver(i: ComputedItem): boolean {
    return (
      i.qtyOnHand > (i.safetyStock * 3) ||
      (i.outQty_30 === 0 && i.qtyOnHand > i.safetyStock)
    );
  }

  const lowStock = filtered
    .filter(isLow)
    .sort((a, b) => {
      // sort by daysLeft asc (null last)
      const aNull = a.daysLeft === null, bNull = b.daysLeft === null;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      return (a.daysLeft! - b.daysLeft!);
    })
    .slice(0, 10);

  const overStock = filtered
    .filter(isOver)
    .sort((a, b) => b.qtyOnHand - a.qtyOnHand)
    .slice(0, 10);

  const nonNullDays = filtered.filter((i) => i.daysLeft !== null);
  const worst = nonNullDays.sort((a, b) => (a.daysLeft! - b.daysLeft!))[0];

  const summary: Summary = {
    totalProductsAnalyzed: items.length,
    lowStockCount: filtered.filter(isLow).length,
    overStockCount: filtered.filter(isOver).length,
    worstRisk: worst ? { productId: worst.productId, name: worst.name, sku: worst.sku, daysLeft: Number(worst.daysLeft!.toFixed(1)) } : null,
  };

  return { lowStock, overStock, summary };
}
