import { z } from 'zod';

// Accept either `id` or `warehouseId` and `name` or `warehouseName`; normalize to { id, name }
const WarehouseRaw = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  warehouseId: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  warehouseName: z.string().optional(),
}).passthrough();

export const WarehouseSchema = WarehouseRaw.transform((w) => ({
  id: String((w as any).id ?? (w as any).warehouseId ?? ''),
  name: String((w as any).name ?? (w as any).warehouseName ?? ''),
})) as unknown as z.ZodType<{ id: string; name: string }>;
export const WarehousesResponseSchema = z.array(WarehouseSchema);

// Products may come as { id | productId, sku | code, name | productName }
const ProductRaw = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  productId: z.union([z.string(), z.number()]).optional(),
  sku: z.string().optional(),
  code: z.string().optional(),
  name: z.string().optional(),
  productName: z.string().optional(),
  category: z.string().optional(),
  categoryName: z.string().optional(),
  uom: z.string().optional(),
  unit: z.string().optional(),
  unitOfMeasure: z.string().optional(),
}).passthrough();

export const ProductSchema = ProductRaw.transform((p) => ({
  id: String((p as any).id ?? (p as any).productId ?? ''),
  sku: String((p as any).sku ?? (p as any).code ?? ''),
  name: String((p as any).name ?? (p as any).productName ?? ''),
  category: String((p as any).category ?? (p as any).categoryName ?? ''),
  uom: String((p as any).uom ?? (p as any).unit ?? (p as any).unitOfMeasure ?? 'ea'),
})) as unknown as z.ZodType<{ id: string; sku: string; name: string; category: string; uom: string }>;

export const ProductsResponseSchema = z.array(ProductSchema);

export const BalanceSchema = z.object({
  productId: z.union([z.string(), z.number()]).transform((v) => String(v)),
  warehouseId: z.union([z.string(), z.number()]).transform((v) => String(v)),
  qtyOnHand: z.coerce.number(),
  qtyReserved: z.coerce.number().optional().default(0),
  safetyStock: z.coerce.number().optional().default(0),
  reorderPoint: z.coerce.number().optional().default(0),
}).passthrough();
export const BalancesResponseSchema = z.array(BalanceSchema);

export const TransactionSchema = z.object({
  productId: z.union([z.string(), z.number()]).transform((v) => String(v)),
  warehouseId: z.union([z.string(), z.number()]).transform((v) => String(v)),
  trxType: z.string(),
  qty: z.coerce.number().optional(),
  signedQty: z.coerce.number().optional(),
  trxDate: z.preprocess((v) => parseDateFlexible(v), z.date()),
}).passthrough();
export const TransactionsResponseSchema = z.array(TransactionSchema);

export type Warehouse = z.infer<typeof WarehouseSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Balance = z.infer<typeof BalanceSchema>;
export type Trx = z.infer<typeof TransactionSchema>;

function parseDateFlexible(v: unknown): Date {
  if (v instanceof Date) return v;
  const s = String(v ?? '').trim();
  if (!s) return new Date('');
  // ISO or RFC
  const d1 = new Date(s);
  if (!isNaN(d1.getTime())) return d1;
  // YYYY-MM-DD
  const mIso = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (mIso) {
    const [_, y, mo, d, hh = '00', mm = '00', ss = '00'] = mIso;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss));
    if (!isNaN(dt.getTime())) return dt;
  }
  // DD/MM/YYYY
  const mDmy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (mDmy) {
    const [_, d, mo, y] = mDmy;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    if (!isNaN(dt.getTime())) return dt;
  }
  // MM/DD/YYYY
  const mMdy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (mMdy) {
    const [_, mo, d, y] = mMdy;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    if (!isNaN(dt.getTime())) return dt;
  }
  return new Date('');
}
