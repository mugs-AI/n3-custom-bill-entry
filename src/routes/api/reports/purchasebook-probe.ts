import { createFileRoute } from "@tanstack/react-router";

// Temporary read-only PurchaseBook probe (Phase 3B Prerequisite).
//
// Sole purpose: observe the live shape of
//   POST https://openapi-reporting.account.qne.cloud/api/reporting/PurchaseBook
// so Phase 3B Views 1–2 can be designed against real data.
//
// This route:
//   - forwards the caller's N3 bearer token upstream WITHOUT logging or
//     returning it,
//   - accepts { dateFrom, dateTo } ISO dates from the browser,
//   - returns a sanitized diagnostic result — never the full upstream body,
//   - performs zero writes.
//
// The route will be removed after Phase 3B Views 1–2 are verified.

const REPORTING_DEFAULT = "https://openapi-reporting.account.qne.cloud";
const TARGET_DOC = "M1B2607002Ikeyinn3";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Keys we allow through when echoing a detailItems row. Anything not on this
// list (tenant IDs, tokens, unrelated FKs) is dropped.
const SAFE_DETAIL_KEYS = new Set([
  "docCode",
  "docDate",
  "docType",
  "pos",
  "isCancelled",
  "supplierCode",
  "supplierName",
  "purchaserCode",
  "purchaserName",
  "accountCode",
  "accountName",
  "stockCode",
  "stockName",
  "projectCode",
  "projectName",
  "taxCode",
  "taxCodeName",
  "taxRate",
  "description",
  "referenceNo",
  "qty",
  "unitPrice",
  "netAmount",
  "taxAmount",
  "subAmount",
  "amount",
  "amountLocal",
  "taxAmountLocal",
  "taxExclusiveAmountLocal",
  "currencyCode",
  "exchangeRate",
]);

const SAFE_SUMMARY_KEYS = new Set(["accountCode", "accountName", "amount"]);

function pick(obj: Record<string, unknown>, allow: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (!allow.has(k)) continue;
    const v = obj[k];
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") out[k] = v;
  }
  return out;
}

function safeMessage(raw: string, fallback: string): string {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed) return fallback;
  const scrubbed = trimmed
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/https?:\/\/\S+/gi, "[url]");
  return scrubbed.length > 240 ? `${scrubbed.slice(0, 240)}…` : scrubbed;
}

function shapeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  const t = typeof v;
  if (t !== "object") return t;
  const keys = Object.keys(v as object);
  return `object(${keys.length} keys${keys.length ? `: ${keys.slice(0, 12).join(",")}` : ""})`;
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = n < 0 ? -1 : 1;
  return (s * Math.round(Math.abs(n) * 100)) / 100;
}

interface ProbeReply {
  ok: boolean;
  error?: string;
  result?: unknown;
}

function jsonRes(status: number, body: ProbeReply): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handle(request: Request): Promise<Response> {
  const authz = request.headers.get("authorization") ?? "";
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m || !m[1].trim()) {
    return jsonRes(401, { ok: false, error: "Not signed in to N3." });
  }
  const token = m[1].trim();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonRes(400, { ok: false, error: "Invalid JSON body" });
  }
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const dateFrom = typeof body.dateFrom === "string" ? body.dateFrom : "";
  const dateTo = typeof body.dateTo === "string" ? body.dateTo : "";
  if (!ISO_DATE_RE.test(dateFrom) || !ISO_DATE_RE.test(dateTo)) {
    return jsonRes(400, { ok: false, error: "dateFrom / dateTo must be yyyy-mm-dd." });
  }
  if (dateFrom > dateTo) {
    return jsonRes(400, { ok: false, error: "dateFrom must be on or before dateTo." });
  }

  const base = process.env.OPEN_API_REPORTING_BASE_URL || REPORTING_DEFAULT;
  const payload = {
    filter: {
      dateFrom: `${dateFrom}T00:00:00`,
      dateTo: `${dateTo}T23:59:59`,
      supplierFrom: null,
      supplierTo: null,
      purchaserFrom: null,
      purchaserTo: null,
      docPurchaserFrom: null,
      docPurchaserTo: null,
      areaFrom: null,
      areaTo: null,
      categoryFrom: null,
      categoryTo: null,
      exDoc: false,
      build: null,
      projectIds: [] as number[],
      projOption: -2,
    },
    options: null,
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/reporting/PurchaseBook`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return jsonRes(502, {
      ok: false,
      error: safeMessage(err instanceof Error ? err.message : "", "Upstream network error"),
    });
  }

  const text = await upstream.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return jsonRes(502, {
      ok: false,
      error: `Upstream returned non-JSON (HTTP ${upstream.status}, ${text.length} bytes).`,
    });
  }

  const env = (parsed && typeof parsed === "object" ? parsed : {}) as {
    success?: unknown;
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };

  // Locate the report body ("data") whether envelope-wrapped or not.
  const data =
    env && "data" in env && env.data && typeof env.data === "object" ? env.data : parsed;

  // reportModel / detailItems / postingSummary discovery — tolerate variations.
  const dataObj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const reportModel = Array.isArray(dataObj.reportModel)
    ? (dataObj.reportModel as unknown[])
    : Array.isArray((dataObj as { models?: unknown }).models)
      ? ((dataObj as { models: unknown[] }).models)
      : [];
  const detailItems = Array.isArray(dataObj.detailItems)
    ? (dataObj.detailItems as unknown[])
    : Array.isArray((dataObj as { items?: unknown }).items)
      ? ((dataObj as { items: unknown[] }).items)
      : [];
  const postingSummary = Array.isArray(dataObj.postingSummary)
    ? (dataObj.postingSummary as unknown[])
    : Array.isArray((dataObj as { posting?: unknown }).posting)
      ? ((dataObj as { posting: unknown[] }).posting)
      : [];

  const cancelledCount: number = detailItems.reduce<number>((n, row) => {
    if (row && typeof row === "object" && (row as { isCancelled?: unknown }).isCancelled === true) {
      return n + 1;
    }
    return n;
  }, 0);

  // Target-document rows (M1B2607002Ikeyinn3), sanitized.
  const targetRows = detailItems
    .filter(
      (r) =>
        r &&
        typeof r === "object" &&
        (r as { docCode?: unknown }).docCode === TARGET_DOC,
    )
    .map((r) => pick(r as Record<string, unknown>, SAFE_DETAIL_KEYS));

  // All postingSummary rows for the submitted period, sanitized.
  const posting = postingSummary
    .filter((r) => r && typeof r === "object")
    .map((r) => pick(r as Record<string, unknown>, SAFE_SUMMARY_KEYS));

  // Debit/Credit interpretations for diagnosis only.
  const sums = posting.reduce(
    (acc, r) => {
      const amount = typeof r.amount === "number" ? r.amount : Number(r.amount) || 0;
      if (amount > 0) acc.pos = round2(acc.pos + amount);
      else if (amount < 0) acc.neg = round2(acc.neg + amount);
      return acc;
    },
    { pos: 0, neg: 0 },
  );
  const interpret = (posIsDebit: boolean) => {
    const totalDebit = posIsDebit ? sums.pos : Math.abs(sums.neg);
    const totalCredit = posIsDebit ? Math.abs(sums.neg) : sums.pos;
    const difference = round2(totalDebit - totalCredit);
    return { totalDebit, totalCredit, difference, isBalanced: difference === 0 };
  };

  const result = {
    request: { dateFrom, dateTo, exDoc: false, projOption: -2 },
    http: { status: upstream.status, ok: upstream.ok },
    envelope: {
      success: env.success ?? null,
      code: typeof env.code === "string" || typeof env.code === "number" ? env.code : null,
      message:
        typeof env.message === "string" ? safeMessage(env.message, "") : null,
      dataShape: shapeOf(data),
      topLevelKeys: dataObj && typeof dataObj === "object" ? Object.keys(dataObj).slice(0, 32) : [],
    },
    counts: {
      reportModel: reportModel.length,
      detailItems: detailItems.length,
      postingSummary: postingSummary.length,
      cancelledDetailItems: cancelledCount,
      targetDocRows: targetRows.length,
    },
    exDocFalseReturnedCancelledItems: cancelledCount > 0,
    targetDocCode: TARGET_DOC,
    targetDetailItems: targetRows,
    postingSummary: posting,
    interpretationA_positiveIsDebit: interpret(true),
    interpretationB_positiveIsCredit: interpret(false),
  };

  if (!upstream.ok || env.success === false) {
    return jsonRes(200, {
      ok: false,
      error: safeMessage(
        typeof env.message === "string" ? env.message : "",
        `Upstream HTTP ${upstream.status}`,
      ),
      result,
    });
  }
  return jsonRes(200, { ok: true, result });
}

export const Route = createFileRoute("/api/reports/purchasebook-probe")({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
    },
  },
});
