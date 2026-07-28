// Phase 3B Correction E — Purchase Audit accounting endpoint.
//
// Primary strategy (per Correction E §3): for every target Purchase Invoice
// we call the document-level Account Journal endpoint
//   GET /api/PurchaseInvoices/GLPosting?key=<invoiceId>
// with a bounded worker pool (max 6). Each response is normalized against
// its own target PI (see `pi-gl-posting.ts`) with stateful continuation-row
// account inheritance so blank-account credits (e.g. `167.44`, `95.68`)
// remain part of the same document under the correct supplier-control
// account. All PIs must succeed; a partial result is never returned.
//
// Fallback strategy (Correction E §4): only if the primary path cannot
// complete the whole target set — because GLPosting is not available for
// this tenant/version (404/405), returns an unsupported successful shape,
// or produces no usable journal for a document — we fall back to the older
// General Ledger scan. The fallback iterates each account's rows statefully
// (blank-account continuation rows inherit the last explicit account, not
// the supplier code) and resolves blank-docCode rows by canonical
// (supplierInvNo, docDate?, supplierCode?) with blank date tolerated when
// Supplier INV# is unique.
//
// Primary and fallback results are never mixed: if primary is partial it is
// discarded and one full fallback pass is executed.

import { createFileRoute } from "@tanstack/react-router";
import type { AuditPIDocument, GLRow } from "@/lib/audit-trail";
import {
  buildGetAccountRowsBody,
  buildQueryTransactionLinesBody,
  normalizeAccountRows,
  unionAccountQueries,
  type AccountToQuery,
  type UnresolvedRow,
} from "@/lib/audit-server";
import { normalizeGLPostingForPI } from "@/lib/pi-gl-posting";
import { canonicalDocCode } from "@/lib/report-keys";

const REPORTING_DEFAULT = "https://openapi-reporting.account.qne.cloud";
const MAIN_DEFAULT = "https://openapi.account.qne.cloud";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GL_PAGE_SIZE = 500;
const GL_WORKERS = 3;
const PI_GLPOSTING_WORKERS = 6;

interface PIDocumentIn extends AuditPIDocument {}

interface AuditRequest {
  dateFrom: string;
  dateTo: string;
  piDocuments: PIDocumentIn[];
}

type Strategy = "purchase-invoice-glposting" | "general-ledger-fallback";

interface Meta {
  strategy: Strategy;
  targetInvoiceCount: number;
  upstreamRequestCount: number;
  rowsMatched: number;
  elapsedMs: number;
  fallbackReason?: string;
  piDocumentCount: number;
  piDocSample: string[];
  // Fallback-only diagnostics (retained for the older UI).
  accountsFetched?: number;
  accountsFromApi?: number;
  accountsFromSuppliers?: number;
  accountsWithHits?: number;
  accountsWithNoRows?: string[];
  glRowsFetched?: number;
  glRowsMatched?: number;
  unresolvedCount?: number;
  unresolvedRows?: UnresolvedRow[];
}

interface Reply {
  ok: boolean;
  kind?: "auth" | "validation" | "n3" | "incomplete" | "network";
  error?: string;
  gl?: GLRow[];
  meta?: Meta;
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

interface HttpOk {
  ok: true;
  status: number;
  parsed: unknown;
}
interface HttpErr {
  ok: false;
  status: number;
  message: string;
}

async function postJson(url: string, token: string, body: unknown): Promise<HttpOk | HttpErr> {
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

async function getJson(url: string, token: string): Promise<HttpOk | HttpErr> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
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

function parseBody(raw: unknown): AuditRequest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Missing body" };
  const b = raw as Record<string, unknown>;
  const dateFrom = typeof b.dateFrom === "string" ? b.dateFrom : "";
  const dateTo = typeof b.dateTo === "string" ? b.dateTo : "";
  if (!ISO_DATE_RE.test(dateFrom) || !ISO_DATE_RE.test(dateTo))
    return { error: "dateFrom / dateTo must be yyyy-mm-dd." };
  if (dateFrom > dateTo) return { error: "dateFrom must be on or before dateTo." };
  const rawList = Array.isArray(b.piDocuments) ? b.piDocuments : [];
  const piDocuments: PIDocumentIn[] = [];
  for (const r of rawList) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const dc = typeof rec.docCode === "string" ? rec.docCode.trim() : "";
    if (!dc) continue;
    piDocuments.push({
      invoiceId: typeof rec.invoiceId === "string" ? rec.invoiceId : undefined,
      docCode: dc,
      docDate: typeof rec.docDate === "string" ? rec.docDate : undefined,
      dueDate: typeof rec.dueDate === "string" ? rec.dueDate : undefined,
      supplierCode: typeof rec.supplierCode === "string" ? rec.supplierCode : undefined,
      supplierName: typeof rec.supplierName === "string" ? rec.supplierName : undefined,
      supplierInvNo: typeof rec.supplierInvNo === "string" ? rec.supplierInvNo : undefined,
      termCode: typeof rec.termCode === "string" ? rec.termCode : undefined,
      termDescription:
        typeof rec.termDescription === "string" ? rec.termDescription : undefined,
      currencyCode: typeof rec.currencyCode === "string" ? rec.currencyCode : undefined,
      currencyRate: typeof rec.currencyRate === "number" ? rec.currencyRate : undefined,
    });
  }
  if (piDocuments.length === 0)
    return { error: "piDocuments must contain at least one Purchase Invoice." };
  return { dateFrom, dateTo, piDocuments };
}

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
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit | 0, items.length)) },
    run,
  );
  await Promise.all(runners);
  return out;
}

// ---------- Primary strategy: PI GLPosting -------------------------------

interface PrimaryOk {
  ok: true;
  rows: GLRow[];
  upstreamRequestCount: number;
}
interface PrimaryFail {
  ok: false;
  reason: string;
  upstreamRequestCount: number;
}

async function runPrimaryGLPosting(
  mainBase: string,
  token: string,
  req: AuditRequest,
): Promise<PrimaryOk | PrimaryFail> {
  // §3.2: every target PI must carry an immutable invoice id, else we cannot
  // hit the document-level endpoint at all → fall back.
  const missingId = req.piDocuments.find((p) => !p.invoiceId);
  if (missingId) {
    return {
      ok: false,
      reason: `Purchase Invoice ${missingId.docCode} has no N3 invoice id in the current GL Analysis cache.`,
      upstreamRequestCount: 0,
    };
  }

  let upstreamRequestCount = 0;
  const results = await pool(req.piDocuments, PI_GLPOSTING_WORKERS, async (pi) => {
    upstreamRequestCount += 1;
    const url = `${mainBase}/api/PurchaseInvoices/GLPosting?key=${encodeURIComponent(pi.invoiceId!)}`;
    const res = await getJson(url, token);
    return { pi, res };
  });

  const allRows: GLRow[] = [];
  for (const { pi, res } of results) {
    if (!res.ok) {
      // 404/405: endpoint not available for this tenant/version → fallback.
      if (res.status === 404 || res.status === 405) {
        return {
          ok: false,
          reason: `GLPosting endpoint not available for this tenant/version (HTTP ${res.status}).`,
          upstreamRequestCount,
        };
      }
      // Auth surfaces to caller as-is; other failures also drop to fallback
      // rather than fabricating a partial result.
      if (res.status === 401) {
        return {
          ok: false,
          reason: `GLPosting request rejected (HTTP 401 ${safeMessage(res.message, "auth")}).`,
          upstreamRequestCount,
        };
      }
      return {
        ok: false,
        reason: `GLPosting request failed for ${pi.docCode} (HTTP ${res.status} — ${res.message}).`,
        upstreamRequestCount,
      };
    }
    const norm = normalizeGLPostingForPI(res.parsed, pi);
    if (!norm.ok) {
      return {
        ok: false,
        reason: `GLPosting response for ${pi.docCode} was ${norm.reason}.`,
        upstreamRequestCount,
      };
    }
    allRows.push(...norm.rows);
  }

  return { ok: true, rows: allRows, upstreamRequestCount };
}

// ---------- Fallback strategy: broad GL scan -----------------------------

async function fetchAccountRows(
  base: string,
  token: string,
  req: AuditRequest,
): Promise<
  | { ok: true; accounts: Array<{ accountCode: string; accountName: string }> }
  | { ok: false; message: string }
> {
  const url = `${base}/api/reporting/GeneralLedger/GetAccountRows`;
  const body = buildGetAccountRowsBody(req.dateFrom, req.dateTo);
  const res = await postJson(url, token, body);
  if (!res.ok) return { ok: false, message: `HTTP ${res.status} — ${res.message}` };
  const parsed = res.parsed as { data?: unknown } | null;
  const data = parsed && typeof parsed === "object" ? parsed.data : undefined;
  let rows: unknown[] | null = null;
  if (Array.isArray(data)) rows = data;
  else if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { value?: unknown[] }).value)
  )
    rows = (data as { value: unknown[] }).value;
  if (!rows) {
    return {
      ok: false,
      message:
        "GetAccountRows returned a successful envelope with no account array (data / data.value).",
    };
  }
  const accounts: Array<{ accountCode: string; accountName: string }> = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const rec = r as { accountCode?: unknown; accountName?: unknown };
    const code = typeof rec.accountCode === "string" ? rec.accountCode.trim() : "";
    if (!code) continue;
    const name = typeof rec.accountName === "string" ? rec.accountName.trim() : "";
    accounts.push({ accountCode: code, accountName: name });
  }
  return { ok: true, accounts };
}

async function fetchGLForAccount(
  base: string,
  token: string,
  req: AuditRequest,
  accountCode: string,
): Promise<{ ok: true; rows: GLRow[] } | { ok: false; message: string }> {
  const rows: GLRow[] = [];
  let skip = 0;
  for (let page = 0; page < 500; page++) {
    const url =
      `${base}/api/reporting/GeneralLedger/QueryTransactionLines` +
      `?%24top=${GL_PAGE_SIZE}&%24skip=${skip}`;
    const body = buildQueryTransactionLinesBody(accountCode, req.dateFrom, req.dateTo);
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

interface FallbackOut {
  gl: GLRow[];
  meta: Partial<Meta>;
  upstreamRequestCount: number;
  error?: { status: number; kind: Reply["kind"]; message: string };
  unresolved: UnresolvedRow[];
}

async function runFallbackGeneralLedger(
  reportingBase: string,
  token: string,
  req: AuditRequest,
): Promise<FallbackOut> {
  let upstreamRequestCount = 0;
  const accountsRes = await fetchAccountRows(reportingBase, token, req);
  upstreamRequestCount += 1;
  if (!accountsRes.ok) {
    return {
      gl: [],
      meta: {},
      upstreamRequestCount,
      unresolved: [],
      error: {
        status: 502,
        kind: "incomplete",
        message: `Could not enumerate GL accounts: ${accountsRes.message}`,
      },
    };
  }

  const queries: AccountToQuery[] = unionAccountQueries(
    accountsRes.accounts,
    req.piDocuments,
  );
  const accountsFromSuppliers = queries.filter((q) => q.source === "target-supplier").length;

  const perAccount = await pool(queries, GL_WORKERS, (q) =>
    fetchGLForAccount(reportingBase, token, req, q.accountCode).then((r) => {
      upstreamRequestCount += 1;
      return { q, r };
    }),
  );

  const glMatched: GLRow[] = [];
  const emptyAccounts: string[] = [];
  const unresolved: UnresolvedRow[] = [];
  let accountsWithHits = 0;
  let glRowsFetched = 0;
  for (const { q, r } of perAccount) {
    if (!r.ok) {
      return {
        gl: [],
        meta: {},
        upstreamRequestCount,
        unresolved: [],
        error: {
          status: 502,
          kind: "incomplete",
          message: `Could not fetch GL rows for account ${q.accountCode}: ${r.message}`,
        },
      };
    }
    glRowsFetched += r.rows.length;
    const norm = normalizeAccountRows(q, r.rows, req.piDocuments);
    if (norm.rows.length === 0) emptyAccounts.push(q.accountCode);
    else {
      accountsWithHits += 1;
      glMatched.push(...norm.rows);
    }
    if (norm.unresolved.length > 0) unresolved.push(...norm.unresolved);
  }

  return {
    gl: glMatched,
    upstreamRequestCount,
    unresolved,
    meta: {
      accountsFetched: queries.length,
      accountsFromApi: queries.length - accountsFromSuppliers,
      accountsFromSuppliers,
      accountsWithHits,
      accountsWithNoRows: emptyAccounts,
      glRowsFetched,
      glRowsMatched: glMatched.length,
    },
  };
}

// ---------- Route handler ------------------------------------------------

async function handle(request: Request): Promise<Response> {
  const startedAt = Date.now();
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
  const mainBase = process.env.OPEN_API_BASE_URL || MAIN_DEFAULT;

  const piDocSample = [
    ...new Set(req.piDocuments.map((p) => canonicalDocCode(p.docCode)).filter(Boolean)),
  ].slice(0, 3);

  // ----- Primary path -----
  const primary = await runPrimaryGLPosting(mainBase, token, req);
  if (primary.ok) {
    const meta: Meta = {
      strategy: "purchase-invoice-glposting",
      targetInvoiceCount: req.piDocuments.length,
      upstreamRequestCount: primary.upstreamRequestCount,
      rowsMatched: primary.rows.length,
      elapsedMs: Date.now() - startedAt,
      piDocumentCount: req.piDocuments.length,
      piDocSample,
    };
    return jsonRes(200, { ok: true, gl: primary.rows, meta });
  }

  // ----- Fallback path (only when primary cannot complete) -----
  const fallbackReason = primary.reason;
  const fb = await runFallbackGeneralLedger(reportingBase, token, req);
  const totalUpstream = primary.upstreamRequestCount + fb.upstreamRequestCount;
  if (fb.error) {
    return jsonRes(fb.error.status, {
      ok: false,
      kind: fb.error.kind,
      error: fb.error.message,
      meta: {
        strategy: "general-ledger-fallback",
        targetInvoiceCount: req.piDocuments.length,
        upstreamRequestCount: totalUpstream,
        rowsMatched: 0,
        elapsedMs: Date.now() - startedAt,
        fallbackReason,
        piDocumentCount: req.piDocuments.length,
        piDocSample,
        ...fb.meta,
      },
    });
  }

  const baseMeta: Meta = {
    strategy: "general-ledger-fallback",
    targetInvoiceCount: req.piDocuments.length,
    upstreamRequestCount: totalUpstream,
    rowsMatched: fb.gl.length,
    elapsedMs: Date.now() - startedAt,
    fallbackReason,
    piDocumentCount: req.piDocuments.length,
    piDocSample,
    ...fb.meta,
  };

  if (fb.unresolved.length > 0) {
    return jsonRes(200, {
      ok: false,
      kind: "incomplete",
      error: `Unable to uniquely resolve ${fb.unresolved.length} General Ledger row${fb.unresolved.length === 1 ? "" : "s"} to a target Purchase Invoice.`,
      meta: {
        ...baseMeta,
        unresolvedCount: fb.unresolved.length,
        unresolvedRows: fb.unresolved,
      },
    });
  }

  return jsonRes(200, { ok: true, gl: fb.gl, meta: baseMeta });
}

export const Route = createFileRoute("/api/reports/purchase-audit")({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
    },
  },
});
