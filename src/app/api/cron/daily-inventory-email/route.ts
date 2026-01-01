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
import { fetchIssueOutMaps, type OutMaps } from "@/lib/outIssues";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  return s.replace(
    /[&<>\"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)
  );
}

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
  }[];
  overTop: {
    sku: string;
    name: string;
    qtyOnHand: number;
    safetyStock: number;
    outQty_30: number;
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
}): string {
  const { windowDays, kpis, lowTop, overTop, dashboardUrl, ai, draft } = opts;
  const dt = fmtJakarta(new Date());
  const link =
    dashboardUrl || process.env.APP_BASE_URL
      ? `${process.env.APP_BASE_URL}/dashboard/inventory-health`
      : "/dashboard/inventory-health";

  const lowRows = lowTop
    .map(
      (i) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:Inter,Arial,sans-serif;font-size:12px">${htmlEscape(
        i.sku
      )}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:Inter,Arial,sans-serif;font-size:12px">${htmlEscape(
        i.name
      )}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-family:Inter,Arial,sans-serif;font-size:12px">${
        i.qtyOnHand
      }</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-family:Inter,Arial,sans-serif;font-size:12px">${
        i.safetyStock
      }</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-family:Inter,Arial,sans-serif;font-size:12px">${
        i.daysLeft !== null ? Math.max(0, Math.floor(i.daysLeft)) : "—"
      }</td>
    </tr>`
    )
    .join("");

  const overRows = overTop
    .map(
      (i) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:Inter,Arial,sans-serif;font-size:12px">${htmlEscape(
        i.sku
      )}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:Inter,Arial,sans-serif;font-size:12px">${htmlEscape(
        i.name
      )}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-family:Inter,Arial,sans-serif;font-size:12px">${
        i.qtyOnHand
      }</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-family:Inter,Arial,sans-serif;font-size:12px">${
        i.safetyStock
      }</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-family:Inter,Arial,sans-serif;font-size:12px">${
        i.outQty_30
      }</td>
    </tr>`
    )
    .join("");

  const aiSection = (() => {
    if (!ai) return "";
    const exec = ai.executiveSummary
      ? `<p style=\"margin:6px 0;color:#111;font-size:13px\">${htmlEscape(
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
      <h3 style=\"margin:18px 0 6px 0;font-size:14px\">AI Insights</h3>
      ${exec}
      ${
        insights
          ? `<div style=\"margin-top:6px\"><div style=\"color:#666;font-size:12px\">Insights:</div><ul style=\"margin:6px 0 0 18px;font-size:12px;color:#111\">${insights}</ul></div>`
          : ""
      }
      ${
        actions
          ? `<div style=\"margin-top:6px\"><div style=\"color:#666;font-size:12px\">Actions:</div><ul style=\"margin:6px 0 0 18px;font-size:12px;color:#111\">${actions}</ul></div>`
          : ""
      }
    `;
  })();

  const draftRows = (draft || [])
    .map(
      (r) => `
    <tr>
      <td style=\"padding:6px 8px;border-bottom:1px solid #eee;font-family:Inter,Arial,sans-serif;font-size:12px\">${htmlEscape(
        r.sku
      )}</td>
      <td style=\"padding:6px 8px;border-bottom:1px solid #eee;font-family:Inter,Arial,sans-serif;font-size:12px\">${htmlEscape(
        r.name
      )}</td>
      <td style=\"padding:6px 8px;border-bottom:1px solid #eee;text-align:center;font-family:Inter,Arial,sans-serif;font-size:12px\"><span style=\"display:inline-block;padding:2px 6px;border-radius:10px;background:${
        r.priority === "High" ? "#fee2e2" : "#fef9c3"
      };color:${r.priority === "High" ? "#991b1b" : "#92400e"}\">${
        r.priority
      }</span></td>
      <td style=\"padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-family:Inter,Arial,sans-serif;font-size:12px\">${
        r.recommended
      }</td>
      <td style=\"padding:6px 8px;border-bottom:1px solid #eee;font-family:Inter,Arial,sans-serif;font-size:12px\">${htmlEscape(
        r.reason
      )}</td>
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
            ? `<div><div style=\"color:#666;font-size:12px\">Worst Risk</div><div style=\"font-size:14px;font-weight:600\">${htmlEscape(
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
          <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Sisa Hari</th>
        </tr>
      </thead>
      <tbody>${
        lowRows ||
        `<tr><td colspan=\"5\" style=\"padding:8px;color:#666\">—</td></tr>`
      }</tbody>
    </table>

    ${aiSection}

    <h3 style=\"margin:18px 0 6px 0;font-size:14px\">Draft Purchase Plan</h3>
    <table style=\"width:100%;border-collapse:collapse\">
      <thead>
        <tr>
          <th style=\"text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666\">SKU</th>
          <th style=\"text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666\">Nama</th>
          <th style=\"text-align:center;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666\">Prioritas</th>
          <th style=\"text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666\">Recommended Qty</th>
          <th style=\"text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666\">Alasan</th>
        </tr>
      </thead>
      <tbody>${
        draftRows ||
        `<tr><td colspan=\"5\" style=\"padding:8px;color:#666\">—</td></tr>`
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
          <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#666">Out 30d</th>
        </tr>
      </thead>
      <tbody>${
        overRows ||
        `<tr><td colspan=\"5\" style=\"padding:8px;color:#666\">—</td></tr>`
      }</tbody>
    </table>

    <div style="margin-top:16px"><a href="${link}" style="display:inline-block;padding:8px 12px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;font-size:12px">Buka Dashboard</a></div>
  </div>`;
}

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

async function runJob(windowDays: DaysWindow = 30) {
  const reportWarehouseId =
    process.env.REPORT_WAREHOUSE_ID &&
    String(process.env.REPORT_WAREHOUSE_ID).trim() !== ""
      ? String(process.env.REPORT_WAREHOUSE_ID)
      : undefined;
  const { balances, products, transactions } = await loadDomainData({
    warehouseId: reportWarehouseId ?? undefined,
  });

  // Normalize transactions before computing health
  const rawSamples = transactions.slice(0, 3).map((t: any) => ({
    pid: t.productId,
    type: t.trxType,
    qty: t.qty,
    signed: t.signedQty,
  }));
  try {
    console.log("[cron] trx samples raw", rawSamples);
  } catch {}
  const normalizedTransactions = transactions.map((t: any) => {
    const rawType = String(t.trxType ?? t.trxType ?? "")
      .trim()
      .toUpperCase();

    const isOut = ["ISSUE", "OUT", "SHIP", "CONSUME"].includes(rawType);
    const isIn = ["RECEIPT", "IN", "RECV", "BUY", "PURCHASE"].includes(rawType);

    const normType = isOut ? "OUT" : isIn ? "IN" : rawType;

    const qty = t.qty != null ? Number(t.qty) : 0;
    let signedQty = t.signedQty != null ? Number(t.signedQty) : null;

    if (signedQty == null && Number.isFinite(qty)) {
      signedQty = isOut ? -Math.abs(qty) : isIn ? Math.abs(qty) : qty;
    }

    return {
      ...t,
      trxType: normType, // untuk computeInventoryHealth
      signedQty,
    };
  });

  // optional debug
  try {
    console.log("[cron] trx raw sample", transactions.slice(0, 2));
    console.log(
      "[cron] trx normalized sample",
      normalizedTransactions.slice(0, 2)
    );
  } catch {}

  const normSamples = (normalizedTransactions as any[])
    .slice(0, 3)
    .map((t: any) => ({
      pid: t.productId,
      type: t.trxType,
      qty: t.qty,
      signed: t.signedQty,
    }));
  try {
    console.log("[cron] trx samples normalized", normSamples);
  } catch {}

  const res = computeInventoryHealth({
    balances,
    products,
    transactions: normalizedTransactions as any,
    windowDays,
  });
  let outMaps: OutMaps | null = null;
  try {
    outMaps = await fetchIssueOutMaps({ warehouseId: reportWarehouseId });
  } catch {
    outMaps = null;
  }

  function withOutOverrides(row: ComputedItem): ComputedItem {
    if (!outMaps) return row;
    const v7 = outMaps.out7[row.productId];
    const v14 = outMaps.out14[row.productId];
    const v30 = outMaps.out30[row.productId];
    const outQty_7 = typeof v7 === "number" ? v7 : row.outQty_7;
    const outQty_14 = typeof v14 === "number" ? v14 : row.outQty_14;
    const outQty_30 = typeof v30 === "number" ? v30 : row.outQty_30;
    let avgDailyOut = 0;
    if (outQty_7 > 0) avgDailyOut = outQty_7 / 7;
    else if (outQty_14 > 0) avgDailyOut = outQty_14 / 14;
    else if (outQty_30 > 0) avgDailyOut = outQty_30 / 30;
    const daysLeft = avgDailyOut > 0 ? row.qtyOnHand / avgDailyOut : null;
    return { ...row, outQty_7, outQty_14, outQty_30, avgDailyOut, daysLeft };
  }

  const lowOverLow = res.lowStock.map(withOutOverrides);
  const lowOverOver = res.overStock.map(withOutOverrides);
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
  const lowTop = lowOverLow.slice(0, 5).map((i) => ({
    sku: i.sku,
    name: i.name,
    qtyOnHand: i.qtyOnHand,
    safetyStock: i.safetyStock,
    daysLeft: i.daysLeft,
  }));
  const overTop = lowOverOver.slice(0, 5).map((i) => ({
    sku: i.sku,
    name: i.name,
    qtyOnHand: i.qtyOnHand,
    safetyStock: i.safetyStock,
    outQty_30: i.outQty_30,
  }));
  // Build AI insights (try DeepSeek, else fallback deterministic)
  let ai: {
    executiveSummary: string | null;
    insights: string[];
    actions: string[];
  } | null = null;
  try {
    const client = getDeepseekClient();
    const system = `Anda adalah AI Inventory Analyst. Wajib keluarkan JSON ketat { "executiveSummary": string|null, "insights": string[], "actions": string[], "itemNote": {"why": string, "action": string}|null } dalam Bahasa Indonesia, gunakan istilah: stok saat ini, stok aman, batas pesan ulang, sisa hari stok. Jangan mengarang angka; pakai field yang diberikan.`;
    function slim(item: ComputedItem) {
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
    const lowSlim = lowOverLow.slice(0, 10).map(slim);
    const overSlim = lowOverOver.slice(0, 10).map(slim);
    const user = `Konteks: windowDays=${windowDays}, warehouse=All\n\nTop LowStock:\n${JSON.stringify(
      lowSlim,
      null,
      2
    )}\n\nTop OverStock:\n${JSON.stringify(
      overSlim,
      null,
      2
    )}\n\nInstruksi: Analisis dan keluarkan JSON.`;
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
    // Fallback summary using helpers
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

  // Build Draft Purchase Plan (server-side mirror of UI logic)
  function getAutoParams(item: ComputedItem): { lead: number; buffer: number } {
    const avg7 = (item.outQty_7 ?? 0) / 7;
    const avg30 = (item.outQty_30 ?? 0) / 30;
    let lead = 7;
    let buffer = 3;
    if (avg30 <= 0 && avg7 <= 0) buffer = 2;
    else if (avg7 > avg30 * 1.3) buffer = 5;
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
    if (isStockout)
      targetLevel =
        (item.safetyStock ?? baseTarget) +
        avg * (Math.max(0, lead) + Math.max(0, buffer));
    else if (avg > 0) targetLevel = baseTarget + avg * Math.max(0, buffer);
    else targetLevel = baseTarget;
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

  const html = renderEmailHtml({
    windowDays,
    kpis,
    lowTop,
    overTop,
    dashboardUrl: process.env.APP_BASE_URL || null,
    ai,
    draft,
  });
  const subject = `Inventory Health Report • ${fmtJakarta(new Date())} WIB`;
  const messageId = await sendEmailSMTP({ subject, html });
  return {
    messageId,
    kpis,
    counts: { low: lowTop.length, over: overTop.length },
  };
}

export async function GET(req: NextRequest) {
  const vercelCron = req.headers.get("x-vercel-cron");
  const hasSecret = !!req.headers.get("x-cron-secret");
  const env = process.env.NODE_ENV;
  try {
    console.log("[cron] invoke", { vercelCron: !!vercelCron, hasSecret, env });
    console.log("[cron] invoke", {
      xVercelCron: req.headers.get("x-vercel-cron"),
      hasAuth: !!req.headers.get("authorization"),
      hasXSecret: !!req.headers.get("x-cron-secret"),
      env: process.env.NODE_ENV,
    });
  } catch {}
  if (!okToRun(req)) {
    try {
      console.warn("[cron] unauthorized", {
        vercelCron: !!vercelCron,
        hasSecret,
        env,
      });
    } catch {}
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
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
