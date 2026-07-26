// Phase 3B Views 1-2 accounting endpoint.
//
// Given the same GL Analysis criteria + the current audit doc-code set,
// fetch:
//   - N3 Reporting PurchaseBook (for header context + posting summary)
//   - N3 Reporting GeneralLedger transaction rows for the account codes
//     that appear in the posting summary
// and return the sanitized, contract-checked result. This route performs
// zero writes.
//
// Contract handling:
//   - If PurchaseBook returns an unrecognised shape → 502 kind:"incomplete".
//   - If the GL response for any candidate account is malformed → 502
//     kind:"incomplete" (no partial totals).
//   - Otherwise return { ok, pb, gl, docCodes, meta } for the client to
//     reconcile via reconcileAudit() and render.

import { createFileRoute } from "@tanstack/react-router";
import {
  normalizePurchaseBook,
  type PurchaseBookDetailItem,
  type PurchaseBookNormalized,
  type PurchaseBookPostingSummaryRow,
} from "@/lib/purchase-book";
import type { GLRow } from "@/lib/audit-trail";

const MAIN_DEFAULT = "https://openapi.account.qne.cloud";
const REPORTING_DEFAULT = "https://openapi-reporting.account.qne.cloud";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Reply {
  ok: boolean;
  kind?: "auth" | "validation" | "n3" | "incomplete" | "network";
  error?: string;
  pb?: PurchaseBookNormalized;
  gl?: GLRow[];
  meta?: {
    accountCodesTried: string[];
    accountsWithNoRows: string[];
    pbDetailItems: number;
    pbPostingSummary: number;
    glRowsFetched: number;
  };
}

function jsonRes(status: number, body: Reply): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeMessage(raw: string, fallback: string): string {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed) return fallback;
  const scrubbed = trimmed
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/https?:\/\/\S+/gi, "[url]");
  return scrubbed.length > 240 ? `${scrubbed.slice(0, 240)}…` : scrubbed;
}

async function postJson(
  url: string,
  token: string,
  body: unknown,
): Promise<{ ok: true; status: number; parsed: unknown } | { ok: false; status: number; message: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: safeMessage(err instanceof Error ? err.message : "", "Network error"),
    };
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok)
      return { ok: false, status: res.status, message: `Upstream HTTP ${res.status} (non-JSON)` };
  }
  if (!res.ok) {
    const msg = safeMessage(
      (parsed && typeof parsed === "object" && "message" in (parsed as object)
        ? String((parsed as { message?: unknown }).message ?? "")
        : ""),
      `Upstream HTTP ${res.status}`,
    );
    return { ok: false, status: res.status, message: msg };
  }
  return { ok: true, status: res.status, parsed };
}

interface AuditRequest {
  dateFrom: string;
  dateTo: string;
  /** Purchase Invoice audit doc-code set (from the current GL Analysis report). */
  piDocCodes: string[];
}

function parseBody(raw: unknown): AuditRequest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Missing body" };
  const b = raw as Record<string, unknown>;
  const dateFrom = typeof b.dateFrom === "string" ? b.dateFrom : "";
  const dateTo = typeof b.dateTo === "string" ? b.dateTo : "";
  if (!ISO_DATE_RE.test(dateFrom) || !ISO_DATE_RE.test(dateTo))
    return { error: "dateFrom / dateTo must be yyyy-mm-dd." };
  if (dateFrom > dateTo) return { error: "dateFrom must be on or before dateTo." };
  const piRaw = Array.isArray(b.piDocCodes) ? b.piDocCodes : [];
  const piDocCodes = piRaw
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => !!v);
  return { dateFrom, dateTo, piDocCodes };
}

/**
 * POST /api/reporting/PurchaseBook with a minimal all-inclusive filter.
 * Cancelled documents are intentionally requested (`exDoc:false`) so the
 * client can compare against the excluded-cancelled PI set.
 */
async function fetchPurchaseBook(
  base: string,
  token: string,
  req: AuditRequest,
): Promise<{ ok: true; pb: PurchaseBookNormalized } | { ok: false; message: string }> {
  const payload = {
    filter: {
      dateFrom: `${req.dateFrom}T00:00:00`,
      dateTo: `${req.dateTo}T23:59:59`,
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
  const res = await postJson(`${base}/api/reporting/PurchaseBook`, token, payload);
  if (!res.ok) return { ok: false, message: res.message };
  const normalized = normalizePurchaseBook(res.parsed);
  if (normalized.kind !== "ok") {
    return {
      ok: false,
      message: `PurchaseBook contract mismatch (${normalized.reason} — ${normalized.shape})`,
    };
  }
  return { ok: true, pb: normalized };
}

/**
 * POST /api/reporting/GeneralLedger for a specific account-code range.
 *
 * Returns a flat GLRow[] normalized from either:
 *   - envelope.data = GLRow[]
 *   - envelope.data = { data: GLRow[] }             (LoadResult)
 *   - envelope.data = { reportModel: [{ transactions: GLRow[] }] }
 * Any unrecognised shape returns { ok: false }.
 */
async function fetchGL(
  base: string,
  token: string,
  req: AuditRequest,
  accountCode: string,
): Promise<{ ok: true; rows: GLRow[] } | { ok: false; message: string }> {
  const payload = {
    filter: {
      dateFrom: `${req.dateFrom}T00:00:00`,
      dateTo: `${req.dateTo}T23:59:59`,
      accountFrom: accountCode,
      accountTo: accountCode,
      currencyFrom: null,
      currencyTo: null,
      projectFrom: null,
      projectTo: null,
      areaFrom: null,
      areaTo: null,
      exDoc: false,
      build: null,
      projectIds: [] as number[],
      projOption: -2,
    },
    options: null,
  };
  const res = await postJson(`${base}/api/reporting/GeneralLedger`, token, payload);
  if (!res.ok) return { ok: false, message: res.message };
  const parsed = res.parsed as { data?: unknown } | null;
  const data = parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
  const rows: GLRow[] = [];
  const push = (r: unknown) => {
    if (!r || typeof r !== "object") return;
    rows.push(r as GLRow);
  };
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === "object" && Array.isArray((item as { transactions?: unknown[] }).transactions)) {
        for (const t of (item as { transactions: unknown[] }).transactions) push(t);
      } else push(item);
    }
  } else if (data && typeof data === "object") {
    const inner = (data as { data?: unknown; reportModel?: unknown; transactions?: unknown }).data;
    const rm = (data as { reportModel?: unknown }).reportModel;
    const tx = (data as { transactions?: unknown }).transactions;
    if (Array.isArray(inner)) inner.forEach(push);
    else if (Array.isArray(rm))
      for (const item of rm) {
        if (item && typeof item === "object" && Array.isArray((item as { transactions?: unknown[] }).transactions))
          for (const t of (item as { transactions: unknown[] }).transactions) push(t);
      }
    else if (Array.isArray(tx)) tx.forEach(push);
    else
      return {
        ok: false,
        message: `GeneralLedger contract mismatch for account ${accountCode}`,
      };
  } else if (data == null) {
    return { ok: true, rows: [] };
  } else {
    return { ok: false, message: `GeneralLedger returned unrecognised shape for ${accountCode}` };
  }
  return { ok: true, rows };
}

function candidateAccountCodes(
  detailItems: PurchaseBookDetailItem[],
  postingSummary: PurchaseBookPostingSummaryRow[],
): string[] {
  const out = new Set<string>();
  for (const s of postingSummary) {
    const c = (s.accountCode ?? "").trim();
    if (c) out.add(c);
  }
  for (const d of detailItems) {
    const c = (d.supplierCode ?? "").trim();
    if (c) out.add(c);
  }
  return [...out].sort();
}

async function handle(request: Request): Promise<Response> {
  const authz = request.headers.get("authorization") ?? "";
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m || !m[1].trim())
    return jsonRes(401, { ok: false, kind: "auth", error: "Not signed in to N3." });
  const token = m[1].trim();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonRes(400, { ok: false, kind: "validation", error: "Invalid JSON body" });
  }
  const parsed = parseBody(raw);
  if ("error" in parsed)
    return jsonRes(400, { ok: false, kind: "validation", error: parsed.error });
  const req = parsed;

  const reportingBase = process.env.OPEN_API_REPORTING_BASE_URL || REPORTING_DEFAULT;
  void (process.env.OPEN_API_BASE_URL || MAIN_DEFAULT);

  const pbResult = await fetchPurchaseBook(reportingBase, token, req);
  if (!pbResult.ok)
    return jsonRes(502, { ok: false, kind: "incomplete", error: pbResult.message });
  const pb = pbResult.pb;

  const codes = candidateAccountCodes(pb.detailItems, pb.postingSummary);
  const gl: GLRow[] = [];
  const emptyAccounts: string[] = [];
  for (const code of codes) {
    const r = await fetchGL(reportingBase, token, req, code);
    if (!r.ok)
      return jsonRes(502, {
        ok: false,
        kind: "incomplete",
        error: `Could not fetch GL rows for account ${code}: ${r.message}`,
      });
    if (r.rows.length === 0) emptyAccounts.push(code);
    else gl.push(...r.rows);
  }

  return jsonRes(200, {
    ok: true,
    pb,
    gl,
    meta: {
      accountCodesTried: codes,
      accountsWithNoRows: emptyAccounts,
      pbDetailItems: pb.detailItems.length,
      pbPostingSummary: pb.postingSummary.length,
      glRowsFetched: gl.length,
    },
  });
}

export const Route = createFileRoute("/api/reports/purchase-audit")({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
    },
  },
});
