// Phase 3B Correction D — Purchase Audit accounting endpoint.
//
// Document set = the Purchase Invoice list produced by the current GL
// Analysis inquiry (sent as `piDocuments`, now including `supplierInvNo`).
//
// GL discovery:
//   1. Enumerate active GL accounts via
//        POST /api/reporting/GeneralLedger/GetAccountRows
//      sending the GeneralLedgerFilter DIRECTLY (no `filter` wrapper),
//      with `includeZero=false, includeDACandCCAC=true`. A successful
//      envelope missing an account array is treated as a contract error.
//   2. Union those accounts with every target PI `supplierCode` — supplier
//      control accounts always ship, even when GetAccountRows omits them.
//   3. For each account, fetch every posting via
//        POST /api/reporting/GeneralLedger/QueryTransactionLines
//          ?$top=500&$skip=<offset>
//      with the documented `{ accountCode, filter }` wrapper.
//   4. Continuation/split rows can omit repeated accountCode/accountName/
//      docCode fields; normalizeAccountRows restores account context and
//      resolves blank docCodes to a unique target PI by
//      (supplierInvNo, docDate, [supplierCode]). Ambiguous fallbacks are
//      surfaced as unresolved rows so the audit fails incomplete rather
//      than silently balancing.
//
// Bearer tokens are never echoed and upstream error messages are sanitised.
// Accounts fetch in a 3-worker pool; pages within an account are serial.

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
import { canonicalDocCode } from "@/lib/report-keys";

const REPORTING_DEFAULT = "https://openapi-reporting.account.qne.cloud";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GL_PAGE_SIZE = 500;
const GL_WORKERS = 3;

interface PIDocumentIn extends AuditPIDocument {}

interface AuditRequest {
  dateFrom: string;
  dateTo: string;
  piDocuments: PIDocumentIn[];
}

interface Reply {
  ok: boolean;
  kind?: "auth" | "validation" | "n3" | "incomplete" | "network";
  error?: string;
  gl?: GLRow[];
  meta?: {
    piDocumentCount: number;
    accountsFetched: number;
    accountsFromApi: number;
    accountsFromSuppliers: number;
    accountsWithHits: number;
    accountsWithNoRows: string[];
    glRowsFetched: number;
    glRowsMatched: number;
    piDocSample: string[];
    unresolvedCount?: number;
    unresolvedRows?: UnresolvedRow[];
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
  else if (data && typeof data === "object" && Array.isArray((data as { value?: unknown[] }).value))
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

  // 1. Discover every active GL account for the period.
  const accountsRes = await fetchAccountRows(reportingBase, token, req);
  if (!accountsRes.ok)
    return jsonRes(502, {
      ok: false,
      kind: "incomplete",
      error: `Could not enumerate GL accounts: ${accountsRes.message}`,
    });

  // 2. Union with every target PI supplier code so control accounts always ship.
  const queries: AccountToQuery[] = unionAccountQueries(
    accountsRes.accounts,
    req.piDocuments,
  );
  const accountsFromSuppliers = queries.filter((q) => q.source === "target-supplier").length;

  // 3. Fetch every posting for every account in the union.
  const perAccount = await pool(queries, GL_WORKERS, (q) =>
    fetchGLForAccount(reportingBase, token, req, q.accountCode).then((r) => ({ q, r })),
  );

  const glMatched: GLRow[] = [];
  const emptyAccounts: string[] = [];
  const unresolved: UnresolvedRow[] = [];
  let accountsWithHits = 0;
  let glRowsFetched = 0;
  for (const { q, r } of perAccount) {
    if (!r.ok) {
      return jsonRes(502, {
        ok: false,
        kind: "incomplete",
        error: `Could not fetch GL rows for account ${q.accountCode}: ${r.message}`,
      });
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

  const piDocSample = [
    ...new Set(req.piDocuments.map((p) => canonicalDocCode(p.docCode)).filter(Boolean)),
  ].slice(0, 3);

  const baseMeta = {
    piDocumentCount: req.piDocuments.length,
    accountsFetched: queries.length,
    accountsFromApi: queries.length - accountsFromSuppliers,
    accountsFromSuppliers,
    accountsWithHits,
    accountsWithNoRows: emptyAccounts,
    glRowsFetched,
    glRowsMatched: glMatched.length,
    piDocSample,
  };

  if (unresolved.length > 0) {
    return jsonRes(200, {
      ok: false,
      kind: "incomplete",
      error: `Unable to uniquely resolve ${unresolved.length} General Ledger row${unresolved.length === 1 ? "" : "s"} to a target Purchase Invoice.`,
      meta: {
        ...baseMeta,
        unresolvedCount: unresolved.length,
        unresolvedRows: unresolved,
      },
    });
  }

  return jsonRes(200, {
    ok: true,
    gl: glMatched,
    meta: baseMeta,
  });
}

export const Route = createFileRoute("/api/reports/purchase-audit")({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
    },
  },
});
