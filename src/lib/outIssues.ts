import { DATA_PROXY } from './dataClient';

export type OutMaps = {
  out7: Record<string, number>;
  out14: Record<string, number>;
  out30: Record<string, number>;
};

type TrxRow = {
  trxId?: string | number;
  trxDate: string;
  productId: string | number;
  trxType: string;
  qty?: string | number;
  signedQty?: string | number;
};

function fmtYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function subDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() - days);
  return d;
}

async function fetchIssueRange(fromYmd: string, toYmd: string): Promise<TrxRow[]> {
  const url = `${DATA_PROXY}/api/inventorytransaction?trxType=ISSUE&from=${encodeURIComponent(fromYmd)}&to=${encodeURIComponent(toYmd)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch ISSUE transactions: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data as TrxRow[] : [];
}

function groupSumByProduct(rows: TrxRow[]): Record<string, number> {
  const acc: Record<string, number> = {};
  for (const r of rows) {
    if (String(r.trxType).trim().toUpperCase() !== 'ISSUE') continue;
    const pid = String(r.productId ?? '');
    if (!pid) continue;
    // Prefer qty per requirement; convert string to number with parseInt
    let q = 0;
    if (typeof r.qty !== 'undefined') {
      const parsed = parseInt(String(r.qty), 10);
      q = Number.isFinite(parsed) ? parsed : 0;
    } else if (typeof r.signedQty !== 'undefined') {
      const parsed = parseInt(String(r.signedQty), 10);
      q = Number.isFinite(parsed) ? Math.abs(parsed) : 0;
    }
    acc[pid] = (acc[pid] ?? 0) + q;
  }
  return acc;
}

export async function fetchIssueOutMaps(opts?: { today?: Date | string }): Promise<OutMaps> {
  const today = opts?.today instanceof Date
    ? opts.today
    : (opts?.today ? new Date(String(opts.today)) : new Date());
  const toYmd = fmtYmd(today);

  const from7 = fmtYmd(subDays(today, 7));
  const from14 = fmtYmd(subDays(today, 14));
  const from30 = fmtYmd(subDays(today, 30));

  const [r7, r14, r30] = await Promise.all([
    fetchIssueRange(from7, toYmd),
    fetchIssueRange(from14, toYmd),
    fetchIssueRange(from30, toYmd),
  ]);

  return {
    out7: groupSumByProduct(r7),
    out14: groupSumByProduct(r14),
    out30: groupSumByProduct(r30),
  };
}

