import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import {
  loadDomainData,
  computeInventoryHealth,
  type DaysWindow,
  type ComputedItem,
} from "@/lib/inventoryHealth";
import { getDeepseekClient, safeParseInsights } from "@/lib/deepseek";
import { buildActionGroups, formatVerdict } from "@/lib/insightHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** =========================
 *  AUTH / TRIGGER
 *  ========================= */
function okToRun(req: NextRequest): boolean {
  const vercelCron = req.headers.get("x-vercel-cron") === "1";

  // manual trigger: pakai Authorization header
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.CRON_SECRET || "";
  const manualOk = secret && auth === `Bearer ${secret}`;

  // allow local dev
  const localOk = process.env.NODE_ENV !== "production";

  return vercelCron || manualOk || localOk;
}

/** =========================
 *  UTILS
 *  ========================= */
function fmtJakarta(dt: Date): string {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(dt);
  } catch {
    return dt.toISOString();
  }
}

function htmlEscape(s: string) {
  return String(s ?? "").replace(
    /[&<>\"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)
  );
}

// Resolve a usable Date from possible date-like fields
function resolveTrxDate(obj: any): Date {
  const cand =
    obj?.trxDate ??
    obj?.trxAt ??
    obj?.postedAt ??
    obj?.createdAt ??
    obj?.updatedAt;

  if (!cand) return new Date(0);

  if (cand instanceof Date) return isNaN(cand.getTime()) ? new Date(0) : cand;

  let s = String(cand).trim();

  // "YYYY-MM-DD HH:mm:ss" -> "YYYY-MM-DDTHH:mm:ss+07:00"
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
    s = s.replace(" ", "T") + "+07:00";
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/** =========================
 *  OUT MAPS (DETERMINISTIC)
 *  hitung OUT 7/14/30 langsung dari normalizedTransactions
 *  ========================= */
type OutMaps = {
  out7: Record<string, number>;
  out14: Record<string, number>;
  out30: Record<string, number>;
};

function buildOutMapsFromTransactions(txs: any[], now = new Date()): OutMaps {
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const d14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const out7: Record<string, number> = {};
  const out14: Record<string, number> = {};
  const out30: Record<string, number> = {};

  for (const t of txs) {
    const type = String(t.trxType ?? "").toUpperCase();
    if (type !== "ISSUE") continue; // outbound sudah kamu map -> ISSUE

    const pid = String(t.productId ?? "");
    if (!pid) continue;

    const dt = t.trxDate instanceof Date ? t.trxDate : new Date(t.trxDate);
    if (isNaN(dt.getTime())) continue;

    const q =
      t.signedQty != null
        ? Math.abs(Number(t.signedQty))
        : t.qty != null
        ? Math.abs(Number(t.qty))
        : 0;

    if (!Number.isFinite(q) || q <= 0) continue;

    if (dt >= d30) out30[pid] = (out30[pid] ?? 0) + q;
    if (dt >= d14) out14[pid] = (out14[pid] ?? 0) + q;
    if (dt >= d7) out7[pid] = (out7[pid] ?? 0) + q;
  }

  return { out7, out14, out30 };
}

/** =========================
 *  EMAIL HTML
 *  ========================= */
function renderEmailHtml(opts: {
  windowDays: DaysWindow;
  kpis: {
    total: number;
    low: number;
    over: number;
    worst?: { sku: string; name: string; daysLeft: number } | null;
  };
  lowTop: {
    sku: string;
    name: string;
    qtyOnHand: number;
    safetyStock: number;
    daysLeft: number | null;
    out7: number;
    out14: number;
  }[];
  overTop: {
    sku: string;
    name: string;
    qtyOnHand: number;
    safetyStock: number;
    out7: number;
    out14: number;
  }[];
  dashboardUrl?: string | null;
  ai?: {
    executiveSummary: string | null;
    insights: string[];
    actions: string[];
  } | null;
  draft?: {
    sku: string;
    name: string;
    reason: string;
    priority: "High" | "Medium";
    recommended: number;
  }[];
  hideConsumption?: boolean;
  coverage?: {
    sku: string;
    name: string;
    qtyOnHand: number;
    avgDailyOut: number | null;
    daysLeft: number | null;
    targetDays: number;
    needed: number;
  }[];
}): string {
  const {
    windowDays,
    kpis,
    lowTop,
    overTop,
    dashboardUrl,
    ai,
    draft,
    hideConsumption,
    coverage = [],
  } = opts;

  const dt = fmtJakarta(new Date());
  const link =
    dashboardUrl || process.env.APP_BASE_URL
      ? `${process.env.APP_BASE_URL}/dashboard/inventory-health`
      : "/dashboard/inventory-health";

  const lowRows = lowTop
    .map(
      (i) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${htmlEscape(
        i.sku
      )}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${htmlEscape(
        i.name
      )}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
        i.qtyOnHand
      }</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
        i.safetyStock
      }</td>
      ${
        hideConsumption
          ? ""
          : `<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
              i.daysLeft !== null ? Math.max(0, Math.floor(i.daysLeft)) : "—"
            }</td>
             <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
               i.out7
             }</td>
             <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
               i.out14
             }</td>`
      }
    </tr>`
    )
    .join("");

  const overRows = overTop
    .map(
      (i) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${htmlEscape(
        i.sku
      )}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${htmlEscape(
        i.name
      )}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
        i.qtyOnHand
      }</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
        i.safetyStock
      }</td>
      ${
        hideConsumption
          ? ""
          : `<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${i.out7}</td>
             <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${i.out14}</td>`
      }
    </tr>`
    )
    .join("");

  const aiSection = (() => {
    if (!ai) return "";
    const exec = ai.executiveSummary
      ? `<p style="margin:6px 0;color:#111;font-size:13px">${htmlEscape(
          ai.executiveSummary
        )}</p>`
      : "";

    const insights = (ai.insights || [])
      .slice(0, 5)
      .map((s) => `<li>${htmlEscape(s)}</li>`)
      .join("");

    const actions = (ai.actions || [])
      .slice(0, 5)
      .map((s) => `<li>${htmlEscape(s)}</li>`)
      .join("");

    return `
      <h3 style="margin:18px 0 6px 0;font-size:14px">AI Insights</h3>
      ${exec}
      ${
        insights
          ? `<div style="margin-top:6px">
               <div style="color:#666;font-size:12px">Insights:</div>
               <ul style="margin:6px 0 0 18px;font-size:12px;color:#111">${insights}</ul>
             </div>`
          : ""
      }
      ${
        actions
          ? `<div style="margin-top:6px">
               <div style="color:#666;font-size:12px">Actions:</div>
               <ul style="margin:6px 0 0 18px;font-size:12px;color:#111">${actions}</ul>
             </div>`
          : ""
      }
    `;
  })();

  const draftRows = (draft || [])
    .map(
      (r) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${htmlEscape(
        r.sku
      )}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${htmlEscape(
        r.name
      )}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;font-size:12px">
        <span style="display:inline-block;padding:2px 6px;border-radius:10px;background:${
          r.priority === "High" ? "#fee2e2" : "#fef9c3"
        };color:${r.priority === "High" ? "#991b1b" : "#92400e"}">
          ${r.priority}
        </span>
      </td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
        r.recommended
      }</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${htmlEscape(
        r.reason
      )}</td>
    </tr>`
    )
    .join("");

  const coverageRows = (coverage || [])
    .map(
      (c) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${htmlEscape(
        c.sku
      )}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${htmlEscape(
        c.name
      )}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
        c.qtyOnHand
      }</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
        c.avgDailyOut != null && isFinite(c.avgDailyOut)
          ? Number(c.avgDailyOut.toFixed(2))
          : "—"
      }</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
        c.daysLeft !== null && isFinite(c.daysLeft)
          ? Math.max(0, Math.floor(c.daysLeft))
          : "—"
      }</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
        c.targetDays
      }</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:12px">${
        c.needed
      }</td>
    </tr>`
    )
    .join("");

  return `
  <div style="font-family:Inter,Arial,sans-serif;color:#111">
    <h2 style="margin:0 0 8px 0">Inventory Health Report</h2>
    <div style="color:#555;font-size:12px">Waktu (WIB): ${dt} • Window: ${windowDays} hari</div>

    <div style="margin-top:12px;padding:10px;border:1px solid #e5e7eb;border-radius:8px">
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div><div style="color:#666;font-size:12px">Total Analyzed</div><div style="font-size:18px;font-weight:600">${
          kpis.total
        }</div></div>
        <div><div style="color:#666;font-size:12px">Low Stock</div><div style="font-size:18px;font-weight:600">${
          kpis.low
        }</div></div>
        <div><div style="color:#666;font-size:12px">Overstock</div><div style="font-size:18px;font-weight:600">${
          kpis.over
        }</div></div>
        ${
          kpis.worst
            ? `<div><div style="color:#666;font-size:12px">Worst Risk</div><div style="font-size:14px;font-weight:600">${htmlEscape(
                kpis.worst.name
              )} (${htmlEscape(kpis.worst.sku)}) • ~${Math.max(
                0,
                Math.floor(kpis.worst.daysLeft)
              )} hari</div></div>`
            : ""
        }
      </div>
    </div>

    <h3 style="margin:18px 0 6px 0;font-size:14px">Top Low Stock</h3>
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">SKU</th>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Nama</th>
          <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Stok</th>
          <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Stok Aman</th>
          ${
            hideConsumption
              ? ""
              : `<th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Sisa Hari</th>
                 <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Out 7d</th>
                 <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Out 14d</th>`
          }
        </tr>
      </thead>
      <tbody>${
        lowRows ||
        `<tr><td colspan="${
          hideConsumption ? "4" : "7"
        }" style="padding:8px;color:#666">—</td></tr>`
      }</tbody>
    </table>

    ${aiSection}

    <h3 style="margin:18px 0 6px 0;font-size:14px">Draft Purchase Plan</h3>
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">SKU</th>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Nama</th>
          <th style="text-align:center;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Prioritas</th>
          <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Recommended Qty</th>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Alasan</th>
        </tr>
      </thead>
      <tbody>${
        draftRows ||
        `<tr><td colspan="5" style="padding:8px;color:#666">—</td></tr>`
      }</tbody>
    </table>

    <h3 style="margin:18px 0 6px 0;font-size:14px">Coverage & Kebutuhan (Target Hari)</h3>
    <div style="color:#666;font-size:12px;margin-bottom:4px">
      Penjelasan: Berdasarkan stok saat ini dan laju pemakaian rata-rata (prioritas 7 hari, fallback 14 hari), berikut estimasi sisa hari stok dan kebutuhan produksi/pembelian agar cukup.
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">SKU</th>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Nama</th>
          <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Stok Saat Ini</th>
          <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Rata-rata/Hari</th>
          <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Sisa Hari</th>
          <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Target Hari</th>
          <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Kebutuhan</th>
        </tr>
      </thead>
      <tbody>${
        coverageRows ||
        `<tr><td colspan="7" style="padding:8px;color:#666">—</td></tr>`
      }</tbody>
    </table>

    <h3 style="margin:18px 0 6px 0;font-size:14px">Top Overstock</h3>
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">SKU</th>
          <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Nama</th>
          <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Stok</th>
          <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Stok Aman</th>
          ${
            hideConsumption
              ? ""
              : `<th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Out 7d</th>
                 <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Out 14d</th>`
          }
        </tr>
      </thead>
      <tbody>${
        overRows ||
        `<tr><td colspan="${
          hideConsumption ? "4" : "6"
        }" style="padding:8px;color:#666">—</td></tr>`
      }</tbody>
    </table>

    <div style="margin-top:16px">
      <a href="${link}" style="display:inline-block;padding:8px 12px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;font-size:12px">
        Buka Dashboard
      </a>
    </div>
  </div>`;
}

/** =========================
 *  SMTP
 *  ========================= */
async function sendEmailSMTP({
  subject,
  html,
}: {
  subject: string;
  html: string;
}) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || "465");
  const secure = String(process.env.SMTP_SECURE || "true") === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM;
  const to = process.env.EMAIL_TO;

  if (!host || !user || !pass || !from || !to) {
    throw new Error(
      "SMTP env vars missing (SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_TO)"
    );
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const recipients = to
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const info = await transporter.sendMail({
    from,
    to: recipients,
    subject,
    html,
    text: "Lihat versi HTML untuk ringkasan lengkap.",
  });

  return info?.messageId || "sent";
}

/** =========================
 *  MAIN JOB
 *  ========================= */
async function runJob(windowDays: DaysWindow = 30) {
  const reportWarehouseId =
    process.env.REPORT_WAREHOUSE_ID &&
    String(process.env.REPORT_WAREHOUSE_ID).trim() !== ""
      ? String(process.env.REPORT_WAREHOUSE_ID)
      : undefined;

  const { balances, products, transactions } = await loadDomainData({
    warehouseId: reportWarehouseId ?? undefined,
  });

  // Build SKU -> productId map for fallback matching
  const skuToPid = new Map<string, string>();
  try {
    for (const p of products as any[]) {
      if (p?.sku && p?.id) skuToPid.set(String(p.sku), String(p.id));
    }
  } catch {}

  // Normalize transactions
  const normalizedTransactions = (transactions as any[]).map((t: any) => {
    const rawType = String(t.trxType ?? "")
      .trim()
      .toUpperCase();

    const isOut = ["ISSUE", "OUT", "SHIP", "CONSUME"].includes(rawType);
    const isIn = ["RECEIPT", "IN", "RECV", "BUY", "PURCHASE"].includes(rawType);

    // Keep computeInventoryHealth compatibility
    const normType = isOut ? "ISSUE" : isIn ? "RECEIPT" : rawType;

    const qty = t.qty != null ? Number(t.qty) : 0;
    let signedQty = t.signedQty != null ? Number(t.signedQty) : null;

    if (signedQty == null && Number.isFinite(qty)) {
      signedQty = isOut ? -Math.abs(qty) : isIn ? Math.abs(qty) : qty;
    }

    const trxDate = resolveTrxDate(t);

    // Normalize productId via sku if missing
    let productId =
      t.productId != null && String(t.productId) !== ""
        ? String(t.productId)
        : undefined;

    if (!productId && t?.sku) {
      const pid = skuToPid.get(String(t.sku));
      if (pid) productId = pid;
    }

    return {
      ...t,
      productId: String(productId ?? t.productId ?? ""),
      trxType: normType,
      signedQty,
      trxDate,
    };
  });

  // Compute base health
  const res = computeInventoryHealth({
    balances,
    products,
    transactions: normalizedTransactions as any,
    windowDays,
  });

  // Deterministic out maps from same normalizedTransactions
  const outMaps = buildOutMapsFromTransactions(normalizedTransactions);

  function withOutOverrides(row: ComputedItem): ComputedItem {
    const v7 = outMaps.out7[row.productId] ?? 0;
    const v14 = outMaps.out14[row.productId] ?? 0;
    const v30 = outMaps.out30[row.productId] ?? 0;

    const outQty_7 = v7;
    const outQty_14 = v14;
    const outQty_30 = v30;

    // avgDailyOut priority: 7d -> 14d -> 30d
    let avgDailyOut = 0;
    if (outQty_7 > 0) avgDailyOut = outQty_7 / 7;
    else if (outQty_14 > 0) avgDailyOut = outQty_14 / 14;
    else if (outQty_30 > 0) avgDailyOut = outQty_30 / 30;

    const daysLeft = avgDailyOut > 0 ? row.qtyOnHand / avgDailyOut : null;

    return { ...row, outQty_7, outQty_14, outQty_30, avgDailyOut, daysLeft };
  }

  const lowOverLow = res.lowStock.map(withOutOverrides);
  const lowOverOver = res.overStock.map(withOutOverrides);

  const hideConsumption = [...lowOverLow, ...lowOverOver].every(
    (x) =>
      (x.outQty_7 ?? 0) === 0 &&
      (x.outQty_14 ?? 0) === 0 &&
      (x.outQty_30 ?? 0) === 0 &&
      (x.avgDailyOut ?? 0) === 0
  );

  // KPIs
  const kpis = {
    total: res.summary.totalProductsAnalyzed,
    low: res.summary.lowStockCount,
    over: res.summary.overStockCount,
    worst: res.summary.worstRisk
      ? {
          sku: res.summary.worstRisk.sku,
          name: res.summary.worstRisk.name,
          daysLeft: res.summary.worstRisk.daysLeft,
        }
      : null,
  };

  // Email tables (7/14 focus)
  const lowTop = lowOverLow.slice(0, 5).map((i) => ({
    sku: i.sku,
    name: i.name,
    qtyOnHand: i.qtyOnHand,
    safetyStock: i.safetyStock,
    daysLeft: i.daysLeft,
    out7: i.outQty_7 ?? 0,
    out14: i.outQty_14 ?? 0,
  }));

  const overTop = lowOverOver.slice(0, 5).map((i) => ({
    sku: i.sku,
    name: i.name,
    qtyOnHand: i.qtyOnHand,
    safetyStock: i.safetyStock,
    out7: i.outQty_7 ?? 0,
    out14: i.outQty_14 ?? 0,
  }));

  // Coverage calculation (target days)
  const targetDaysEnv = Number(process.env.REPORT_TARGET_DAYS || "14");
  const targetDays =
    Number.isFinite(targetDaysEnv) && targetDaysEnv > 0
      ? Math.min(60, Math.max(1, Math.floor(targetDaysEnv)))
      : 14;

  const coverage = lowOverLow.slice(0, 8).map((i) => {
    const avg = (i.avgDailyOut ?? 0) > 0 ? i.avgDailyOut : null;
    const available = Math.max(0, (i.qtyOnHand ?? 0) - (i.qtyReserved ?? 0));
    const needed =
      avg != null ? Math.ceil(Math.max(0, targetDays * avg - available)) : 0;

    return {
      sku: i.sku,
      name: i.name,
      qtyOnHand: i.qtyOnHand,
      avgDailyOut: avg,
      daysLeft: i.daysLeft,
      targetDays,
      needed,
    };
  });

  /** =========================
   * AI Insights (DeepSeek)
   * ========================= */
  let ai: {
    executiveSummary: string | null;
    insights: string[];
    actions: string[];
  } | null = null;

  try {
    const client = getDeepseekClient();

    const system = `Anda adalah AI Inventory Analyst.
Wajib keluarkan JSON ketat:
{ "executiveSummary": string|null, "insights": string[], "actions": string[], "itemNote": {"why": string, "action": string}|null }
Bahasa Indonesia.
Jangan mengarang angka; pakai field yang diberikan.
Gunakan istilah: stok saat ini, stok aman, batas pesan ulang${
      hideConsumption ? "" : ", sisa hari stok"
    }.
${
  hideConsumption
    ? "Hindari menyimpulkan laju konsumsi; fokus stok vs batas."
    : ""
}`;

    function slim(item: ComputedItem) {
      const base: any = {
        sku: item.sku,
        name: item.name,
        qtyOnHand: item.qtyOnHand,
        safetyStock: item.safetyStock,
        reorderPoint: item.reorderPoint,
        outQty_7: item.outQty_7,
        outQty_14: item.outQty_14,
        avgDailyOut: item.avgDailyOut,
        daysLeft: item.daysLeft,
      };
      if (hideConsumption) {
        delete base.avgDailyOut;
        delete base.daysLeft;
      }
      return base;
    }

    const lowSlim = lowOverLow.slice(0, 10).map(slim);
    const overSlim = lowOverOver.slice(0, 10).map(slim);

    const user = `Konteks: windowDays=${windowDays}, warehouse=${
      reportWarehouseId ?? "All"
    }

Top LowStock:
${JSON.stringify(lowSlim, null, 2)}

Top OverStock:
${JSON.stringify(overSlim, null, 2)}

Instruksi: Analisis dan keluarkan JSON.`;

    const chat = await client.chat.completions.create({
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" as any },
    } as any);

    const content = chat.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseInsights(content);

    ai = {
      executiveSummary: parsed.executiveSummary,
      insights: parsed.insights,
      actions: parsed.actions,
    };
  } catch {
    const verdict = formatVerdict(lowOverLow as any, lowOverOver as any);
    const ag = buildActionGroups(lowOverLow as any, lowOverOver as any);

    ai = {
      executiveSummary: verdict.text,
      insights: [
        res.lowStock.length
          ? "Ada item stok menipis/risiko stockout; perlu perhatian cepat."
          : "Tidak ada stok menipis signifikan.",
        res.overStock.length
          ? "Sejumlah item berlebih; optimalkan ruang dan modal."
          : "Tidak ada overstock signifikan.",
      ],
      actions: [
        ag.reorder.length
          ? `Reorder segera: ${ag.reorder.slice(0, 5).join(", ")}`
          : "",
        ag.monitor.length
          ? `Pantau dekat: ${ag.monitor.slice(0, 5).join(", ")}`
          : "",
        ag.reduce.length
          ? `Kurangi stok: ${ag.reduce.slice(0, 5).join(", ")}`
          : "",
      ].filter(Boolean),
    };
  }

  /** =========================
   * Draft Purchase Plan
   * ========================= */
  function getAutoParams(item: ComputedItem): { lead: number; buffer: number } {
    // avgDailyOut sudah prioritas 7d->14d->30d
    const avg = Math.max(0, item.avgDailyOut ?? 0);
    let lead = 7;
    let buffer = 3;
    if (avg <= 0) buffer = 2;
    else buffer = 3;
    return { lead, buffer };
  }

  function computeRecommendedQty(item: ComputedItem): number {
    const { lead, buffer } = getAutoParams(item);

    const available = Math.max(
      0,
      (item.qtyOnHand ?? 0) - (item.qtyReserved ?? 0)
    );

    const avg = Math.max(0, item.avgDailyOut ?? 0);
    const baseTarget = Math.max(item.safetyStock ?? 0, item.reorderPoint ?? 0);

    let targetLevel = baseTarget;

    const isStockout = (item.qtyOnHand ?? 0) === 0;

    if (isStockout) {
      targetLevel =
        (item.safetyStock ?? baseTarget) +
        avg * (Math.max(0, lead) + Math.max(0, buffer));
    } else if (avg > 0) {
      targetLevel = baseTarget + avg * Math.max(0, buffer);
    } else {
      targetLevel = baseTarget;
    }

    const needed = Math.ceil(Math.max(0, targetLevel - available));
    return Number.isFinite(needed) ? needed : 0;
  }

  const stockout = lowOverLow.filter((i) => i.qtyOnHand === 0);

  const lowBuffer = lowOverLow.filter(
    (i) =>
      i.qtyOnHand > 0 &&
      i.qtyOnHand <= (i.safetyStock ?? 0) &&
      i.daysLeft !== null &&
      Math.floor(i.daysLeft) <= 7
  );

  const draft = [
    ...stockout.map((i) => ({
      sku: i.sku,
      name: i.name,
      reason: "Stok habis; top-up ke level aman + buffer.",
      priority: "High" as const,
      recommended: computeRecommendedQty(i),
    })),
    ...lowBuffer.map((i) => ({
      sku: i.sku,
      name: i.name,
      reason:
        i.daysLeft !== null
          ? `Stok menipis (sisa ~${Math.max(0, Math.floor(i.daysLeft))} hari).`
          : "Stok menipis.",
      priority: "Medium" as const,
      recommended: computeRecommendedQty(i),
    })),
  ].slice(0, 20);

  // Render email + send
  const html = renderEmailHtml({
    windowDays,
    kpis,
    lowTop,
    overTop,
    dashboardUrl: process.env.APP_BASE_URL || null,
    ai,
    draft,
    hideConsumption,
    coverage,
  });

  const subject = `Inventory Health Report • ${fmtJakarta(new Date())} WIB`;
  const messageId = await sendEmailSMTP({ subject, html });

  return {
    messageId,
    kpis,
    counts: { low: lowTop.length, over: overTop.length },
  };
}

/** =========================
 *  ROUTES
 *  ========================= */
export async function GET(req: NextRequest) {
  const vercelCron = req.headers.get("x-vercel-cron");
  const env = process.env.NODE_ENV;

  try {
    console.log("[cron] invoke", {
      xVercelCron: req.headers.get("x-vercel-cron"),
      hasAuth: !!req.headers.get("authorization"),
      env,
    });
  } catch {}

  if (!okToRun(req)) {
    try {
      console.warn("[cron] unauthorized", { vercelCron: !!vercelCron, env });
    } catch {}
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // kamu boleh tetap 30 (deteksi overstock), tapi rate konsumsi pakai 7/14
    const out = await runJob(30);

    try {
      console.log("[cron] sent", {
        kpis: out.kpis,
        counts: out.counts,
        smtp: {
          host: process.env.SMTP_HOST,
          port: process.env.SMTP_PORT,
          secure: process.env.SMTP_SECURE,
          from: process.env.EMAIL_FROM,
          toCount: (process.env.EMAIL_TO || "").split(",").filter(Boolean)
            .length,
        },
        warehouse: process.env.REPORT_WAREHOUSE_ID || "ALL",
      });
    } catch {}

    return NextResponse.json({ ok: true, ...out });
  } catch (e: any) {
    try {
      console.error("[cron] error", e?.message || e, e?.stack || "");
    } catch {}
    return NextResponse.json(
      { ok: false, error: e?.message || "Send failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
