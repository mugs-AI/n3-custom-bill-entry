// Phase 3B Views 1-2 accounting endpoint.
//
// Correction A Task 1: the previous version called the undocumented
//   POST /api/reporting/GeneralLedger
// which returns HTTP 404. The correct N3 endpoint is:
//   POST /api/reporting/GeneralLedger/QueryTransactionLines
//     ?$top=500&$skip=<offset>
// with body { accountCode, filter{...} } and envelope { data.count, data.value[] }.
//
// GL fetches run behind a 3-worker pool. Within each account, pages are
// requested serially until `skip >= count`. The bearer token is never echoed
// back to the browser and upstream error messages are sanitized.

import { createFileRoute } from "@tanstack/react-router";
import {
  normalizePurchaseBook,
  purchaseBookSupplierCode,
  type PurchaseBookDetailItem,
  type PurchaseBookNormalized,
  type PurchaseBookPostingSummaryRow,
} from "@/lib/purchase-book";
import { canonicalAccountCode, canonicalDocCode } from "@/lib/report-keys";
import type { GLRow } from "@/lib/audit-trail";

const REPORTING_DEFAULT = "https://openapi-reporting.account.qne.cloud";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GL_PAGE_SIZE = 500;
const GL_WORKERS = 3;

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
    /** Up to three canonical PI/PB doc-code samples for authenticated diagnostics. */
    piDocSample: string[];
    pbDocSample: string[];
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
): Promise<
  | { ok: true; status: number; parsed: unknown }
  | { ok: false; status: number; message: string }
> {
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
      parsed && typeof parsed === "object" && "message" in (parsed as object)
        ? String((parsed as { message?: unknown }).message ?? "")
        : "",
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
 * Fetch every GL transaction line for a single account code, paging through
 * the documented `{ count, value[] }` envelope at 500 rows per request.
 * Account codes (e.g. `800-C001`) are opaque strings — never numeric IDs.
 */
async function fetchGLForAccount(
  base: string,
  token: string,
  req: AuditRequest,
  accountCode: string,
): Promise<{ ok: true; rows: GLRow[] } | { ok: false; message: string }> {
  const rows: GLRow[] = [];
  let skip = 0;
  // Hard safety cap: 500 pages * 500 rows = 250k lines per account.
  for (let page = 0; page < 500; page++) {
    const url =
      `${base}/api/reporting/GeneralLedger/QueryTransactionLines` +
      `?%24top=${GL_PAGE_SIZE}&%24skip=${skip}`;
    const body = {
      accountCode,
      filter: {
        dateFrom: `${req.dateFrom}T00:00:00`,
        dateTo: `${req.dateTo}T23:59:59`,
        accountFrom: null,
        accountTo: null,
        accountCodes: null,
        build: null,
        projectIds: [] as number[],
        projOption: -2,
        sortBy: null,
        includeZero: false,
        includeDACandCCAC: false,
      },
    };
    const res = await postJson(url, token, body);
    if (!res.ok) return { ok: false, message: `HTTP ${res.status} — ${res.message}` };

    const parsed = res.parsed as { data?: { count?: number; value?: unknown[] } } | null;
    const data = parsed && typeof parsed === "object" ? parsed.data : null;
    if (!data || typeof data !== "object") {
      return { ok: false, message: "envelope missing data.value / data.count" };
    }
    const value = Array.isArray(data.value) ? data.value : null;
    const count = typeof data.count === "number" ? data.count : null;
    if (!value || count == null) {
      return { ok: false, message: "envelope missing data.value / data.count" };
    }
    for (const r of value) {
      if (r && typeof r === "object") rows.push(r as GLRow);
    }
    skip += value.length;
    if (value.length === 0 || skip >= count) break;
  }
  return { ok: true, rows };
}

/**
 * Candidate account codes for GL fetch = every posting-summary accountCode
 * PLUS every PurchaseBook supplier/creditor code (documented `code`, with
 * `supplierCode` as backward-compatible fallback). Deduplicated using the
 * shared canonical account-key rule, keeping the first original casing for
 * the upstream query.
 */
function candidateAccountCodes(
  detailItems: PurchaseBookDetailItem[],
  postingSummary: PurchaseBookPostingSummaryRow[],
): string[] {
  const seen = new Map<string, string>();
  const add = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const key = canonicalAccountCode(trimmed);
    if (!seen.has(key)) seen.set(key, trimmed);
  };
  for (const s of postingSummary) add(typeof s.accountCode === "string" ? s.accountCode : "");
  for (const d of detailItems) add(purchaseBookSupplierCode(d));
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Simple pool: at most `limit` workers concurrent over `items`. */
async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  };
  const runners = Array.from({ length: Math.max(1, Math.min(limit | 0, items.length)) }, run);
  await Promise.all(runners);
  return out;
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

  const pbResult = await fetchPurchaseBook(reportingBase, token, req);
  if (!pbResult.ok)
    return jsonRes(502, { ok: false, kind: "incomplete", error: pbResult.message });
  const pb = pbResult.pb;

  const codes = candidateAccountCodes(pb.detailItems, pb.postingSummary);
  const perAccount = await pool(codes, GL_WORKERS, (code) =>
    fetchGLForAccount(reportingBase, token, req, code).then((r) => ({ code, r })),
  );
  const gl: GLRow[] = [];
  const emptyAccounts: string[] = [];
  for (const { code, r } of perAccount) {
    if (!r.ok) {
      return jsonRes(502, {
        ok: false,
        kind: "incomplete",
        error: `Could not fetch GL rows for account ${code}: ${r.message}`,
      });
    }
    if (r.rows.length === 0) emptyAccounts.push(code);
    else gl.push(...r.rows);
  }

  const piDocSample = [
    ...new Set(req.piDocCodes.map(canonicalDocCode).filter(Boolean)),
  ].slice(0, 3);
  const pbDocSample = [
    ...new Set(
      pb.detailItems
        .filter((d) => !d.isCancelled)
        .map((d) => canonicalDocCode(d.docCode))
        .filter(Boolean),
    ),
  ].slice(0, 3);

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
      piDocSample,
      pbDocSample,
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
